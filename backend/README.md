# VNFmap Go backend

`backend/` is the Go implementation boundary for the PHP-to-Go migration. The
HTTP server keeps the existing public URLs, including `/api/*.php`, so browser
code does not need an API URL change. It also keeps the `PHPSESSID` cookie name
and reads/writes the shared session tables used by the bridge release.

## Components

- `vnfest-server`: static pages/assets, API compatibility routes, OAuth
  callbacks, uploads, health checks, and the optional isolated PHP upstream
  used only for rehearsal/unknown-path rollback.
- `vnfest-migrate`: additive, versioned database migrations and non-sensitive
  schema/data/file snapshots. The server refuses to start until `--verify`
  succeeds; it never changes the database automatically.
- `vnfest-worker`: single-instance, repeatable replacements for recognition,
  Spy, Moe settlement, analytics backfill, and PicUI image migration.

The route table explicitly registers all 87 existing root API paths, the
archived Forum endpoint, and `club-operation-portrait/api/index.php`. Unknown
`/api/` paths return a controlled 404 when no rehearsal upstream is configured;
they are never reported as a fake success.

## Local commands

From this directory:

```text
go test -mod=mod ./... -count=1 -timeout=120s
go vet ./...
go run ./cmd/vnfest-migrate --dry-run
go run ./cmd/vnfest-migrate --snapshot
go run ./cmd/vnfest-migrate --apply
go run ./cmd/vnfest-migrate --verify
go run ./cmd/vnfest-migrate --config-check
go run ./cmd/vnfest-server
```

The project uses SQLite with a pure-Go driver for local development and
MySQL with the production driver. Migration files under `backend/migrations/`
are reference SQL; the Go migrator is authoritative and applies only additive
changes. Existing application tables and rows are not dropped or rewritten by
the baseline migration.

## Worker commands

```text
vnfest-worker recognition
vnfest-worker spy
vnfest-worker spy --reap
vnfest-worker spy --reap --dry-run
vnfest-worker settle-moe
vnfest-worker backfill-analytics --from=YYYY-MM-DD --to=YYYY-MM-DD
vnfest-worker migrate-images --dry-run
vnfest-worker migrate-images --resume --limit=100
vnfest-worker migrate-images --resume --rewrite
vnfest-worker migrate-images --verify
```

Workers use a lock under `DATA_DIR`, bounded execution contexts, structured
logs, idempotent writes, and non-zero exit codes for failed work. Image
migration keeps every local file, writes an upload manifest, verifies trusted
remote URLs, backs up changed JSON/database references, and rewrites only the
allowlisted image columns.

## Configuration and deployment state

Use the repository-root `.env.example` as the one-by-one mapping checklist for
the former `config.php`. Secrets are process environment values only; neither
the server nor the migration snapshot prints them. Production must set
`DB_DRIVER=mysql`, the real `SITE_URL`, session secret/cookie settings, and the
enabled external-service credentials before the cutover rehearsal.
Set `APP_ENV=production` to make the server enforce that checklist; use
`vnfest-migrate --config-check` for a read-only preflight.

The repository Dockerfile now builds a Go multi-stage image whose runtime has
no PHP, Apache, Composer, `vendor/`, or PHP source. The old PHP image must be
retained separately as a versioned rollback artifact throughout the release
window. `LEGACY_PHP_UPSTREAM` is optional and is intended for an isolated
rehearsal or emergency upstream switch, not for normal Go request handling.

The Go container is not a production cutover by itself. Before changing the
Nginx upstream, complete the runbook's database/file/session snapshots, PHP
versus Go response replay, browser regression, external fake-service tests,
worker replay, and rollback rehearsal. Until those gates are signed off, do
not delete the PHP deployment, volumes, backups, or bridge-compatible PHP
image.
