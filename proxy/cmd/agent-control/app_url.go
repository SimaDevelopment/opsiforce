package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	appURLCommand          = "app-url"
	appURLRequestTimeout   = 5 * time.Second
	appNotLiveMessage      = "The App isn't live yet — start it so it answers on APP_PORT, then run app-url again"
	externalServiceMessage = "This Project serves an External Service and has no public App"
	gatewayMissingMessage  = "SERVICE_GATEWAY_URL and SERVICE_GATEWAY_API_KEY must be set"
	platformSilentMessage  = "Couldn't reach the platform to look up the App's address"
)

var (
	appURLPollInterval = time.Second
	appURLWaitLimit    = 30 * time.Second
)

type appPublicURLAnswer struct {
	PublicURL               *string `json:"publicUrl"`
	ServesAnExternalService bool    `json:"servesAnExternalService"`
}

func runAppURL(gatewayURL, key string, stdout, stderr io.Writer) int {
	if gatewayURL == "" || key == "" {
		fmt.Fprintln(stderr, gatewayMissingMessage)
		return 2
	}

	endpoint := strings.TrimRight(gatewayURL, "/") + "/app/public-url"
	client := &http.Client{Timeout: appURLRequestTimeout}
	deadline := time.Now().Add(appURLWaitLimit)
	platformAnswered := false

	for {
		answer, ok := askPublicURL(client, endpoint, key)
		platformAnswered = platformAnswered || ok
		switch {
		case ok && answer.ServesAnExternalService:
			fmt.Fprintln(stderr, externalServiceMessage)
			return 1
		case ok && answer.PublicURL != nil:
			fmt.Fprintln(stdout, *answer.PublicURL)
			return 0
		}
		if time.Now().Add(appURLPollInterval).After(deadline) {
			return giveUp(stderr, platformAnswered)
		}
		time.Sleep(appURLPollInterval)
	}
}

func giveUp(stderr io.Writer, platformAnswered bool) int {
	if !platformAnswered {
		fmt.Fprintln(stderr, platformSilentMessage)
		return 3
	}
	fmt.Fprintln(stderr, appNotLiveMessage)
	return 1
}

func askPublicURL(client *http.Client, endpoint, key string) (appPublicURLAnswer, bool) {
	var answer appPublicURLAnswer
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return answer, false
	}
	req.Header.Set("Authorization", "Bearer "+key)

	resp, err := client.Do(req)
	if err != nil {
		return answer, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return answer, false
	}
	return answer, json.NewDecoder(resp.Body).Decode(&answer) == nil
}
