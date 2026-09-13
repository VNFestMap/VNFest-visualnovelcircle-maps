package sqlstore

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/VNFestMap/galgame-community-map/backend/internal/config"
	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
	Driver string
}

func Open(ctx context.Context, cfg config.Config) (*DB, error) {
	var dsn string
	if cfg.DBDriver == "mysql" {
		dsn = fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?charset=utf8mb4&parseTime=true&loc=Local&timeout=10s&readTimeout=30s&writeTimeout=30s", cfg.DBUser, cfg.DBPassword, cfg.DBHost, cfg.DBPort, cfg.DBName)
	} else {
		if err := os.MkdirAll(filepath.Dir(cfg.DBPath), 0o755); err != nil {
			return nil, fmt.Errorf("create sqlite directory: %w", err)
		}
		dsn = "file:" + filepath.ToSlash(cfg.DBPath) + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)"
	}
	db, err := sql.Open(cfg.DBDriver, dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s database: %w", cfg.DBDriver, err)
	}
	if cfg.DBDriver == "sqlite" {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		db.SetMaxOpenConns(20)
		db.SetMaxIdleConns(5)
		db.SetConnMaxLifetime(30 * time.Minute)
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping %s database: %w", cfg.DBDriver, err)
	}
	return &DB{DB: db, Driver: cfg.DBDriver}, nil
}

func (db *DB) Close() error { return db.DB.Close() }

func (db *DB) TableExists(ctx context.Context, table string) (bool, error) {
	var query string
	if db.Driver == "mysql" {
		query = "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?"
	} else {
		query = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?"
	}
	var count int
	if err := db.QueryRowContext(ctx, query, table).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func (db *DB) Now() time.Time { return time.Now().UTC() }
