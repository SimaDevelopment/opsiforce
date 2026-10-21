package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Surface string

const (
	SurfaceAgent  Surface = "agent"
	SurfaceApp    Surface = "app"
	SurfaceVSCode Surface = "vscode"
	SurfaceDB     Surface = "db"
)

type EnsureResponse struct {
	State         string         `json:"state"`
	CanonicalHost string         `json:"canonicalHost"`
	Upstream      string         `json:"upstream"`
	PodName       string         `json:"podName"`
	Directory     string         `json:"directory"`
	Logging       *LoggingConfig `json:"logging"`
}

// LoggingConfig is the per-project request-logging policy resolved by the
// control plane. It is nil when the backend does not supply one (older
// backends or non-app surfaces), in which case the proxy falls back to its
// own defaults.
type LoggingConfig struct {
	Mode      string `json:"mode"`
	BodyLimit int    `json:"bodyLimit"`
}

type StatusError struct {
	StatusCode int
	Body       []byte
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("backend control plane returned status %d", e.StatusCode)
}

var ForwardedIdentityHeaders = []string{
	"x-forwarded-user",
	"x-forwarded-email",
	"x-forwarded-preferred-username",
	"x-forwarded-groups",
}

var ForwardedIdentityCacheHeaders = []string{
	"x-forwarded-user",
	"x-forwarded-groups",
}

const gatewayBearerPrefix = "Bearer gw-"

func GatewayBearer(headers http.Header) string {
	value := headers.Get("authorization")
	if strings.HasPrefix(value, gatewayBearerPrefix) {
		return value
	}
	return ""
}

func forwardIdentity(out http.Header, in http.Header) {
	for _, name := range ForwardedIdentityHeaders {
		if value := in.Get(name); value != "" {
			out.Set(name, value)
		}
	}
	if value := GatewayBearer(in); value != "" {
		out.Set("authorization", value)
	}
}

type Client struct {
	baseURL  string
	token    string
	client   *http.Client
	resolver *http.Client
}

func New(baseURL string, token string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		client: &http.Client{
			Timeout: timeout,
		},
		resolver: &http.Client{},
	}
}

type CallerResolution struct {
	ServedBy       string `json:"servedBy"`
	Upstream       string `json:"upstream"`
	CallerIdentity string `json:"callerIdentity"`
	TenantID       string `json:"tenantId"`
	ServiceID      string `json:"serviceId"`
	Slug           string `json:"slug"`
}

const ServedByBuiltIn = "built-in"

func (c *Client) ResolveCaller(ctx context.Context, credential string, slug string) (CallerResolution, error) {
	return c.resolve(ctx, "/api/internal/proxy/external-services/resolve", map[string]any{"credential": credential, "slug": slug})
}

func (c *Client) ResolveWebhook(ctx context.Context, service string, development bool) (CallerResolution, error) {
	return c.resolve(ctx, "/api/internal/proxy/external-services/resolve-webhook", map[string]any{"service": service, "development": development})
}

func (c *Client) resolve(ctx context.Context, path string, body map[string]any) (CallerResolution, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return CallerResolution{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return CallerResolution{}, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-proxy-control-token", c.token)

	resp, err := c.resolver.Do(req)
	if err != nil {
		return CallerResolution{}, err
	}
	defer resp.Body.Close()

	answer, err := io.ReadAll(resp.Body)
	if err != nil {
		return CallerResolution{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return CallerResolution{}, &StatusError{StatusCode: resp.StatusCode, Body: answer}
	}

	var resolution CallerResolution
	if err := json.Unmarshal(answer, &resolution); err != nil {
		return CallerResolution{}, err
	}
	return resolution, nil
}

func (c *Client) Ensure(ctx context.Context, projectID string, surface Surface, headers http.Header) (EnsureResponse, error) {
	payload, err := json.Marshal(map[string]string{
		"surface": string(surface),
	})
	if err != nil {
		return EnsureResponse{}, err
	}

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("%s/api/internal/proxy/projects/%s/ensure", c.baseURL, projectID),
		bytes.NewReader(payload),
	)
	if err != nil {
		return EnsureResponse{}, err
	}

	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-proxy-control-token", c.token)
	forwardIdentity(req.Header, headers)

	resp, err := c.client.Do(req)
	if err != nil {
		return EnsureResponse{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return EnsureResponse{}, err
	}

	if resp.StatusCode >= 400 {
		return EnsureResponse{}, &StatusError{StatusCode: resp.StatusCode, Body: body}
	}

	var decoded EnsureResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return EnsureResponse{}, err
	}

	return decoded, nil
}

func (c *Client) postControl(ctx context.Context, path string, payload []byte) ([]byte, error) {
	requestBody := io.Reader(http.NoBody)
	if payload != nil {
		requestBody = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, requestBody)
	if err != nil {
		return nil, err
	}

	req.Header.Set("x-proxy-control-token", c.token)
	if payload != nil {
		req.Header.Set("content-type", "application/json")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		return nil, &StatusError{StatusCode: resp.StatusCode, Body: body}
	}

	return body, nil
}

func (c *Client) ReportFailure(ctx context.Context, projectID string) (bool, error) {
	body, err := c.postControl(ctx, fmt.Sprintf("/api/internal/proxy/projects/%s/failure", projectID), nil)
	if err != nil {
		return false, err
	}

	var decoded struct {
		Restart bool `json:"restart"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return false, err
	}

	return decoded.Restart, nil
}

// TouchActivity refreshes the idle-timeout the given surface feeds, exactly as
// an Ensure call for that surface would.
func (c *Client) TouchActivity(ctx context.Context, environmentID string, surface Surface) error {
	payload, err := json.Marshal(map[string]string{
		"surface": string(surface),
	})
	if err != nil {
		return err
	}

	_, err = c.postControl(ctx, fmt.Sprintf("/api/internal/proxy/projects/%s/activity", environmentID), payload)
	return err
}
