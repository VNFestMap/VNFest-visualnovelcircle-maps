-- Reference SQL for migration 0006; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS club_recommendations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    club_id INT NOT NULL,
    country VARCHAR(20) NOT NULL DEFAULT 'china',
    bangumi_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    image_url VARCHAR(500) NOT NULL DEFAULT '',
    rating DECIMAL(3,1) NOT NULL DEFAULT 0,
    summary TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_recommendations_club (club_id, sort_order),
    CONSTRAINT fk_recommendations_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS club_comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    club_id INT NOT NULL,
    country VARCHAR(20) NOT NULL DEFAULT 'china',
    user_id INT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_comments_club (club_id, created_at),
    CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
