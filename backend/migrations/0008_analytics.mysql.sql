-- Reference SQL for migration 0008; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS analytics_pageviews (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event_id CHAR(36) NOT NULL UNIQUE,
    visitor_hash CHAR(64) NOT NULL,
    page_path VARCHAR(512) NOT NULL,
    page_title VARCHAR(255) NOT NULL DEFAULT '',
    source_category VARCHAR(32) NOT NULL DEFAULT 'external',
    referrer_host VARCHAR(255) NOT NULL DEFAULT '',
    device_type VARCHAR(16) NOT NULL DEFAULT 'unknown',
    browser_name VARCHAR(32) NOT NULL DEFAULT 'other',
    is_authenticated TINYINT(1) NOT NULL DEFAULT 0,
    day_key DATE NOT NULL,
    created_at DATETIME NOT NULL,
    INDEX idx_analytics_day (day_key),
    INDEX idx_analytics_created (created_at),
    INDEX idx_analytics_visitor_day (visitor_hash, day_key),
    INDEX idx_analytics_page_day (page_path(191), day_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS analytics_historical_pv (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    day_key DATE NOT NULL,
    page_path VARCHAR(512) NOT NULL,
    page_title VARCHAR(255) NOT NULL DEFAULT '',
    source_category VARCHAR(32) NOT NULL DEFAULT 'external',
    referrer_host VARCHAR(255) NOT NULL DEFAULT '',
    device_type VARCHAR(16) NOT NULL DEFAULT 'unknown',
    browser_name VARCHAR(32) NOT NULL DEFAULT 'other',
    pv_count INT UNSIGNED NOT NULL DEFAULT 0,
    imported_at DATETIME NOT NULL,
    UNIQUE KEY uq_analytics_historical_dimension (day_key, page_path(191), source_category, referrer_host(191), device_type, browser_name),
    INDEX idx_analytics_historical_day (day_key),
    INDEX idx_analytics_historical_page_day (page_path(191), day_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
