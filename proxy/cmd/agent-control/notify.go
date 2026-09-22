package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

var notifyTargets = map[string]string{
	"config": "",
	"agents": "agents",
	"skills": "skills",
}

var opencodeDir = "/workspace/.opencode"

type notifyRequest struct {
	Targets []string `json:"targets"`
}

type notifyResponse struct {
	Notified []string          `json:"notified"`
	Absent   []string          `json:"absent"`
	Failed   map[string]string `json:"failed,omitempty"`
}

func handleNotifyConfigChange(w http.ResponseWriter, r *http.Request) {
	var body notifyRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	result := notifyConfigChange(body.Targets)
	if len(result.Failed) > 0 {
		writeJSON(w, http.StatusInternalServerError, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func notifyConfigChange(targets []string) notifyResponse {
	result := notifyResponse{Notified: []string{}, Absent: []string{}}
	for _, target := range targets {
		relative, known := notifyTargets[target]
		if !known {
			result.setFailure(target, "unknown target")
			continue
		}
		directory := filepath.Join(opencodeDir, relative)
		if _, err := os.Stat(directory); err != nil {
			result.Absent = append(result.Absent, target)
			continue
		}
		if err := touchMarker(directory); err != nil {
			result.setFailure(target, err.Error())
			continue
		}
		result.Notified = append(result.Notified, target)
	}
	return result
}

func (r *notifyResponse) setFailure(target string, reason string) {
	if r.Failed == nil {
		r.Failed = map[string]string{}
	}
	r.Failed[target] = reason
}

func touchMarker(directory string) error {
	name, err := markerName()
	if err != nil {
		return err
	}
	marker := filepath.Join(directory, name)
	if err := os.WriteFile(marker, nil, 0o600); err != nil {
		return err
	}
	return os.Remove(marker)
}

func markerName() (string, error) {
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return "", err
	}
	return ".notify-" + hex.EncodeToString(suffix), nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
