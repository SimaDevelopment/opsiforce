package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/config"
	"opsiforce/proxy/internal/gate"
	"opsiforce/proxy/internal/requestlog"
	"opsiforce/proxy/internal/server"
)

func main() {
	modeFlag := flag.String("mode", "", "proxy mode: agent|app|vscode|db|external-service")
	portFlag := flag.Int("port", 0, "listen port")
	flag.Parse()

	cfg, err := config.Load(*modeFlag, *portFlag)
	if err != nil {
		slog.Error("failed to load config", "error", err.Error())
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	controlClient := backend.New(cfg.BackendURL, cfg.ProxyControlToken, cfg.ControlPlaneTimeout)

	if cfg.Mode == config.ModeExternalService {
		serveGate(ctx, cfg, controlClient)
		return
	}

	var requestLogger *requestlog.Logger
	if cfg.Mode == config.ModeApp {
		requestLogger = requestlog.New(cfg.StorageMountPath, cfg.RequestLogQueueDepth)
	}

	handler := server.New(cfg, controlClient, requestLogger)

	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           server.WrapCompressed(handler, server.CompressionOptions{MinSize: cfg.CompressionMinBytes}),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		<-ctx.Done()

		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("graceful shutdown failed", "error", err.Error())
		}

		if err := handler.Close(shutdownCtx); err != nil {
			slog.Error("proxy cleanup failed", "error", err.Error())
		}
	}()

	slog.Info("starting proxy", "mode", cfg.Mode, "port", cfg.Port)

	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("proxy stopped with error", "error", err.Error())
		os.Exit(1)
	}
}

func serveGate(ctx context.Context, cfg config.Config, controlClient *backend.Client) {
	serviceGate := gate.New(cfg, controlClient)
	defer serviceGate.Close()

	servers := []*http.Server{
		{
			Addr:                         fmt.Sprintf(":%d", cfg.Port),
			Handler:                      serviceGate,
			ReadHeaderTimeout:            15 * time.Second,
			IdleTimeout:                  2 * time.Minute,
			DisableGeneralOptionsHandler: true,
		},
		{
			Addr:                         fmt.Sprintf(":%d", cfg.WebhookPort),
			Handler:                      serviceGate.WebhookHandler(),
			ReadHeaderTimeout:            15 * time.Second,
			IdleTimeout:                  2 * time.Minute,
			DisableGeneralOptionsHandler: true,
		},
		{
			Addr:              fmt.Sprintf(":%d", cfg.ControlPort),
			Handler:           serviceGate.ControlHandler(),
			ReadHeaderTimeout: 15 * time.Second,
		},
	}

	failed := make(chan error, len(servers))
	for _, srv := range servers {
		go func() {
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				failed <- err
			}
		}()
	}
	slog.Info("starting proxy", "mode", cfg.Mode, "port", cfg.Port, "webhookPort", cfg.WebhookPort, "controlPort", cfg.ControlPort)

	exitCode := 0
	select {
	case <-ctx.Done():
	case err := <-failed:
		slog.Error("proxy stopped with error", "error", err.Error())
		exitCode = 1
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, srv := range servers {
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("graceful shutdown failed", "error", err.Error())
		}
	}
	if exitCode != 0 {
		os.Exit(exitCode)
	}
}
