-- The Next of Kin & Beneficiary Nomination Form. One current form per member. Once submitted it is read-only to the member;
-- only the administrator can amend it, and every amendment is kept in the revision history.
CREATE TABLE next_of_kin_forms (
  member_id     uuid PRIMARY KEY REFERENCES members(id),
  data_enc      text NOT NULL, -- the whole form, encrypted (it holds other people's ID numbers)
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  submitted_by  uuid REFERENCES users(id),
  submitted_via text NOT NULL CHECK (submitted_via IN ('member','administrator')),
  revision      integer NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id)
);
CREATE TABLE next_of_kin_revisions (
  id          bigserial PRIMARY KEY,
  member_id   uuid NOT NULL REFERENCES members(id),
  revision    integer NOT NULL,
  data_enc    text NOT NULL,
  note        text,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER next_of_kin_revisions_no_update BEFORE UPDATE ON next_of_kin_revisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER next_of_kin_revisions_no_delete BEFORE DELETE ON next_of_kin_revisions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER next_of_kin_forms_no_delete BEFORE DELETE ON next_of_kin_forms FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- A profile is compliant only when identity, contact and the submitted next of kin form are all on file.
ALTER TABLE members ADD COLUMN nok_submitted_at timestamptz;
ALTER TABLE members DROP COLUMN profile_complete;
ALTER TABLE members ADD COLUMN profile_complete boolean
  GENERATED ALWAYS AS (national_id_enc IS NOT NULL AND phone IS NOT NULL AND nok_submitted_at IS NOT NULL) STORED;
CREATE INDEX members_profile_incomplete_idx ON members(profile_complete) WHERE NOT profile_complete;
