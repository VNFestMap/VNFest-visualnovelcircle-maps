package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	"github.com/VNFestMap/galgame-community-map/backend/internal/jobs"
	"github.com/VNFestMap/galgame-community-map/backend/internal/store/sqlstore"
)

var supportedJobs = map[string]string{
	"recognition":        "recognition credential expiry and outbox",
	"spy":                "spy timeout progression and reaping",
	"settle-moe":         "moe contest settlement",
	"backfill-analytics": "historical analytics backfill",
	"migrate-images":     "image migration",
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: vnfest-worker <recognition|spy|settle-moe|backfill-analytics|migrate-images> [flags]")
		os.Exit(2)
	}
	jobName := os.Args[1]
	if _, ok := supportedJobs[jobName]; !ok {
		fmt.Fprintf(os.Stderr, "unsupported worker %q\n", jobName)
		os.Exit(2)
	}
	flags := flag.NewFlagSet(jobName, flag.ExitOnError)
	root := flags.String("root", os.Getenv("BACKEND_ROOT"), "project root")
	dryRun := flags.Bool("dry-run", false, "do not write business data")
	reap := flags.Bool("reap", false, "reap abandoned rooms where supported")
	verify := flags.Bool("verify", false, "verify external image URLs")
	resume := flags.Bool("resume", false, "resume from the previous manifest")
	rewrite := flags.Bool("rewrite", false, "rewrite approved image references after upload")
	includePublications := flags.Bool("include-publications", false, "include publication preview images")
	limit := flags.Int("limit", 0, "maximum number of uploads for one run")
	from := flags.String("from", "", "analytics start date YYYY-MM-DD")
	to := flags.String("to", "", "analytics end date YYYY-MM-DD")
	until := flags.String("until", "", "analytics exclusive end datetime")
	logPath := flags.String("log", "", "one historical access log to import")
	_ = flags.Parse(os.Args[2:])
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load(*root)
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}
	lock, err := jobs.Acquire(cfg.DataDir, jobName)
	if err != nil {
		if err == jobs.ErrAlreadyRunning {
			logger.Warn("worker already running", "job", jobName)
			os.Exit(75)
		}
		logger.Error("acquire worker lock", "error", err)
		os.Exit(1)
	}
	defer lock.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	db, err := sqlstore.Open(ctx, cfg)
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if jobName == "recognition" {
		report, runErr := jobs.RunRecognition(ctx, db, *dryRun)
		if runErr != nil {
			logger.Error("recognition worker failed", "error", runErr, "dry_run", *dryRun)
			if errors.Is(runErr, jobs.ErrSchemaUnavailable) {
				os.Exit(78)
			}
			os.Exit(1)
		}
		logger.Info("recognition worker completed", "expired", report.Expired, "outbox_processed", report.OutboxProcessed, "outbox_failed", report.OutboxFailed, "pending_before", report.Pending, "dry_run", report.DryRun)
		if report.OutboxFailed > 0 {
			os.Exit(1)
		}
		return
	}
	if jobName == "spy" {
		report, runErr := jobs.RunSpy(ctx, db, *dryRun, *reap)
		if runErr != nil {
			logger.Error("spy worker failed", "error", runErr, "dry_run", *dryRun, "reap", *reap)
			if errors.Is(runErr, jobs.ErrSchemaUnavailable) {
				os.Exit(78)
			}
			os.Exit(1)
		}
		logger.Info("spy worker completed", "advanced", report.Advanced, "idempotency_pruned", report.Pruned, "reaped", report.Reaped, "errors", len(report.Errors), "dry_run", report.DryRun)
		if len(report.Errors) > 0 {
			os.Exit(1)
		}
		return
	}
	if jobName == "settle-moe" {
		report, runErr := jobs.RunMoeSettlement(ctx, db, *dryRun)
		if runErr != nil {
			logger.Error("moe settlement failed", "error", runErr, "dry_run", *dryRun)
			if errors.Is(runErr, jobs.ErrSchemaUnavailable) {
				os.Exit(78)
			}
			os.Exit(1)
		}
		logger.Info("moe settlement completed", "checked", report.Checked, "due", report.Due, "settled", len(report.Settled), "reviewing", len(report.Reviewing), "errors", len(report.Errors), "dry_run", report.DryRun)
		if len(report.Errors) > 0 {
			os.Exit(1)
		}
		return
	}
	if jobName == "backfill-analytics" {
		var untilTime *time.Time
		if strings.TrimSpace(*until) != "" {
			parsed, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(*until))
			if parseErr != nil {
				logger.Error("invalid analytics until", "error", parseErr)
				os.Exit(2)
			}
			untilTime = &parsed
		}
		logs := []string{}
		if strings.TrimSpace(*logPath) != "" {
			logs = []string{strings.TrimSpace(*logPath)}
		}
		report, runErr := jobs.RunAnalyticsBackfill(ctx, db, cfg, jobs.AnalyticsBackfillOptions{From: *from, To: *to, Until: untilTime, Logs: logs, DryRun: *dryRun})
		if runErr != nil {
			logger.Error("analytics backfill failed", "error", runErr, "dry_run", *dryRun)
			if errors.Is(runErr, jobs.ErrSchemaUnavailable) {
				os.Exit(78)
			}
			os.Exit(1)
		}
		logger.Info("analytics backfill completed", "lines_read", report.LinesRead, "matched_page_requests", report.MatchedPageRequests, "aggregate_rows", report.AggregateRows, "skipped_lines", report.SkippedLines, "dry_run", report.DryRun)
		return
	}
	if jobName == "migrate-images" {
		report, runErr := jobs.RunImageMigration(ctx, db, cfg, jobs.ImageMigrationOptions{DryRun: *dryRun, Verify: *verify, Resume: *resume, Rewrite: *rewrite, IncludePublications: *includePublications, Limit: *limit})
		if runErr != nil {
			logger.Error("image migration failed", "error", runErr, "dry_run", *dryRun, "verify", *verify)
			if errors.Is(runErr, jobs.ErrSchemaUnavailable) {
				os.Exit(78)
			}
			os.Exit(1)
		}
		logger.Info("image migration completed", "discovered", report.Discovered, "checked", report.Checked, "uploaded", report.Uploaded, "skipped", report.Skipped, "failed", report.Failed, "verified", report.Verified, "verify_failed", report.VerifyFailed, "rewritten", report.Rewritten, "dry_run", report.DryRun, "verify", report.VerifyMode)
		if report.Failed > 0 || report.VerifyFailed > 0 {
			os.Exit(1)
		}
		return
	}
	// The command surface is installed before cron is changed. A worker may
	// not claim success until its domain handler has been ported and replayed.
	logger.Error("worker domain handler is not installed yet", "job", jobName, "description", supportedJobs[jobName], "dry_run", *dryRun, "reap", *reap)
	os.Exit(78)
}
