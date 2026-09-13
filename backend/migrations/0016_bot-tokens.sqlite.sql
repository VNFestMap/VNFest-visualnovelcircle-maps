-- Reference SQL for migration 0016. The Go migrator is authoritative.
CREATE TABLE IF NOT EXISTS club_bot_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    country TEXT NOT NULL DEFAULT 'china',
    name TEXT NOT NULL DEFAULT '',
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    permissions TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_club ON club_bot_tokens(club_id, country);
CREATE INDEX IF NOT EXISTS idx_club_bot_tokens_prefix ON club_bot_tokens(token_prefix);
