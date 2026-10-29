package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"opsiforce/proxy/internal/desktop"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	m := desktop.New()
	defer m.Close()
	if _, err := m.Start(ctx); err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: "127.0.0.1:6080", Handler: m.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = srv.Close()
				return
			case <-ticker.C:
				if !m.Healthy() {
					log.Println("X11 process exited; restarting desktop manager")
					_ = srv.Close()
					return
				}
			}
		}
	}()
	log.Println("desktop manager ready on 127.0.0.1:6080; DISPLAY=:99")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print(err)
	}
}
