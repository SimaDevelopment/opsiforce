package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const gatewayKey = "gw-test-key"

type fakeGateway struct {
	mu      sync.Mutex
	answers []string
	asked   int
}

func startFakeGateway(t *testing.T, answers ...string) (*fakeGateway, string) {
	t.Helper()
	gateway := &fakeGateway{answers: answers}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/gateway/app/public-url" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+gatewayKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(gateway.next()))
	}))
	t.Cleanup(server.Close)
	return gateway, server.URL + "/api/gateway"
}

func (g *fakeGateway) next() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	answer := g.answers[min(g.asked, len(g.answers)-1)]
	g.asked++
	return answer
}

func (g *fakeGateway) timesAsked() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.asked
}

func withAppURLTiming(t *testing.T, interval, limit time.Duration) {
	t.Helper()
	previousInterval, previousLimit := appURLPollInterval, appURLWaitLimit
	appURLPollInterval, appURLWaitLimit = interval, limit
	t.Cleanup(func() { appURLPollInterval, appURLWaitLimit = previousInterval, previousLimit })
}

func runAppURLAgainst(gatewayURL string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runAppURL(gatewayURL, gatewayKey, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

const notLive = `{"publicUrl":null,"servesAnExternalService":false}`

func TestAppURLPrintsTheLinkOnceTheGatewayKnowsIt(t *testing.T) {
	withAppURLTiming(t, time.Millisecond, time.Second)
	_, gatewayURL := startFakeGateway(t,
		`{"publicUrl":"https://fleet-dev-1a2b3c4d5e6f.apps.example.com/","servesAnExternalService":false}`)

	code, stdout, stderr := runAppURLAgainst(gatewayURL)

	if code != 0 || stdout != "https://fleet-dev-1a2b3c4d5e6f.apps.example.com/\n" || stderr != "" {
		t.Fatalf("got exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

func TestAppURLWaitsThroughAnswersWithoutALink(t *testing.T) {
	withAppURLTiming(t, time.Millisecond, time.Second)
	gateway, gatewayURL := startFakeGateway(t, notLive, notLive, notLive,
		`{"publicUrl":"https://fleet-dev-1a2b3c4d5e6f.apps.example.com/","servesAnExternalService":false}`)

	code, stdout, _ := runAppURLAgainst(gatewayURL)

	if code != 0 || stdout != "https://fleet-dev-1a2b3c4d5e6f.apps.example.com/\n" {
		t.Fatalf("got exit %d, stdout %q", code, stdout)
	}
	if gateway.timesAsked() != 4 {
		t.Fatalf("asked the gateway %d times, want 4", gateway.timesAsked())
	}
}

func TestAppURLGivesUpWhenTheAppNeverGoesLive(t *testing.T) {
	withAppURLTiming(t, 5*time.Millisecond, 50*time.Millisecond)
	_, gatewayURL := startFakeGateway(t, notLive)

	code, stdout, stderr := runAppURLAgainst(gatewayURL)

	want := "The App isn't live yet — start it so it answers on APP_PORT, then run app-url again\n"
	if code == 0 || stdout != "" || stderr != want {
		t.Fatalf("got exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

func TestAppURLRefusesForAProjectServingAnExternalService(t *testing.T) {
	withAppURLTiming(t, time.Millisecond, time.Second)
	gateway, gatewayURL := startFakeGateway(t, `{"publicUrl":null,"servesAnExternalService":true}`)

	code, stdout, stderr := runAppURLAgainst(gatewayURL)

	want := "This Project serves an External Service and has no public App\n"
	if code == 0 || stdout != "" || stderr != want {
		t.Fatalf("got exit %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if gateway.timesAsked() != 1 {
		t.Fatalf("asked the gateway %d times, want 1", gateway.timesAsked())
	}
}

func TestAppURLBlamesThePlatformWhenTheGatewayNeverAnswers(t *testing.T) {
	_, gatewayURL := startFakeGateway(t, notLive)
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(failing.Close)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()

	for name, url := range map[string]string{
		"a backend without the route": gatewayURL + "/elsewhere",
		"a failing backend":           failing.URL,
		"an unreachable gateway":      gone.URL,
	} {
		t.Run(name, func(t *testing.T) {
			withAppURLTiming(t, 5*time.Millisecond, 30*time.Millisecond)

			code, stdout, stderr := runAppURLAgainst(url)

			want := "Couldn't reach the platform to look up the App's address\n"
			if code != 3 || stdout != "" || stderr != want {
				t.Fatalf("got exit %d, stdout %q, stderr %q", code, stdout, stderr)
			}
		})
	}
}

func TestAppURLSaysTheAppIsNotLiveOnceThePlatformAnsweredEvenIfItLaterFails(t *testing.T) {
	withAppURLTiming(t, 5*time.Millisecond, 50*time.Millisecond)
	var answered atomic.Bool
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if answered.Swap(true) {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(notLive))
	}))
	t.Cleanup(gateway.Close)

	code, _, stderr := runAppURLAgainst(gateway.URL)

	want := "The App isn't live yet — start it so it answers on APP_PORT, then run app-url again\n"
	if code != 1 || stderr != want {
		t.Fatalf("got exit %d, stderr %q", code, stderr)
	}
}
