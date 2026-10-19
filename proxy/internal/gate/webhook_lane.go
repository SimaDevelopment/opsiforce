package gate

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"

	"opsiforce/proxy/internal/backend"
)

const (
	webhookAddressPrefix = "/api/external-services/webhooks/"
	webhookHandlerPath   = "/.well-known/opsiforce/webhook"
	developmentSegment   = "development"
	webhookSecretHeader  = "X-Opsiforce-Webhook-Secret"
)

var webhookServicePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

type webhookAddress struct {
	service     string
	development bool
	rest        string
}

type forwardedWebhook struct {
	resolution backend.CallerResolution
	upstream   *url.URL
	target     string
	address    webhookAddress
}

type forwardedWebhookKey struct{}

func (a webhookAddress) target() string {
	if a.development {
		return a.service + "/" + developmentSegment
	}
	return a.service
}

func webhookAddressOf(escapedPath string) (webhookAddress, bool) {
	below, found := strings.CutPrefix(escapedPath, webhookAddressPrefix)
	if !found {
		return webhookAddress{}, false
	}
	service, rest, _ := strings.Cut(below, "/")
	if !webhookServicePattern.MatchString(service) {
		return webhookAddress{}, false
	}
	address := webhookAddress{service: service}
	if rest != "" {
		rest = "/" + rest
	} else if strings.HasSuffix(below, "/") {
		rest = "/"
	}
	if rest == "/"+developmentSegment || strings.HasPrefix(rest, "/"+developmentSegment+"/") {
		address.development = true
		rest = strings.TrimPrefix(rest, "/"+developmentSegment)
	}
	address.rest = rest
	return address, true
}

func resolveWebhookTarget(platform *backend.Client) resolveFunc {
	return func(ctx context.Context, _ string, target string) (backend.CallerResolution, error) {
		service, development := strings.CutSuffix(target, "/"+developmentSegment)
		return platform.ResolveWebhook(ctx, service, development)
	}
}

func (d *Gate) WebhookHandler() http.Handler {
	return http.HandlerFunc(d.serveWebhook)
}

func (d *Gate) serveWebhook(w http.ResponseWriter, r *http.Request) {
	address, ok := webhookAddressOf(r.URL.EscapedPath())
	if !ok {
		writeSandboxedMessage(w, http.StatusNotFound, "There is no External Service at this Webhook address.")
		return
	}

	resolution, err := d.webhooks.caller(r.Context(), presentedKey{}, address.target())
	if err != nil {
		d.refuseWebhook(w, r, address, err)
		return
	}

	upstream, err := d.upstreamOf(resolution)
	if err != nil {
		slog.Error("webhook resolved to an unusable upstream", "service", address.service, "upstream", resolution.Upstream)
		writeSandboxedMessage(w, http.StatusBadGateway, "The External Service could not be reached.")
		return
	}

	call := forwardedWebhook{resolution: resolution, upstream: upstream, target: address.target(), address: address}
	d.webhookProxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), forwardedWebhookKey{}, call)))
}

func (d *Gate) refuseWebhook(w http.ResponseWriter, r *http.Request, address webhookAddress, err error) {
	if r.Context().Err() != nil {
		return
	}
	var refused *backend.StatusError
	if errors.As(err, &refused) {
		switch refused.StatusCode {
		case http.StatusNotFound, http.StatusBadGateway, http.StatusGatewayTimeout:
			writeSandboxedMessage(w, refused.StatusCode, firstNonEmpty(messageIn(refused.Body), http.StatusText(refused.StatusCode)))
			return
		}
		slog.Error("webhook resolve refused unexpectedly", "service", address.service, "status", refused.StatusCode)
	} else if errors.Is(err, context.DeadlineExceeded) {
		writeSandboxedMessage(w, http.StatusGatewayTimeout, "The External Service did not start in time; retry shortly.")
		return
	} else {
		slog.Error("webhook resolve failed", "service", address.service, "error", err.Error())
	}
	writeSandboxedMessage(w, http.StatusBadGateway, "The platform could not resolve this webhook; retry shortly.")
}

func (d *Gate) rewriteWebhook(pr *httputil.ProxyRequest) {
	call := pr.In.Context().Value(forwardedWebhookKey{}).(forwardedWebhook)

	pr.Out.URL.Scheme = call.upstream.Scheme
	pr.Out.URL.Host = call.upstream.Host
	pr.Out.Host = pr.In.Host
	forwardOriginalAddress(pr.Out.Header, pr.In)

	pr.Out.Header.Del("Cookie")
	for name := range pr.Out.Header {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) && name != webhookSecretHeader {
			delete(pr.Out.Header, name)
		}
	}
	pr.Out.URL.Path, pr.Out.URL.RawPath = belowUpstream(call.upstream, webhookHandlerPath+call.address.rest)
	pr.Out.Header.Set(callerIdentityHeader, call.resolution.CallerIdentity)
}

func sandboxAnswer(resp *http.Response) error {
	sandbox(resp.Header)
	return nil
}

func (d *Gate) unreachableWebhook(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return
	}
	call := r.Context().Value(forwardedWebhookKey{}).(forwardedWebhook)
	d.webhooks.forget(callerAddress{slug: call.target})
	slog.Warn("webhook target unreachable", "service", call.address.service, "error", err.Error())
	writeSandboxedMessage(w, http.StatusBadGateway, fmt.Sprintf("%s could not be reached.", firstNonEmpty(call.resolution.Slug, "The External Service")))
}

func sandbox(header http.Header) {
	header.Set("Content-Security-Policy", "sandbox")
	header.Set("X-Content-Type-Options", "nosniff")
}

func writeSandboxedMessage(w http.ResponseWriter, status int, message string) {
	sandbox(w.Header())
	writeMessage(w, status, message)
}
