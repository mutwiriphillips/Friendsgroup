-- 002_governance.sql : files, meetings, withdrawals, group finance, verification, reconciliation, notifications

CREATE TYPE attendance_status AS ENUM ('pending', 'present', 'absent', 'excused');
CREATE TYPE meeting_status AS ENUM ('scheduled', 'held', 'register_confirmed', 'cancelled');
CREATE TYPE withdrawal_status AS ENUM ('submitted', 'in_review', 'approved', 'rejected', 'paid', 'cancelled');
CREATE TYPE expenditure_status AS ENUM ('pending', 'approved', 'rejected', 'paid', 'voided');
CREATE TYPE submission_status AS ENUM ('pending', 'clarification', 'approved', 'rejected');
CREATE TYPE recon_status AS ENUM ('pending', 'in_progress', 'discrepancies_found', 'awaiting_approval', 'closed');
CREATE TYPE discrepancy_status AS ENUM ('unresolved', 'investigating', 'resolved', 'exception');

-- ---------------------------------------------------------------- stored files (photos, documents, screenshots)
-- Kept in Postgres so they are covered by the database's automated backups.
CREATE TABLE stored_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  mime_type   text NOT NULL,
  size_bytes  int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  data        bytea NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE members ADD COLUMN photo_file_id uuid REFERENCES stored_files(id);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  category    text NOT NULL CHECK (category IN ('constitution','minutes','financial_statement','policy','resolution','membership','other')),
  file_id     uuid NOT NULL REFERENCES stored_files(id),
  visibility  text NOT NULL DEFAULT 'members' CHECK (visibility IN ('members','officials')),
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- meetings & attendance
CREATE TABLE meetings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_year_id     bigint NOT NULL REFERENCES financial_years(id),
  title                 text NOT NULL,
  scheduled_at          timestamptz NOT NULL,
  venue                 text NOT NULL,
  agenda                text,
  minutes               text,
  minutes_file_id       uuid REFERENCES stored_files(id),
  status                meeting_status NOT NULL DEFAULT 'scheduled',
  register_confirmed_at timestamptz,
  register_confirmed_by uuid REFERENCES users(id),
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_year_idx ON meetings(financial_year_id, scheduled_at);
ALTER TABLE fines ADD CONSTRAINT fines_meeting_fk FOREIGN KEY (meeting_id) REFERENCES meetings(id);

CREATE TABLE attendance (
  meeting_id        uuid NOT NULL REFERENCES meetings(id),
  member_id         uuid NOT NULL REFERENCES members(id),
  status            attendance_status NOT NULL DEFAULT 'pending',
  apology_reason    text,
  apology_reviewed  boolean NOT NULL DEFAULT false,
  updated_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, member_id)
);
CREATE INDEX attendance_member_idx ON attendance(member_id);

-- ---------------------------------------------------------------- announcements
CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  audience    text NOT NULL DEFAULT 'all',
  member_ids  uuid[],
  channels    text[] NOT NULL DEFAULT ARRAY['in_app'],
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_outbox (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('sms','email')),
  recipient   text NOT NULL,
  subject     text,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','not_configured')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

-- ---------------------------------------------------------------- withdrawals (multi-level approval)
CREATE TABLE withdrawals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             text NOT NULL UNIQUE,
  member_id             uuid NOT NULL REFERENCES members(id),
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  reason                text NOT NULL,
  status                withdrawal_status NOT NULL DEFAULT 'submitted',
  current_level         int NOT NULL DEFAULT 1,
  required_levels       text[] NOT NULL,                 -- snapshot of approval chain, e.g. {treasurer,chairperson}
  balance_at_request    bigint NOT NULL,
  payout_reference      text,
  paid_at               timestamptz,
  paid_by               uuid REFERENCES users(id),
  savings_txn_id        uuid REFERENCES savings_transactions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- At most one open request per member: prevents duplicate requests becoming duplicate payments.
CREATE UNIQUE INDEX withdrawals_one_open_per_member ON withdrawals(member_id)
  WHERE status IN ('submitted','in_review','approved');
CREATE UNIQUE INDEX withdrawals_payout_ref_uidx ON withdrawals(payout_reference) WHERE payout_reference IS NOT NULL;

CREATE TABLE withdrawal_approvals (
  id             bigserial PRIMARY KEY,
  withdrawal_id  uuid NOT NULL REFERENCES withdrawals(id),
  level          int NOT NULL,
  role           user_role NOT NULL,
  decision       text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason         text,
  decided_by     uuid NOT NULL REFERENCES users(id),
  decided_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (withdrawal_id, level)
);

-- ---------------------------------------------------------------- group income & expenditure
CREATE TABLE income (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text NOT NULL CHECK (category IN ('special_contribution','other_income','opening_balance','adjustment')),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  received_on   date NOT NULL,
  description   text NOT NULL,
  source        text,
  reference     text,
  reverses_id   uuid REFERENCES income(id),
  recorded_by   uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX income_one_reversal ON income(reverses_id) WHERE reverses_id IS NOT NULL;

CREATE TABLE expenditure (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference          text NOT NULL UNIQUE,
  category           text NOT NULL CHECK (category IN ('administrative','meeting','other')),
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  spent_on           date NOT NULL,
  description        text NOT NULL,
  recipient          text NOT NULL,
  meeting_id         uuid REFERENCES meetings(id),
  status             expenditure_status NOT NULL DEFAULT 'pending',
  requested_by       uuid NOT NULL REFERENCES users(id),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  supporting_file_id uuid REFERENCES stored_files(id),
  payment_reference  text,
  paid_at            timestamptz,
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'paid' OR (approved_by IS NOT NULL AND payment_reference IS NOT NULL))
);
CREATE INDEX expenditure_status_idx ON expenditure(status, spent_on);

-- ---------------------------------------------------------------- M-Pesa verification queue
CREATE TABLE payment_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES members(id),
  mpesa_code      text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  phone           text NOT NULL,
  paid_at         timestamptz NOT NULL,
  purpose         payment_purpose NOT NULL,
  fine_ids        uuid[],
  message_text    text,
  screenshot_id   uuid REFERENCES stored_files(id),
  status          submission_status NOT NULL DEFAULT 'pending',
  review_note     text,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  payment_id      uuid REFERENCES payments(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- A code can only be live once; a rejected submission can be resubmitted corrected.
CREATE UNIQUE INDEX submissions_live_code ON payment_submissions(mpesa_code) WHERE status IN ('pending','clarification','approved');

CREATE TABLE submission_events (
  id             bigserial PRIMARY KEY,
  submission_id  uuid NOT NULL REFERENCES payment_submissions(id),
  event          text NOT NULL,
  note           text,
  actor_id       uuid REFERENCES users(id),
  at             timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- M-Pesa statement reconciliation
CREATE TABLE statement_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename    text NOT NULL,
  line_count  int NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE statement_lines (
  id             bigserial PRIMARY KEY,
  batch_id       uuid NOT NULL REFERENCES statement_batches(id),
  receipt        text NOT NULL,
  amount_cents   bigint NOT NULL,
  txn_time       timestamptz,
  phone          text,
  txn_type       text,
  match_status   text NOT NULL CHECK (match_status IN ('matched','unmatched','duplicate','amount_mismatch','manual_match')),
  payment_id     uuid REFERENCES payments(id),
  note           text,
  matched_by     uuid REFERENCES users(id),
  raw            jsonb
);
CREATE INDEX statement_lines_receipt_idx ON statement_lines(receipt);

-- ---------------------------------------------------------------- monthly reconciliation
CREATE TABLE reconciliation_periods (
  id             bigserial PRIMARY KEY,
  period         date NOT NULL UNIQUE CHECK (period = date_trunc('month', period)::date),
  status         recon_status NOT NULL DEFAULT 'pending',
  evidence_level text NOT NULL DEFAULT 'full' CHECK (evidence_level IN ('full','partial','incomplete')),
  is_historical  boolean NOT NULL DEFAULT false,
  snapshot       jsonb,
  prepared_by    uuid REFERENCES users(id),
  submitted_at   timestamptz,
  reviewed_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  review_note    text,
  exception_note text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discrepancies (
  id              bigserial PRIMARY KEY,
  period          date NOT NULL,
  code            text NOT NULL,
  severity        text NOT NULL DEFAULT 'material' CHECK (severity IN ('material','minor')),
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,
  description     text NOT NULL,
  status          discrepancy_status NOT NULL DEFAULT 'unresolved',
  resolution_note text,
  resolved_by     uuid REFERENCES users(id),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  UNIQUE (code, entity_type, entity_id)
);
CREATE INDEX discrepancies_status_idx ON discrepancies(status);

-- ---------------------------------------------------------------- period lock & immutability
CREATE FUNCTION assert_period_open(d date) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_periods WHERE period = date_trunc('month', d)::date AND status = 'closed') THEN
    RAISE EXCEPTION 'The reporting period % is approved and closed; record a separately authorised adjustment in the current period instead',
      to_char(d, 'Mon YYYY') USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_group_entries() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'income' THEN
    PERFORM assert_period_open(NEW.received_on);
  ELSIF TG_TABLE_NAME = 'expenditure' THEN
    PERFORM assert_period_open(NEW.spent_on);
    IF TG_OP = 'UPDATE' AND OLD.status = 'paid' AND NOT (NEW.status = 'voided' AND NEW.void_reason IS NOT NULL
       AND NEW.amount_cents = OLD.amount_cents AND NEW.recipient = OLD.recipient AND NEW.spent_on = OLD.spent_on) THEN
      RAISE EXCEPTION 'A paid expenditure cannot be edited; void it with a reason' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER income_guard BEFORE INSERT ON income FOR EACH ROW EXECUTE FUNCTION guard_group_entries();
CREATE TRIGGER income_append_only BEFORE UPDATE OR DELETE ON income FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER expenditure_guard BEFORE INSERT OR UPDATE ON expenditure FOR EACH ROW EXECUTE FUNCTION guard_group_entries();
CREATE TRIGGER expenditure_no_delete BEFORE DELETE ON expenditure FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE FUNCTION guard_recon_period() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reconciliation periods cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'closed' AND (NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.evidence_level IS DISTINCT FROM OLD.evidence_level) THEN
    RAISE EXCEPTION 'An approved reconciliation cannot be edited' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER recon_guard BEFORE UPDATE OR DELETE ON reconciliation_periods FOR EACH ROW EXECUTE FUNCTION guard_recon_period();

CREATE TRIGGER withdrawal_approvals_append_only BEFORE UPDATE OR DELETE ON withdrawal_approvals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER submission_events_append_only BEFORE UPDATE OR DELETE ON submission_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER withdrawals_no_delete BEFORE DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER meetings_no_delete BEFORE DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER attendance_no_delete BEFORE DELETE ON attendance FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE SEQUENCE withdrawal_ref_seq START 1;
CREATE SEQUENCE expenditure_ref_seq START 1;

INSERT INTO system_settings (key, value) VALUES
  ('notification_reminder_days_before', '3'),
  ('withdrawal_min_cents', '0'),
  ('withdrawal_notice_days', '0')
ON CONFLICT (key) DO NOTHING;
