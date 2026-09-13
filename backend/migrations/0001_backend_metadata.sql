-- Reference SQL for backend/internal/store/sqlstore migration 0001.
-- The Go migration runner owns execution and records the version atomically.
CREATE TABLE IF NOT EXISTS vnfest_schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    applied_at DATETIME NOT NULL
);
