-- Money posted by hand is NOT allocated automatically. It waits on the member's account until the administrator approves
-- which invoices it pays. A payment can therefore target an explicit list of invoices.
ALTER TABLE payments ADD COLUMN obligation_ids uuid[];

ALTER TABLE member_credits DROP CONSTRAINT member_credits_entry_type_check;
ALTER TABLE member_credits DROP CONSTRAINT member_credits_check;
ALTER TABLE member_credits ADD CONSTRAINT member_credits_entry_type_check CHECK (entry_type IN ('overpayment','received','applied','adjustment','reinstated'));
ALTER TABLE member_credits ADD CONSTRAINT member_credits_check CHECK (
  (entry_type IN ('overpayment','received','reinstated') AND amount_cents > 0) OR (entry_type IN ('applied','adjustment') AND amount_cents < 0));
