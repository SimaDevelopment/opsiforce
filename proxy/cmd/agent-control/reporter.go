package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

const (
	watchDir            = "/workspace/app"
	metaFileName        = "app.meta.json"
	defaultAppPort      = "3000"
	probeTimeout        = 3 * time.Second
	pushTimeout         = 5 * time.Second
	fastProbeInterval   = 2 * time.Second
	steadyProbeInterval = 15 * time.Second
	pushAttempts        = 4
	pushBackoff         = 1500 * time.Millisecond
	downStrikeThreshold = 2
)

type appState struct {
	Serving     bool    `json:"serving"`
	Live        bool    `json:"live"`
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

func (s appState) positive() bool {
	return s.Serving || s.Live
}

func (s appState) equal(other appState) bool {
	return s.Serving == other.Serving &&
		s.Live == other.Live &&
		ptrEqual(s.Name, other.Name) &&
		ptrEqual(s.Description, other.Description)
}

func ptrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func runReporter() {
	key := os.Getenv("SERVICE_GATEWAY_API_KEY")
	base := os.Getenv("SERVICE_GATEWAY_URL")
	if key == "" || base == "" {
		log.Println("app-reporter: SERVICE_GATEWAY_API_KEY/URL not set; app readiness reporting disabled")
		return
	}

	appPort := os.Getenv("APP_PORT")
	if appPort == "" {
		appPort = defaultAppPort
	}

	probeURL := "http://127.0.0.1:" + appPort + "/"
	pushURL := strings.TrimRight(base, "/") + "/app/state"

	probeClient := &http.Client{Timeout: probeTimeout}
	pushClient := &http.Client{Timeout: pushTimeout}

	nudge := make(chan struct{}, 1)
	go watchMeta(nudge)

	var (
		last        appState
		serving     bool
		downStrikes int
		hasPushed   bool
	)

	ticker := time.NewTicker(fastProbeInterval)
	defer ticker.Stop()

	evaluate := func() {
		current := probeApp(probeClient, probeURL, watchDir)

		if !current.Serving && last.positive() {
			downStrikes++
			if downStrikes < downStrikeThreshold {
				return
			}
		} else {
			downStrikes = 0
		}

		if current.Serving != serving {
			serving = current.Serving
			if serving {
				ticker.Reset(steadyProbeInterval)
			} else {
				ticker.Reset(fastProbeInterval)
			}
		}

		changed := !current.equal(last)
		if hasPushed && !changed {
			return
		}

		if !pushState(pushClient, pushURL, key, current) {
			return
		}

		hasPushed = true
		last = current
	}

	evaluate()

	for {
		select {
		case <-ticker.C:
			evaluate()
		case <-nudge:
			evaluate()
		}
	}
}

func probeApp(client *http.Client, url, appDir string) appState {
	if !respondsOnPort(client, url) {
		return appState{}
	}

	state := appState{Serving: true}

	meta, found := readAppMeta(appDir)
	if !found {
		return state
	}

	state.Live = true
	state.Name = meta.Name
	state.Description = meta.Description
	return state
}

func respondsOnPort(client *http.Client, url string) bool {
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

type appMeta struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

func readAppMeta(appDir string) (appMeta, bool) {
	content, err := os.ReadFile(filepath.Join(appDir, metaFileName))
	if err != nil {
		return appMeta{}, false
	}

	var meta appMeta
	if err := json.Unmarshal(content, &meta); err != nil {
		log.Printf("app-reporter: %s is not valid JSON: %v", metaFileName, err)
		return appMeta{}, false
	}
	return meta, true
}

func pushState(client *http.Client, url, key string, state appState) bool {
	payload, err := json.Marshal(state)
	if err != nil {
		log.Printf("app-reporter: marshal state failed: %v", err)
		return false
	}
	return pushJSON(client, url, key, "app-reporter", payload)
}

func watchMeta(nudge chan<- struct{}) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("app-reporter: watcher init failed: %v", err)
		return
	}
	defer watcher.Close()

	if err := watcher.Add(watchDir); err != nil {
		log.Printf("app-reporter: watching %s failed: %v", watchDir, err)
		return
	}

	const relevant = fsnotify.Create | fsnotify.Write | fsnotify.Rename
	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			if filepath.Base(event.Name) != metaFileName {
				continue
			}
			if event.Op&relevant != 0 {
				select {
				case nudge <- struct{}{}:
				default:
				}
			}
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Printf("app-reporter: watch error: %v", err)
		}
	}
}
