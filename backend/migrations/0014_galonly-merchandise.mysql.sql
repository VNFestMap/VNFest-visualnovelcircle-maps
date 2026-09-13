-- Reference SQL for migration 0014. The Go migrator adds missing legacy
-- columns one by one before creating this append-only history table.
CREATE TABLE IF NOT EXISTS galonly_merchandise_revisions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    application_id INT NOT NULL,
    material_version INT NOT NULL,
    submitted_by INT NULL,
    submitted_at DATETIME NOT NULL,
    source_status VARCHAR(40) NOT NULL DEFAULT 'phase2_pending',
    review_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    reviewed_at DATETIME NULL,
    reviewed_by INT NULL,
    review_feedback TEXT NULL,
    merchandise_items TEXT NOT NULL,
    merchandise_attachments TEXT NULL,
    display_image VARCHAR(500) NULL,
    UNIQUE KEY uk_galonly_merch_revision (application_id, material_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_galonly_merch_revision_app ON galonly_merchandise_revisions(application_id, submitted_at);
