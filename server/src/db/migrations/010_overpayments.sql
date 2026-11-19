-- Overpayments are kept as a credit on the member's account. Only the administrator applies the credit to fines or contributions.
-- Append-only: an overpayment adds a positive entry, applying credit adds a negative one. Balance = sum.
CREATE TABLE member_credits (
  id                bigserial PRIMARY KEY,
  member_id         uuid NOT NULL REFERENCES members(id),
  entry_type        text NOT NULL CHECK (entry_type IN ('overpayment','applied')),
  amount_cents      bigint NOT NULL,
  manual_payment_id uuid REFERENCES manual_payments(id),
  note              text,
  allocation        jsonb,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'overpayment' AND amount_cents > 0) OR (entry_type = 'applied' AND amount_cents < 0))
);
CREATE INDEX member_credits_member_idx ON member_credits(member_id, created_at);
CREATE TRIGGER member_credits_append_only BEFORE UPDATE OR DELETE ON member_credits FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
