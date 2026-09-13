-- Reference SQL for migration 0005; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS club_verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    max_uses INTEGER NOT NULL DEFAULT 50,
    use_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    country TEXT NOT NULL DEFAULT 'china'
);
CREATE INDEX IF NOT EXISTS idx_verify_codes_club ON club_verification_codes(club_id);
CREATE INDEX IF NOT EXISTS idx_verify_codes_code ON club_verification_codes(code);
