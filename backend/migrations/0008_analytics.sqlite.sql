-- Reference SQL for migration 0008; the executable migration is in Go.
CREATE TABLE IF NOT EXISTS analytics_pageviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    visitor_hash TEXT NOT NULL,
    page_path TEXT NOT NULL,
    page_title TEXT NOT NULL DEFAULT '',
    source_category TEXT NOT NULL DEFAULT 'external',
    referrer_host TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT 'unknown',
    browser_name TEXT NOT NULL DEFAULT 'other',
    is_authenticated INTEGER NOT NULL DEFAULT 0,
    day_key TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_day ON analytics_pageviews(day_key);
CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_pageviews(created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor_day ON analytics_pageviews(visitor_hash, day_key);
CREATE INDEX IF NOT EXISTS idx_analytics_page_day ON analytics_pageviews(page_path, day_key);
CREATE TABLE IF NOT EXISTS analytics_historical_pv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_key TEXT NOT NULL,
    page_path TEXT NOT NULL,
    page_title TEXT NOT NULL DEFAULT '',
    source_category TEXT NOT NULL DEFAULT 'external',
    referrer_host TEXT NOT NULL DEFAULT '',
    device_type TEXT NOT NULL DEFAULT 'unknown',
    browser_name TEXT NOT NULL DEFAULT 'other',
    pv_count INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_historical_dimension ON analytics_historical_pv(day_key, page_path, source_category, referrer_host, device_type, browser_name);
CREATE INDEX IF NOT EXISTS idx_analytics_historical_day ON analytics_historical_pv(day_key);
CREATE INDEX IF NOT EXISTS idx_analytics_historical_page_day ON analytics_historical_pv(page_path, day_key);
