package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/filestore"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

func main() {
	var root string
	var dryRun, apply, verify, snapshot, configCheck bool
	flag.StringVar(&root, "root", os.Getenv("BACKEND_ROOT"), "project root")
	flag.BoolVar(&dryRun, "dry-run", false, "show pending migrations without changing the database")
	flag.BoolVar(&apply, "apply", false, "apply pending migrations")
	flag.BoolVar(&verify, "verify", false, "verify the migration baseline and session bridge")
	flag.BoolVar(&snapshot, "snapshot", false, "write a non-sensitive schema and row-count snapshot")
	flag.BoolVar(&configCheck, "config-check", false, "validate production configuration without changing state")
	flag.Parse()
	if boolCount(dryRun, apply, verify, snapshot, configCheck) != 1 {
		fmt.Fprintln(os.Stderr, "choose exactly one of --dry-run, --apply, --verify, --snapshot, or --config-check")
		os.Exit(2)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := config.Load(root)
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}
	if configCheck {
		if err := cfg.ValidateProduction(); err != nil {
			logger.Error("configuration check failed", "error", err)
			os.Exit(1)
		}
		fmt.Println("configuration check passed")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, err := sqlstore.Open(ctx, cfg)
	if err != nil {
		logger.Error("open database", "error", err, "driver", cfg.DBDriver)
		os.Exit(1)
	}
	defer db.Close()

	switch {
	case dryRun:
		pending, err := sqlstore.Pending(ctx, db)
		if err != nil {
			logger.Error("inspect pending migrations", "error", err)
			os.Exit(1)
		}
		for _, migration := range pending {
			fmt.Printf("pending %04d %s\n", migration.Version, migration.Name)
		}
		if len(pending) == 0 {
			fmt.Println("no pending migrations")
		}
	case apply:
		if err := sqlstore.Apply(ctx, db, os.Stdout); err != nil {
			logger.Error("apply migrations", "error", err)
			os.Exit(1)
		}
	case verify:
		if err := sqlstore.Verify(ctx, db); err != nil {
			logger.Error("verify migrations", "error", err)
			os.Exit(1)
		}
		fmt.Println("migration verification passed")
	case snapshot:
		var database bytes.Buffer
		if err := sqlstore.WriteSnapshot(ctx, db, &database); err != nil {
			logger.Error("write snapshot", "error", err)
			os.Exit(1)
		}
		var databaseSnapshot json.RawMessage
		if err := json.Unmarshal(database.Bytes(), &databaseSnapshot); err != nil {
			logger.Error("decode database snapshot", "error", err)
			os.Exit(1)
		}
		dataFiles, err := filestore.Inventory(ctx, cfg.DataDir)
		if err != nil {
			logger.Error("inventory data files", "error", err)
			os.Exit(1)
		}
		uploadFiles, err := filestore.Inventory(ctx, cfg.UploadDir)
		if err != nil {
			logger.Error("inventory upload files", "error", err)
			os.Exit(1)
		}
		wikiUploadFiles, err := filestore.Inventory(ctx, cfg.WikiUploadDir)
		if err != nil {
			logger.Error("inventory wiki upload files", "error", err)
			os.Exit(1)
		}
		report := struct {
			Database    json.RawMessage       `json:"database"`
			DataFiles   []filestore.FileEntry `json:"data_files"`
			UploadFiles []filestore.FileEntry `json:"upload_files"`
			WikiUploads []filestore.FileEntry `json:"wiki_upload_files"`
		}{databaseSnapshot, dataFiles, uploadFiles, wikiUploadFiles}
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(report); err != nil {
			logger.Error("write full snapshot", "error", err)
			os.Exit(1)
		}
	}
}

func boolCount(values ...bool) int {
	count := 0
	for _, value := range values {
		if value {
			count++
		}
	}
	return count
}
