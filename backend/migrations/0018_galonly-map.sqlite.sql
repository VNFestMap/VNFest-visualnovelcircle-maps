-- Reference SQL for migration 0018; the Go migrator is authoritative.
CREATE TABLE IF NOT EXISTS galonly_map_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
    schema_version INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    published_at TEXT NULL,
    UNIQUE(event_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_galonly_map_status ON galonly_map_documents(event_id, status, revision);

CREATE TABLE IF NOT EXISTS galonly_map_user_state (
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    favorite_booths_json TEXT NOT NULL DEFAULT '[]',
    selected_booth_id TEXT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id)
);
