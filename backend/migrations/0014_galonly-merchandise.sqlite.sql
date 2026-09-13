-- Reference SQL for migration 0014; column repair remains Go-only.
CREATE TABLE IF NOT EXISTS galonly_merchandise_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    material_version INTEGER NOT NULL,
    submitted_by INTEGER NULL,
    submitted_at TEXT NOT NULL,
    source_status TEXT NOT NULL DEFAULT 'phase2_pending',
    review_status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT NULL,
    reviewed_by INTEGER NULL,
    review_feedback TEXT NULL,
    merchandise_items TEXT NOT NULL,
    merchandise_attachments TEXT NULL,
    display_image TEXT NULL,
    UNIQUE(application_id, material_version)
);
CREATE INDEX IF NOT EXISTS idx_galonly_merch_revision_app ON galonly_merchandise_revisions(application_id, submitted_at);
