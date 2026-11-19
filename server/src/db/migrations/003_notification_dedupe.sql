-- Reminders and alerts must be sent once per member per event, however often the scheduler runs.
ALTER TABLE notifications ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX notifications_dedupe_uidx ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
