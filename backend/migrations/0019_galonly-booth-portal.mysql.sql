-- Reference SQL for migration 0019; the Go migrator is authoritative.
CREATE TABLE IF NOT EXISTS galonly_booth_profiles (
    event_id INT NOT NULL,
    booth_id VARCHAR(32) NOT NULL,
    profile_json LONGTEXT NOT NULL,
    profile_version INT NOT NULL DEFAULT 1,
    updated_by_type VARCHAR(16) NOT NULL DEFAULT 'seed',
    updated_by_user_id INT NULL,
    updated_by_account_id BIGINT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, booth_id),
    INDEX idx_galonly_booth_profiles_booth (booth_id),
    CONSTRAINT fk_galonly_booth_profiles_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE,
    CONSTRAINT fk_galonly_booth_profiles_user FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS galonly_booth_accounts (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    event_id INT NOT NULL,
    booth_id VARCHAR(32) NOT NULL,
    username VARCHAR(96) NOT NULL,
    username_normalized VARCHAR(96) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    initial_password_ciphertext TEXT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    credential_version INT NOT NULL DEFAULT 1,
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME NULL,
    last_login_at DATETIME NULL,
    password_changed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_galonly_booth_account_booth (event_id,booth_id),
    UNIQUE KEY uq_galonly_booth_account_username (event_id,username_normalized),
    INDEX idx_galonly_booth_accounts_event_status (event_id,status),
    CONSTRAINT fk_galonly_booth_accounts_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS galonly_booth_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    account_id BIGINT NOT NULL,
    credential_version INT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME NULL,
    INDEX idx_galonly_booth_sessions_account (account_id,revoked_at),
    INDEX idx_galonly_booth_sessions_expiry (expires_at),
    CONSTRAINT fk_galonly_booth_sessions_account FOREIGN KEY (account_id) REFERENCES galonly_booth_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS galonly_booth_metric_events (
    event_uuid CHAR(36) PRIMARY KEY,
    event_id INT NOT NULL,
    booth_id VARCHAR(32) NOT NULL,
    metric_type VARCHAR(24) NOT NULL,
    visitor_hash CHAR(64) NOT NULL,
    product_id VARCHAR(96) NULL,
    day_key DATE NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_galonly_booth_metrics_rollup (event_id,booth_id,metric_type,day_key),
    INDEX idx_galonly_booth_metrics_visitor (event_id,booth_id,visitor_hash),
    CONSTRAINT fk_galonly_booth_metrics_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS galonly_booth_favorites (
    event_id INT NOT NULL,
    booth_id VARCHAR(32) NOT NULL,
    visitor_hash CHAR(64) NOT NULL,
    user_id INT NULL,
    active TINYINT NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id,booth_id,visitor_hash),
    INDEX idx_galonly_booth_favorites_count (event_id,booth_id,active),
    INDEX idx_galonly_booth_favorites_user (event_id,user_id,active),
    CONSTRAINT fk_galonly_booth_favorites_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE,
    CONSTRAINT fk_galonly_booth_favorites_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
