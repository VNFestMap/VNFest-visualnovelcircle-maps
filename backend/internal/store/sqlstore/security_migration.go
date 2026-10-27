package sqlstore

import (
	"context"
	"database/sql"
)

func securityMigration(db *DB) Migration {
	return Migration{Version: 22, Name: "security codes and project file ownership", Apply: func(ctx context.Context, tx *sql.Tx) error {
		for _, query := range []string{
			`CREATE TABLE IF NOT EXISTS security_email_codes (id VARCHAR(64) PRIMARY KEY, purpose VARCHAR(32) NOT NULL, email VARCHAR(255) NOT NULL, user_id BIGINT NOT NULL DEFAULT 0, salt VARCHAR(64) NOT NULL, code_hash VARCHAR(64) NOT NULL, expires_at BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS security_send_budgets (bucket_key VARCHAR(96) PRIMARY KEY, started_at BIGINT NOT NULL, request_count INTEGER NOT NULL)`,
			`CREATE TABLE IF NOT EXISTS project_file_records (id VARCHAR(64) PRIMARY KEY, path_hash VARCHAR(64) NOT NULL UNIQUE, storage_path TEXT NOT NULL, project_id BIGINT NOT NULL DEFAULT 0, uploader_id BIGINT NOT NULL DEFAULT 0, purpose VARCHAR(32) NOT NULL DEFAULT 'private', original_name TEXT NOT NULL, mime_type VARCHAR(128) NOT NULL, size_bytes BIGINT NOT NULL, created_at BIGINT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
		} {
			if _, err := tx.ExecContext(ctx, query); err != nil {
				return err
			}
		}
		return nil
	}}
}
