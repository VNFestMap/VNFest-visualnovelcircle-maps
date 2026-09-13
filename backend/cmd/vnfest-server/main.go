package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/httpapi"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sessionstore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	root := os.Getenv("BACKEND_ROOT")
	cfg, err := config.Load(root)
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}
	if err := cfg.ValidateProduction(); err != nil {
		logger.Error("production configuration check failed", "error", err)
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := sqlstore.Open(ctx, cfg)
	if err != nil {
		logger.Error("open database", "error", err, "driver", cfg.DBDriver)
		os.Exit(1)
	}
	defer db.Close()
	if err := sqlstore.Verify(ctx, db); err != nil {
		logger.Error("database migration verification failed; refusing to start HTTP service", "error", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Clean(cfg.DataDir), 0o755); err != nil {
		logger.Error("create data directory", "error", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Clean(cfg.UploadDir), 0o755); err != nil {
		logger.Error("create upload directory", "error", err)
		os.Exit(1)
	}
	files := filestore.New(cfg.DataDir, cfg.UploadDir)
	sessions := &sessionstore.Manager{Store: sessionstore.New(db), CookieName: "PHPSESSID", CookieDomain: cfg.SessionCookieDomain, Secure: cfg.SessionCookieSecure, Lifetime: time.Duration(cfg.SessionLifetime) * time.Second}
	server, err := httpapi.New(cfg, db, files, sessions)
	if err != nil {
		logger.Error("build HTTP server", "error", err)
		os.Exit(1)
	}
	httpServer := &http.Server{Addr: cfg.AppAddr, Handler: server, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 120 * time.Second}
	go func() {
		logger.Info("vnfest Go server started", "addr", cfg.AppAddr, "legacy_proxy", cfg.LegacyPHPUpstream != "")
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server stopped", "error", err)
			os.Exit(1)
		}
	}()

	stop, stopCancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopCancel()
	<-stop.Done()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown", "error", err)
		os.Exit(1)
	}
	logger.Info("vnfest Go server stopped")
}
