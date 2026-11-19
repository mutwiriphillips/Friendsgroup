-- Invoice-style accounting: the administrator raises what a member owes (contribution, late fine, missing-meeting fine),
-- then posts payments that clear the oldest invoices first, rolling into future months.
ALTER TABLE fines DROP CONSTRAINT fines_late_needs_obligation;
ALTER TABLE fines ADD CONSTRAINT fines_late_needs_obligation CHECK (category <> 'late_payment' OR obligation_id IS NOT NULL OR is_historical OR period IS NOT NULL);

ALTER TABLE manual_payments ALTER COLUMN period DROP NOT NULL;
ALTER TABLE manual_payments DROP CONSTRAINT manual_payments_route_check;
ALTER TABLE manual_payments ADD COLUMN kind text NOT NULL DEFAULT 'auto' CHECK (kind IN ('auto','contribution','penalty'));
ALTER TABLE manual_payments ADD COLUMN paid_on date;
ALTER TABLE manual_payments ADD COLUMN allocation jsonb;
ALTER TABLE manual_payments ADD COLUMN penalty_payment_id uuid REFERENCES payments(id);
