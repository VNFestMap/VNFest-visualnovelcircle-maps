-- Reference SQL for migration 0007; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS club_moe_kings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    club_id INT NOT NULL,
    country VARCHAR(20) NOT NULL DEFAULT 'china',
    character_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    name_cn VARCHAR(255) NOT NULL DEFAULT '',
    image_url VARCHAR(500) NOT NULL DEFAULT '',
    summary TEXT,
    updated_by INT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_moe_king_club (club_id, country),
    INDEX idx_moe_kings_club (club_id, country),
    CONSTRAINT fk_moe_king_updater FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
