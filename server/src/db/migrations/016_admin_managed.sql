-- Administrator-managed accounts: the administrator decides what each member owes. While this is on, the system does not
-- generate monthly contributions, mark them overdue, add fines, send "you owe" reminders, or split a deposit across invoices on its own.
INSERT INTO system_settings (key, value) VALUES ('admin_managed', '{"enabled": true}') ON CONFLICT (key) DO NOTHING;

-- A month's contribution falls due on the deadline day of the following month (October is due 10 November): offset 1.
-- Offset 0 keeps the old behaviour (due in the same month) for rule versions that want it.
ALTER TABLE rule_versions ADD COLUMN due_month_offset integer NOT NULL DEFAULT 1 CHECK (due_month_offset IN (0, 1));
