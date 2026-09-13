-- Reference SQL for migration 0016. The Go migrator is authoritative.
CREATE TABLE IF NOT EXISTS club_bot_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    club_id INT NOT NULL,
    country VARCHAR(20) NOT NULL DEFAULT 'china',
    name VARCHAR(120) NOT NULL DEFAULT '',
    token_prefix VARCHAR(64) NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    permissions TEXT NOT NULL,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    revoked_at DATETIME NULL,
    INDEX idx_club_bot_tokens_club (club_id, country),
    INDEX idx_club_bot_tokens_prefix (token_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
