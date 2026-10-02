-- Map layout, public booth profiles, and application review are separate
-- ownership domains. This migration only creates the bridge and lifecycle
-- state; it intentionally does not guess historic application assignments.
ALTER TABLE galonly_booth_profiles
    ADD COLUMN visibility_state TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_galonly_booth_profiles_visibility
    ON galonly_booth_profiles(event_id, visibility_state);

CREATE TABLE IF NOT EXISTS galonly_booth_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES galonly_events(id) ON DELETE CASCADE,
    application_id INTEGER NOT NULL REFERENCES galonly_applications(id) ON DELETE CASCADE,
    booth_id TEXT NOT NULL,
    assignment_status TEXT NOT NULL DEFAULT 'active',
    table_ids_json TEXT NOT NULL,
    created_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_id, application_id),
    UNIQUE(event_id, booth_id)
);

CREATE INDEX IF NOT EXISTS idx_galonly_booth_assignment_status
    ON galonly_booth_assignments(event_id, assignment_status);

-- Confirmed historical repair: C07 is one real four-table booth, not a
-- placeholder. This does not infer any application assignment.
INSERT INTO galonly_booth_profiles (event_id, booth_id, profile_json, profile_version, visibility_state, updated_by_type)
SELECT id, 'C07', '{"name":"黄昏的津冀之邀","circleName":"黄昏的津冀之邀","tagline":"黄昏的津冀之邀","description":"黄昏的津冀之邀参展摊位，使用 C05–C08 四个桌位。","avatarText":"黄昏","announcement":"","tags":[],"status":"preparing","color":"#4d7cc7","contact":{"label":"","url":null},"products":[]}', 1, 'active', 'migration_c07'
FROM galonly_events ge WHERE ge.event_code = 'beijing'
  AND EXISTS (SELECT 1 FROM galonly_map_documents d WHERE d.event_id=ge.id AND d.payload_json LIKE '%"id":"C07"%')
ON CONFLICT(event_id, booth_id) DO UPDATE SET profile_json=excluded.profile_json, profile_version=galonly_booth_profiles.profile_version+1, visibility_state='active', updated_by_type='migration_c07', updated_at=CURRENT_TIMESTAMP;
