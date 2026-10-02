-- Reference SQL for migration 0018; the Go migrator is authoritative.
CREATE TABLE IF NOT EXISTS galonly_map_documents (
    id INT PRIMARY KEY AUTO_INCREMENT,
    event_id INT NOT NULL,
    revision INT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'draft',
    schema_version INT NOT NULL,
    payload_json LONGTEXT NOT NULL,
    checksum_sha256 CHAR(64) NOT NULL,
    source_name VARCHAR(255) NOT NULL DEFAULT '',
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by INT NULL,
    published_at DATETIME NULL,
    UNIQUE KEY uq_galonly_map_revision (event_id, revision),
    INDEX idx_galonly_map_status (event_id, status, revision),
    CONSTRAINT fk_galonly_map_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE,
    CONSTRAINT fk_galonly_map_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_galonly_map_published_by FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS galonly_map_user_state (
    event_id INT NOT NULL,
    user_id INT NOT NULL,
    favorite_booths_json TEXT NOT NULL,
    selected_booth_id VARCHAR(32) NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (event_id, user_id),
    CONSTRAINT fk_galonly_map_state_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE,
    CONSTRAINT fk_galonly_map_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
