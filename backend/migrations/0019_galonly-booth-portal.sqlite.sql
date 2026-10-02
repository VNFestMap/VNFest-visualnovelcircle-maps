-- Reference SQL for migration 0019; the Go migrator is authoritative.
CREATE TABLE IF NOT EXISTS galonly_booth_profiles (
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    booth_id TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    profile_version INTEGER NOT NULL DEFAULT 1,
    updated_by_type TEXT NOT NULL DEFAULT 'seed',
    updated_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_by_account_id INTEGER NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, booth_id)
);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_profiles_booth ON galonly_booth_profiles(booth_id);

CREATE TABLE IF NOT EXISTS galonly_booth_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    booth_id TEXT NOT NULL,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    initial_password_ciphertext TEXT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    credential_version INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT NULL,
    last_login_at TEXT NULL,
    password_changed_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, booth_id),
    UNIQUE(event_id, username_normalized)
);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_accounts_event_status ON galonly_booth_accounts(event_id,status);

CREATE TABLE IF NOT EXISTS galonly_booth_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES galonly_booth_accounts(id) ON DELETE CASCADE,
    credential_version INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_sessions_account ON galonly_booth_sessions(account_id,revoked_at);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_sessions_expiry ON galonly_booth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS galonly_booth_metric_events (
    event_uuid TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    booth_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    product_id TEXT NULL,
    day_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_metrics_rollup ON galonly_booth_metric_events(event_id,booth_id,metric_type,day_key);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_metrics_visitor ON galonly_booth_metric_events(event_id,booth_id,visitor_hash);

CREATE TABLE IF NOT EXISTS galonly_booth_favorites (
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    booth_id TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, booth_id, visitor_hash)
);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_favorites_count ON galonly_booth_favorites(event_id,booth_id,active);
CREATE INDEX IF NOT EXISTS idx_galonly_booth_favorites_user ON galonly_booth_favorites(event_id,user_id,active);
