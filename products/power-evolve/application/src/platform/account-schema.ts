/** V25 adds account lifecycle authority without replacing any user identity, hash, settings or history. */
export const accountSchemaV25 = `
ALTER TABLE pe_users
  ADD COLUMN display_name text,
  ADD COLUMN role text NOT NULL DEFAULT 'USER' CHECK(role IN ('ADMIN','USER')),
  ADD COLUMN enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN account_revision integer NOT NULL DEFAULT 1 CHECK(account_revision>0),
  ADD COLUMN credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version>0),
  ADD COLUMN password_change_required boolean NOT NULL DEFAULT false,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE pe_users SET display_name=username;
ALTER TABLE pe_users ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE pe_users ADD CONSTRAINT pe_users_display_name CHECK(length(display_name) BETWEEN 1 AND 200);
ALTER TABLE pe_users ADD CONSTRAINT pe_users_deleted_disabled CHECK(deleted_at IS NULL OR enabled=false);
-- Nonunique: existing case-distinct usernames retain their original login identities.
CREATE INDEX pe_users_username_folded ON pe_users(lower(username));

CREATE FUNCTION pe_account_identity_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.display_name := COALESCE(NEW.display_name,NEW.username);
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_account_identity_defaults BEFORE INSERT ON pe_users
  FOR EACH ROW EXECUTE FUNCTION pe_account_identity_defaults();
CREATE FUNCTION pe_account_identity_preserved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Account identity requires a tombstone'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'Account identity is immutable';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Account tombstone is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_account_identity_preserved BEFORE UPDATE OR DELETE ON pe_users
  FOR EACH ROW EXECUTE FUNCTION pe_account_identity_preserved();

ALTER TABLE pe_credentials ADD COLUMN credential_version integer NOT NULL DEFAULT 1 CHECK(credential_version>0);
ALTER TABLE pe_credentials DROP CONSTRAINT pe_credentials_audience_check;
ALTER TABLE pe_credentials ADD CONSTRAINT pe_credentials_audience_check CHECK(audience IN ('agent','approval','account'));
CREATE INDEX pe_credentials_user ON pe_credentials(user_id);

CREATE TABLE pe_account_bootstrap (
  singleton boolean PRIMARY KEY CHECK(singleton), user_id uuid NOT NULL REFERENCES pe_users(id),
  username text NOT NULL, mode text NOT NULL CHECK(mode IN ('create','existing')),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pe_account_mutations (
  actor_user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('create','update','delete','reset-password','change-password')),
  target_user_id uuid NOT NULL REFERENCES pe_users(id),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  -- Metadata-only digest. Password comparison uses a salted, expensive verifier of the password inputs.
  password_verifier text CHECK(password_verifier ~ '^[a-f0-9]{32}:[a-f0-9]{128}$'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=131072),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id,request_id),
  CHECK((kind='change-password' AND password_verifier IS NOT NULL)
    OR (kind<>'change-password' AND password_verifier IS NULL))
);
CREATE TABLE pe_account_audit (
  id uuid PRIMARY KEY, actor_user_id uuid NOT NULL REFERENCES pe_users(id),
  target_user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('bootstrap','create','update','delete','reset-password','change-password')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=16384),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(actor_user_id,request_id)
);
`
