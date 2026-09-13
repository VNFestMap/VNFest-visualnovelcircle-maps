-- Reference SQL for migration 0017. The Go migrator is authoritative.
ALTER TABLE galonly_applications ADD COLUMN phase1_feedback TEXT NULL;
ALTER TABLE galonly_applications ADD COLUMN phase2_feedback TEXT NULL;
