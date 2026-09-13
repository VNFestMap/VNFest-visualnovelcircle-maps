-- Reference SQL for MySQL. Run through vnfest-migrate --apply.
CREATE TABLE IF NOT EXISTS vnfest_session_bridge (
    session_id VARCHAR(128) PRIMARY KEY,
    user_id INT NULL,
    payload_json TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    is_valid TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    INDEX idx_vnfest_session_bridge_user (user_id),
    INDEX idx_vnfest_session_bridge_expiry (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
