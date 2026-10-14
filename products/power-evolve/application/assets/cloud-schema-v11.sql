-- Trusted tenant runtimes retain exact process identity until physical stop is observed.
CREATE TABLE pe_native_runtime_instances (
  runtime_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  generation integer NOT NULL CHECK (generation > 0),
  namespace text NOT NULL,
  config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  credential_id uuid REFERENCES pe_runtime_credentials(id),
  pod_uid text,
  pod_create_requested_at timestamptz,
  phase text NOT NULL CHECK (phase IN ('creating','ready','stopping','stopped')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  stop_proof jsonb,
  UNIQUE (user_id,generation)
);
CREATE UNIQUE INDEX pe_native_runtime_one_live_account ON pe_native_runtime_instances(user_id) WHERE phase <> 'stopped';
CREATE FUNCTION pe_native_runtime_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_id IS DISTINCT FROM OLD.runtime_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.namespace IS DISTINCT FROM OLD.namespace OR NEW.config_digest IS DISTINCT FROM OLD.config_digest
    OR OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid
    OR OLD.credential_id IS NOT NULL AND NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR OLD.pod_create_requested_at IS NOT NULL AND NEW.pod_create_requested_at IS DISTINCT FROM OLD.pod_create_requested_at
    OR OLD.stop_proof IS NOT NULL AND NEW.stop_proof IS DISTINCT FROM OLD.stop_proof THEN
    RAISE EXCEPTION 'Native runtime process identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_runtime_identity_immutable BEFORE UPDATE ON pe_native_runtime_instances
  FOR EACH ROW EXECUTE FUNCTION pe_native_runtime_identity_immutable();
