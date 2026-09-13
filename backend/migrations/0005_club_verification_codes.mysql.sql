-- Reference SQL for migration 0005; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS club_verification_codes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    club_id INT NOT NULL,
    code VARCHAR(255) NOT NULL,
    created_by INT NOT NULL,
    max_uses INT NOT NULL DEFAULT 50,
    use_count INT NOT NULL DEFAULT 0,
    expires_at DATETIME NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    country VARCHAR(20) NOT NULL DEFAULT 'china',
    INDEX idx_verify_codes_club (club_id),
    INDEX idx_verify_codes_code (code),
    CONSTRAINT fk_verify_codes_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
