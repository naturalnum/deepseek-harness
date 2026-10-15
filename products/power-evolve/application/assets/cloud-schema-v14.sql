-- Private STDIO environments are immutable versions; public configurations retain only names and an opaque version identity.
CREATE TABLE pe_stdio_v2_environment_versions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  keys json NOT NULL CHECK(json_typeof(keys)='array'),
  sealed bytea NOT NULL CHECK(octet_length(sealed)>=29),
  connection_id uuid,
  configuration_revision integer CHECK(configuration_revision>0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id),
  CHECK((connection_id IS NULL)=(configuration_revision IS NULL)),
  FOREIGN KEY(connection_id,user_id,configuration_revision)
    REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision)
);
CREATE INDEX pe_stdio_v2_environment_owner ON pe_stdio_v2_environment_versions(user_id,connection_id,configuration_revision);
CREATE TABLE pe_stdio_v2_environment_tickets (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id uuid NOT NULL,
  request json NOT NULL CHECK(json_typeof(request)='object'),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  body_digest text CHECK(body_digest ~ '^[a-f0-9]{64}$'),
  version_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(user_id,version_id) REFERENCES pe_stdio_v2_environment_versions(user_id,id),
  CHECK((body_digest IS NULL)=(version_id IS NULL))
);
CREATE INDEX pe_stdio_v2_environment_ticket_expiry ON pe_stdio_v2_environment_tickets(user_id,expires_at) WHERE consumed_at IS NULL;
CREATE TABLE pe_stdio_v2_environment_deliveries (
  action_id uuid PRIMARY KEY REFERENCES pe_stdio_v2_start_permits(action_id),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  version_id uuid NOT NULL,
  permit_id uuid NOT NULL REFERENCES pe_stdio_v2_start_permits(permit_id),
  worker_id uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK(lease_epoch>0),
  execution_id uuid NOT NULL REFERENCES pe_cloud_executions(id),
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(user_id,version_id) REFERENCES pe_stdio_v2_environment_versions(user_id,id)
);
CREATE FUNCTION pe_stdio_v2_environment_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.connection_id IS NOT NULL OR NEW.connection_id IS NULL
    OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.keys::text<>OLD.keys::text
    OR NEW.sealed<>OLD.sealed OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at THEN
    RAISE EXCEPTION 'STDIO environment version is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_stdio_v2_environment_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_environment_versions
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_environment_original();
CREATE TRIGGER pe_stdio_v2_environment_delivery_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_environment_deliveries
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
