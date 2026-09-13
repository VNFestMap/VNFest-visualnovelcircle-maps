-- Reference SQL for migration 0006; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS club_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    country TEXT NOT NULL DEFAULT 'china',
    bangumi_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    rating REAL NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recommendations_club ON club_recommendations(club_id, sort_order);
CREATE TABLE IF NOT EXISTS club_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    country TEXT NOT NULL DEFAULT 'china',
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_club ON club_comments(club_id, created_at);
