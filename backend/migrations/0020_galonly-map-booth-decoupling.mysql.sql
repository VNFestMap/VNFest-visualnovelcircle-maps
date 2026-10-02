-- Map layout, public booth profiles, and application review are separate
-- ownership domains. This migration only creates the bridge and lifecycle
-- state; it intentionally does not guess historic application assignments.
ALTER TABLE galonly_booth_profiles
    ADD COLUMN IF NOT EXISTS visibility_state VARCHAR(32) NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_galonly_booth_profiles_visibility
    ON galonly_booth_profiles(event_id, visibility_state);

CREATE TABLE IF NOT EXISTS galonly_booth_assignments (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    event_id INT NOT NULL,
    application_id INT NOT NULL,
    booth_id VARCHAR(32) NOT NULL,
    assignment_status VARCHAR(32) NOT NULL DEFAULT 'active',
    table_ids_json TEXT NOT NULL,
    created_by INT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_galonly_booth_assignment_application (event_id, application_id),
    UNIQUE KEY uq_galonly_booth_assignment_booth (event_id, booth_id),
    INDEX idx_galonly_booth_assignment_status (event_id, assignment_status),
    CONSTRAINT fk_galonly_booth_assignment_event FOREIGN KEY (event_id) REFERENCES galonly_events(id) ON DELETE CASCADE,
    CONSTRAINT fk_galonly_booth_assignment_application FOREIGN KEY (application_id) REFERENCES galonly_applications(id) ON DELETE CASCADE,
    CONSTRAINT fk_galonly_booth_assignment_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Confirmed historical repair: C07 is one real four-table booth, not a
-- placeholder. This does not infer any application assignment.
INSERT INTO galonly_booth_profiles (event_id, booth_id, profile_json, profile_version, visibility_state, updated_by_type)
SELECT id, 'C07', '{"name":"黄昏的津冀之邀","circleName":"黄昏的津冀之邀","tagline":"黄昏的津冀之邀","description":"黄昏的津冀之邀参展摊位，使用 C05–C08 四个桌位。","avatarText":"黄昏","announcement":"","tags":[],"status":"preparing","color":"#4d7cc7","contact":{"label":"","url":null},"products":[]}', 1, 'active', 'migration_c07'
FROM galonly_events ge WHERE ge.event_code = 'beijing'
  AND EXISTS (SELECT 1 FROM galonly_map_documents d WHERE d.event_id=ge.id AND d.payload_json LIKE '%"id":"C07"%')
ON DUPLICATE KEY UPDATE profile_json=VALUES(profile_json), profile_version=profile_version+1, visibility_state='active', updated_by_type='migration_c07', updated_at=CURRENT_TIMESTAMP;
