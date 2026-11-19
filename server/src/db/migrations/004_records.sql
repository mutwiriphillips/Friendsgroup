-- Governance and compliance records: certificate of registration, constitution, minutes, resolutions, returns, etc.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_category_check;
ALTER TABLE documents ADD CONSTRAINT documents_category_check CHECK (category IN (
  'certificate_of_registration','constitution','minutes','resolution','financial_statement','policy',
  'compliance','legal','correspondence','membership','other'));

ALTER TABLE documents
  ADD COLUMN description   text,
  ADD COLUMN reference_no  text,
  ADD COLUMN document_date date,
  ADD COLUMN expires_on    date,
  ADD COLUMN version       int  NOT NULL DEFAULT 1,
  ADD COLUMN status        text NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded','archived')),
  ADD COLUMN supersedes_id uuid REFERENCES documents(id),
  ADD COLUMN archived_reason text;

UPDATE documents SET document_date = (created_at AT TIME ZONE 'Africa/Nairobi')::date WHERE document_date IS NULL;

-- Records are never deleted: replace with a new version, or archive with a reason.
CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE INDEX documents_category_idx ON documents(category, status);

UPDATE system_settings SET value = '"Friends Self Help Group"' WHERE key = 'group_name' AND value = '"Members Savings Group"';
