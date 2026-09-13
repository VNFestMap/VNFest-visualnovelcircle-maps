-- Reference SQL for SQLite. Run through vnfest-migrate --apply.
CREATE TABLE IF NOT EXISTS vnfest_session_bridge (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER NULL,
    payload_json TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    is_valid INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_vnfest_session_bridge_user ON vnfest_session_bridge(user_id);
CREATE INDEX IF NOT EXISTS idx_vnfest_session_bridge_expiry ON vnfest_session_bridge(expires_at);
