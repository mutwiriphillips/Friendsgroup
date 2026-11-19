-- Members can be imported "as is" with missing details and completed later.
ALTER TABLE members ALTER COLUMN national_id_enc DROP NOT NULL;
ALTER TABLE members ALTER COLUMN national_id_hash DROP NOT NULL;
ALTER TABLE members ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE members ALTER COLUMN mpesa_phone DROP NOT NULL;

-- Details we could not accept as given (bad format, duplicate ID...) are kept verbatim here so nothing is lost.
ALTER TABLE members ADD COLUMN import_issues jsonb;
ALTER TABLE members ADD COLUMN imported_at timestamptz;
ALTER TABLE members ADD COLUMN profile_completed_at timestamptz;

-- A profile is complete when the identity and contact details required for compliance are on file.
ALTER TABLE members ADD COLUMN profile_complete boolean
  GENERATED ALWAYS AS (national_id_enc IS NOT NULL AND phone IS NOT NULL) STORED;
CREATE INDEX members_profile_incomplete_idx ON members(profile_complete) WHERE NOT profile_complete;
