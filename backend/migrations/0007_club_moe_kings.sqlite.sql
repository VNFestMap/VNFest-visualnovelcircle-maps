-- Reference SQL for migration 0007; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS club_moe_kings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    country TEXT NOT NULL DEFAULT 'china',
    character_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    name_cn TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    updated_by INTEGER NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(club_id, country)
);
CREATE INDEX IF NOT EXISTS idx_moe_kings_club ON club_moe_kings(club_id, country);
