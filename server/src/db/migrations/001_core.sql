-- 001_core.sql : users, members, rules, obligations, payments, savings & fines ledgers, audit
-- All money is stored as integer cents (KSh 1,500 = 150000) to avoid floating point errors.

CREATE TYPE user_role AS ENUM ('super_admin', 'chairperson', 'treasurer', 'secretary', 'member');
CREATE TYPE member_status AS ENUM ('active', 'suspended', 'withdrawn', 'deceased');
CREATE TYPE obligation_status AS ENUM ('not_due', 'unpaid', 'overdue', 'paid', 'late_paid');
CREATE TYPE payment_purpose AS ENUM ('savings', 'fine');
CREATE TYPE payment_channel AS ENUM ('stk_push', 'c2b', 'manual');
CREATE TYPE payment_status AS ENUM (
  'initiated',   -- STK push sent, NOT proof of payment
  'confirmed',   -- verified by callback / treasurer
  'failed',
  'cancelled',
  'held',        -- underpayment or invalid: awaiting treasurer reconciliation
  'unmatched',   -- money received, no member/obligation match
  'reversed'
);
CREATE TYPE savings_txn_type AS ENUM ('contribution', 'historical', 'adjustment', 'withdrawal', 'reversal');
CREATE TYPE fine_category AS ENUM ('late_payment', 'absence', 'other');
CREATE TYPE fine_status AS ENUM ('outstanding', 'paid', 'waived', 'reversed');
CREATE TYPE fine_entry_type AS ENUM ('charge', 'payment', 'waiver', 'reversal', 'payment_reversal');

-- ---------------------------------------------------------------- identity
CREATE TABLE members (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_no      text NOT NULL UNIQUE,
  full_name          text NOT NULL,
  national_id_enc    text NOT NULL,           -- AES-256-GCM ciphertext
  national_id_hash   text NOT NULL UNIQUE,    -- HMAC for duplicate prevention
  phone              text NOT NULL,
  mpesa_phone        text NOT NULL,
  photo_path         text,
  email              text,
  physical_address   text,
  next_of_kin        jsonb,
  emergency_contact  jsonb,
  status             member_status NOT NULL DEFAULT 'active',
  registered_on      date NOT NULL DEFAULT CURRENT_DATE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX members_status_idx ON members(status);
CREATE INDEX members_mpesa_phone_idx ON members(mpesa_phone);

CREATE SEQUENCE membership_no_seq START 1;

CREATE TABLE member_status_history (
  id          bigserial PRIMARY KEY,
  member_id   uuid NOT NULL REFERENCES members(id),
  old_status  member_status,
  new_status  member_status NOT NULL,
  reason      text,
  changed_by  uuid,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text UNIQUE,
  phone            text,
  password_hash    text NOT NULL,
  role             user_role NOT NULL,
  member_id        uuid UNIQUE REFERENCES members(id),
  is_active        boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts  int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  totp_secret_enc  text,
  consent_version  text,
  consent_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK (role <> 'member' OR member_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_phone_uidx ON users(phone) WHERE phone IS NOT NULL;

CREATE TABLE login_activity (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id),
  identifier text NOT NULL,
  success    boolean NOT NULL,
  ip         text,
  user_agent text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_activity_user_idx ON login_activity(user_id, at DESC);

-- ---------------------------------------------------------------- rules & years
-- Rules are versioned. Obligations snapshot amount/due date at generation time,
-- so changing a rule never alters history.
CREATE TABLE rule_versions (
  id                    bigserial PRIMARY KEY,
  effective_from        date NOT NULL UNIQUE,
  monthly_amount_cents  bigint NOT NULL CHECK (monthly_amount_cents > 0),
  deadline_day          int NOT NULL CHECK (deadline_day BETWEEN 1 AND 28),
  late_fine_cents       bigint NOT NULL CHECK (late_fine_cents >= 0),
  absence_fine_cents    bigint NOT NULL CHECK (absence_fine_cents >= 0),
  meetings_per_year     int NOT NULL CHECK (meetings_per_year >= 0),
  reason                text,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE financial_years (
  id          bigserial PRIMARY KEY,
  label       text NOT NULL UNIQUE,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  is_current  boolean NOT NULL DEFAULT false,
  CHECK (end_date > start_date)
);
CREATE UNIQUE INDEX financial_years_one_current ON financial_years(is_current) WHERE is_current;

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- payments (M-Pesa & manual)
CREATE SEQUENCE receipt_no_seq START 1;

CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no            text UNIQUE,
  member_id             uuid REFERENCES members(id),       -- null while unmatched
  purpose               payment_purpose NOT NULL,
  channel               payment_channel NOT NULL,
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  phone                 text,
  status                payment_status NOT NULL DEFAULT 'initiated',
  mpesa_receipt         text,                               -- e.g. QGH7XXXX
  checkout_request_id   text UNIQUE,
  merchant_request_id   text,
  result_code           int,
  result_desc           text,
  fine_ids              uuid[],                             -- fines a fine-payment targets
  raw_callback          jsonb,
  hold_reason           text,
  is_historical         boolean NOT NULL DEFAULT false,
  occurred_at           timestamptz,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  confirmed_at          timestamptz,
  confirmed_by          uuid REFERENCES users(id)
);
-- A real M-Pesa receipt can only ever be recorded once (idempotency / duplicate detection).
CREATE UNIQUE INDEX payments_mpesa_receipt_uidx ON payments(mpesa_receipt) WHERE mpesa_receipt IS NOT NULL;
CREATE INDEX payments_member_idx ON payments(member_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments(status);

-- ---------------------------------------------------------------- monthly obligations
CREATE TABLE monthly_obligations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id           uuid NOT NULL REFERENCES members(id),
  financial_year_id   bigint NOT NULL REFERENCES financial_years(id),
  period              date NOT NULL CHECK (period = date_trunc('month', period)::date),
  amount_due_cents    bigint NOT NULL CHECK (amount_due_cents > 0),
  due_date            date NOT NULL,
  late_fine_cents     bigint NOT NULL DEFAULT 0,   -- snapshot of the rule at generation
  status              obligation_status NOT NULL DEFAULT 'not_due',
  paid_cents          bigint NOT NULL DEFAULT 0,
  paid_at             timestamptz,
  payment_id          uuid REFERENCES payments(id),
  rule_version_id     bigint REFERENCES rule_versions(id),
  is_historical       boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, period),
  -- No partial contributions: an obligation is either untouched or paid in full.
  CONSTRAINT no_partial_payment CHECK (paid_cents = 0 OR paid_cents = amount_due_cents),
  CONSTRAINT paid_status_consistent CHECK (
    (status IN ('paid','late_paid') AND paid_cents = amount_due_cents)
    OR (status IN ('not_due','unpaid','overdue') AND paid_cents = 0)
  )
);
CREATE INDEX obligations_member_open_idx ON monthly_obligations(member_id, period)
  WHERE status IN ('not_due','unpaid','overdue');
CREATE INDEX obligations_period_idx ON monthly_obligations(period);

-- ---------------------------------------------------------------- SAVINGS LEDGER (append-only)
CREATE TABLE savings_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES members(id),
  type             savings_txn_type NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents <> 0),   -- signed: + in, - out
  payment_id       uuid REFERENCES payments(id),
  reverses_id      uuid REFERENCES savings_transactions(id),
  reference        text,
  reason           text,
  is_historical    boolean NOT NULL DEFAULT false,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (type NOT IN ('contribution','historical') OR amount_cents > 0),
  CHECK (type <> 'withdrawal' OR amount_cents < 0),
  CHECK (type <> 'reversal' OR reverses_id IS NOT NULL)
);
CREATE INDEX savings_member_idx ON savings_transactions(member_id, occurred_at);
-- A transaction can be reversed at most once.
CREATE UNIQUE INDEX savings_one_reversal_uidx ON savings_transactions(reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE savings_allocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_txn_id  uuid NOT NULL REFERENCES savings_transactions(id),
  obligation_id   uuid NOT NULL REFERENCES monthly_obligations(id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  allocated_at    timestamptz NOT NULL DEFAULT now(),
  reversed_at     timestamptz,
  UNIQUE (savings_txn_id, obligation_id)
);
-- An obligation can only be settled once (by a live allocation).
CREATE UNIQUE INDEX alloc_one_live_per_obligation ON savings_allocations(obligation_id) WHERE reversed_at IS NULL;

-- ---------------------------------------------------------------- FINES LEDGER
CREATE SEQUENCE fine_ref_seq START 1;

CREATE TABLE fines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  member_id        uuid NOT NULL REFERENCES members(id),
  category         fine_category NOT NULL,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  imposed_on       date NOT NULL DEFAULT CURRENT_DATE,
  reason           text NOT NULL,
  obligation_id    uuid REFERENCES monthly_obligations(id),
  meeting_id       uuid,                                    -- FK added in 002
  status           fine_status NOT NULL DEFAULT 'outstanding',
  paid_payment_id  uuid REFERENCES payments(id),
  paid_at          timestamptz,
  resolution_note  text,
  resolved_by      uuid REFERENCES users(id),
  is_historical    boolean NOT NULL DEFAULT false,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (category <> 'late_payment' OR obligation_id IS NOT NULL)
);
-- One late fine per overdue obligation, one absence fine per member per meeting.
CREATE UNIQUE INDEX fines_one_late_per_obligation ON fines(obligation_id)
  WHERE category = 'late_payment';
CREATE UNIQUE INDEX fines_one_absence_per_meeting ON fines(meeting_id, member_id)
  WHERE category = 'absence' AND status <> 'reversed';
CREATE INDEX fines_member_idx ON fines(member_id, status);

CREATE TABLE fine_ledger (
  id            bigserial PRIMARY KEY,
  fine_id       uuid NOT NULL REFERENCES fines(id),
  member_id     uuid NOT NULL REFERENCES members(id),
  entry_type    fine_entry_type NOT NULL,
  amount_cents  bigint NOT NULL,           -- charge +, payment/waiver/reversal -
  payment_id    uuid REFERENCES payments(id),
  note          text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type IN ('charge','payment_reversal') AND amount_cents > 0) OR (entry_type NOT IN ('charge','payment_reversal') AND amount_cents < 0))
);
CREATE INDEX fine_ledger_member_idx ON fine_ledger(member_id, created_at);

-- ---------------------------------------------------------------- notifications & audit
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      uuid,
  user_role    text,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  reason       text,
  before       jsonb,
  after        jsonb,
  ip           text
);
CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id);
CREATE INDEX audit_at_idx ON audit_logs(at DESC);

-- ---------------------------------------------------------------- immutability guards
-- Confirmed financial records can never be edited or deleted. Corrections are new
-- reversal / adjustment rows that point back at the original.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed (record a reversal or adjustment instead)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER savings_transactions_append_only BEFORE UPDATE OR DELETE ON savings_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fine_ledger_append_only BEFORE UPDATE OR DELETE ON fine_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER login_activity_append_only BEFORE UPDATE OR DELETE ON login_activity
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Payments may change status (initiated -> confirmed, confirmed -> reversed) but are never deleted,
-- and the money facts of a confirmed payment cannot be rewritten.
CREATE FUNCTION guard_payments() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('confirmed','reversed') AND (
       NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.mpesa_receipt IS DISTINCT FROM OLD.mpesa_receipt
    OR NEW.purpose IS DISTINCT FROM OLD.purpose) THEN
    RAISE EXCEPTION 'confirmed payment % cannot be altered', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'reversed payment cannot be reopened' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION guard_payments();

-- Members and obligations are never deleted; history must survive status changes.
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER members_no_delete BEFORE DELETE ON members FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER obligations_no_delete BEFORE DELETE ON monthly_obligations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER fines_no_delete BEFORE DELETE ON fines FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER allocations_no_delete BEFORE DELETE ON savings_allocations FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- seed defaults
INSERT INTO rule_versions (effective_from, monthly_amount_cents, deadline_day, late_fine_cents, absence_fine_cents, meetings_per_year, reason)
VALUES ('2000-01-01', 150000, 10, 20000, 500000, 3, 'Initial group rules');

INSERT INTO system_settings (key, value) VALUES
  ('group_name', '"Members Savings Group"'),
  ('payment_channel', '"mpesa"'),
  ('withdrawal_approval_levels', '["treasurer","chairperson"]'),
  ('privacy_notice_version', '"1.0"');
