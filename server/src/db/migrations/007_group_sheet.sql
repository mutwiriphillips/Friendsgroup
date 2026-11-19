-- The group's own Excel sheet is kept as an official record and displayed as it is.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_category_check;
ALTER TABLE documents ADD CONSTRAINT documents_category_check CHECK (category IN (
  'certificate_of_registration','constitution','minutes','resolution','financial_statement','policy',
  'compliance','legal','correspondence','membership','group_sheet','other'));
