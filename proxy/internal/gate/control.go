package gate

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
)

type eviction struct {
	TenantID   string `json:"tenantId"`
	Slug       string `json:"slug"`
	GatewayKey string `json:"gatewayKey"`
}

func (d *Gate) ControlHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("POST /evict", d.evict)
	return mux
}

func (d *Gate) evict(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("x-proxy-control-token")
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(d.controlToken)) != 1 {
		writeMessage(w, http.StatusForbidden, "Invalid proxy control token.")
		return
	}

	var request eviction
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request); err != nil {
		writeMessage(w, http.StatusBadRequest, "Send {tenantId, slug} or {gatewayKey}.")
		return
	}
	byService := request.TenantID != "" && request.Slug != ""
	if !byService && request.GatewayKey == "" {
		writeMessage(w, http.StatusBadRequest, "Send {tenantId, slug} or {gatewayKey}.")
		return
	}

	if byService {
		d.callers.evictService(request.TenantID, request.Slug)
		d.webhooks.evictService(request.TenantID, request.Slug)
	}
	if request.GatewayKey != "" {
		d.callers.evictKey(request.GatewayKey)
	}
	w.WriteHeader(http.StatusNoContent)
}
