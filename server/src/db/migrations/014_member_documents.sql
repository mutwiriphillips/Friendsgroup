-- Member photo (photo_file_id already exists) and both sides of the identity card.
ALTER TABLE members ADD COLUMN id_front_file_id uuid REFERENCES stored_files(id);
ALTER TABLE members ADD COLUMN id_back_file_id  uuid REFERENCES stored_files(id);
