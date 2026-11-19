-- Corrections: a wrongly recorded payment can be reversed (never deleted) and re-entered; its M-Pesa code is then free to use again.
ALTER TABLE manual_payments ADD COLUMN reversed_at timestamptz;
ALTER TABLE manual_payments ADD COLUMN reversed_reason text;
DROP INDEX manual_payments_code_uidx;
CREATE UNIQUE INDEX manual_payments_code_uidx ON manual_payments(mpesa_code) WHERE mpesa_code IS NOT NULL AND reversed_at IS NULL;

-- Credit ledger: allow adjustments (e.g. an overpayment taken back when its payment is reversed).
ALTER TABLE member_credits DROP CONSTRAINT member_credits_entry_type_check;
ALTER TABLE member_credits DROP CONSTRAINT member_credits_check;
ALTER TABLE member_credits ADD CONSTRAINT member_credits_entry_type_check CHECK (entry_type IN ('overpayment','applied','adjustment'));
ALTER TABLE member_credits ADD CONSTRAINT member_credits_check CHECK (
  (entry_type = 'overpayment' AND amount_cents > 0) OR (entry_type IN ('applied','adjustment') AND amount_cents < 0));
