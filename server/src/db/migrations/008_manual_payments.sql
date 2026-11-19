-- Payments the administrator keys in by hand (amount, month paid and the M-Pesa message), for members the system has no live M-Pesa record for yet.
CREATE TABLE manual_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id           uuid NOT NULL REFERENCES members(id),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  period              date NOT NULL CHECK (period = date_trunc('month', period)::date),
  transaction_message text NOT NULL,
  mpesa_code          text,
  route               text NOT NULL CHECK (route IN ('live_engine','sheet_ledger')),
  payment_id          uuid REFERENCES payments(id),
  savings_txn_id      uuid REFERENCES savings_transactions(id),
  recorded_by         uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX manual_payments_code_uidx ON manual_payments(mpesa_code) WHERE mpesa_code IS NOT NULL;
CREATE INDEX manual_payments_member_idx ON manual_payments(member_id, period);
CREATE TRIGGER manual_payments_no_delete BEFORE DELETE ON manual_payments FOR EACH ROW EXECUTE FUNCTION forbid_delete();
