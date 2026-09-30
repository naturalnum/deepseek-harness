/** V24 preserves historical SSH targets and ciphertext while adding versioned management receipts. */
export const sshSchemaV24 = `
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pe_ssh_upload_intents i JOIN pe_ssh_updates u
    ON u.user_id=i.user_id AND u.request_id=i.request_id) THEN
    RAISE EXCEPTION 'SSH migration: request identity reused across create and toggle';
  END IF;
END $$;

CREATE TEMP TABLE pe_ssh_migration_versions ON COMMIT DROP AS
  SELECT user_id,id AS connection_id,revision,credential_revision FROM pe_ssh_connections
  UNION SELECT user_id,connection_id,connection_revision,credential_revision FROM pe_ssh_calls
  UNION SELECT user_id,connection_id,connection_revision,credential_revision FROM pe_ssh_execute_actions
  UNION SELECT s.user_id,(v->>'connectionId')::uuid,(v->>'revision')::integer,
      (v->>'credentialRevision')::integer
    FROM pe_operations o JOIN pe_sessions s ON s.id=o.session_id
      CROSS JOIN LATERAL jsonb_array_elements(o.ssh_selection) v
  UNION SELECT user_id,connection_id,(result->>'revision')::integer,
      (result->>'credentialRevision')::integer FROM pe_ssh_updates
  UNION SELECT user_id,(result->'item'->>'connectionId')::uuid,
      (result->'item'->>'revision')::integer,(result->'item'->>'credentialRevision')::integer
    FROM pe_ssh_upload_intents WHERE result IS NOT NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pe_ssh_migration_versions v
    LEFT JOIN pe_ssh_connections c ON c.id=v.connection_id AND c.user_id=v.user_id
    WHERE c.id IS NULL OR v.revision IS NULL OR v.revision<1
      OR v.credential_revision IS DISTINCT FROM c.credential_revision) THEN
    RAISE EXCEPTION 'SSH migration: historical identity or credential version is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM (
      SELECT user_id,result AS item FROM pe_ssh_updates
      UNION ALL SELECT user_id,result->'item' FROM pe_ssh_upload_intents WHERE result IS NOT NULL
    ) r JOIN pe_ssh_connections c ON c.id=(r.item->>'connectionId')::uuid AND c.user_id=r.user_id
    WHERE r.item->>'displayName' IS DISTINCT FROM c.display_name
      OR r.item->>'host' IS DISTINCT FROM c.host OR (r.item->>'port')::integer IS DISTINCT FROM c.port
      OR r.item->>'username' IS DISTINCT FROM c.username
      OR r.item->>'hostKeySha256' IS DISTINCT FROM c.host_key_sha256) THEN
    RAISE EXCEPTION 'SSH migration: historical target differs from the available configuration';
  END IF;
END $$;

ALTER TABLE pe_ssh_connections ADD COLUMN deleted_at timestamptz;
ALTER TABLE pe_ssh_connections ADD CONSTRAINT pe_ssh_deleted_disabled CHECK(deleted_at IS NULL OR enabled=false);
ALTER TABLE pe_ssh_connections DROP CONSTRAINT pe_ssh_connections_credential_kind_check;
ALTER TABLE pe_ssh_connections ADD CONSTRAINT pe_ssh_connections_credential_kind_check
  CHECK(credential_kind IN ('password','private_key'));

CREATE TABLE pe_ssh_credential_versions (
  connection_id uuid NOT NULL, user_id uuid NOT NULL,
  credential_revision integer NOT NULL CHECK(credential_revision>0),
  credential_kind text NOT NULL CHECK(credential_kind IN ('password','private_key')),
  format_version integer NOT NULL CHECK(format_version IN (1,2)), aad_request_id uuid,
  encrypted_credential bytea NOT NULL CHECK(octet_length(encrypted_credential) BETWEEN 29 AND 65564),
  passphrase_configured boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,credential_revision), UNIQUE(connection_id,user_id,credential_revision),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_ssh_connections(id,user_id),
  CHECK((format_version=1 AND credential_kind='password' AND aad_request_id IS NOT NULL AND NOT passphrase_configured)
    OR (format_version=2 AND aad_request_id IS NULL)),
  CHECK(credential_kind='private_key' OR NOT passphrase_configured)
);
CREATE TABLE pe_ssh_configuration_versions (
  connection_id uuid NOT NULL, user_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  credential_revision integer NOT NULL CHECK(credential_revision>0),
  display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
  host text NOT NULL CHECK(length(host) BETWEEN 1 AND 253), port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
  username text NOT NULL CHECK(length(username) BETWEEN 1 AND 100),
  host_key_sha256 text NOT NULL CHECK(host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  working_directory text CHECK(working_directory IS NULL OR
    (length(working_directory) BETWEEN 1 AND 1024 AND working_directory !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,revision),
  UNIQUE(connection_id,user_id,revision,credential_revision),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_ssh_connections(id,user_id),
  FOREIGN KEY(connection_id,user_id,credential_revision)
    REFERENCES pe_ssh_credential_versions(connection_id,user_id,credential_revision)
);
INSERT INTO pe_ssh_credential_versions(connection_id,user_id,credential_revision,credential_kind,
  format_version,aad_request_id,encrypted_credential,created_at)
  SELECT id,user_id,credential_revision,credential_kind,1,install_request_id,encrypted_credential,created_at
  FROM pe_ssh_connections;
INSERT INTO pe_ssh_configuration_versions(connection_id,user_id,revision,credential_revision,
  display_name,host,port,username,host_key_sha256,working_directory,created_at)
  SELECT v.connection_id,v.user_id,v.revision,v.credential_revision,
    c.display_name,c.host,c.port,c.username,c.host_key_sha256,NULL,c.created_at
  FROM pe_ssh_migration_versions v JOIN pe_ssh_connections c ON c.id=v.connection_id AND c.user_id=v.user_id;
ALTER TABLE pe_ssh_connections ADD CONSTRAINT pe_ssh_current_configuration
  FOREIGN KEY(id,user_id,revision,credential_revision)
    REFERENCES pe_ssh_configuration_versions(connection_id,user_id,revision,credential_revision)
    DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pe_ssh_calls ADD CONSTRAINT pe_ssh_call_configuration
  FOREIGN KEY(connection_id,user_id,connection_revision,credential_revision)
    REFERENCES pe_ssh_configuration_versions(connection_id,user_id,revision,credential_revision);
ALTER TABLE pe_ssh_execute_actions ADD CONSTRAINT pe_ssh_action_configuration
  FOREIGN KEY(connection_id,user_id,connection_revision,credential_revision)
    REFERENCES pe_ssh_configuration_versions(connection_id,user_id,revision,credential_revision);

CREATE TABLE pe_ssh_management_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('create','update','toggle','delete')),
  request_format_version integer NOT NULL CHECK(request_format_version IN (1,2)),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'), input jsonb NOT NULL,
  connection_id uuid, base_revision integer CHECK(base_revision>0),
  base_credential_revision integer CHECK(base_credential_revision>0),
  size_bytes integer CHECK(size_bytes BETWEEN 1 AND 65536),
  secret_digest text CHECK(secret_digest ~ '^[a-f0-9]{64}$'), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(user_id,request_id), FOREIGN KEY(connection_id,user_id) REFERENCES pe_ssh_connections(id,user_id),
  CHECK((result IS NULL)=(completed_at IS NULL)), CHECK(result IS NULL OR connection_id IS NOT NULL),
  CHECK((purpose='create' AND base_revision IS NULL AND base_credential_revision IS NULL)
    OR (purpose<>'create' AND base_revision IS NOT NULL AND base_credential_revision IS NOT NULL))
);
INSERT INTO pe_ssh_management_requests(user_id,request_id,purpose,request_format_version,request_digest,
  input,connection_id,size_bytes,secret_digest,result,created_at,completed_at)
  SELECT i.user_id,i.request_id,'create',1,i.request_digest,i.config,
    CASE WHEN i.result IS NOT NULL THEN (i.result->'item'->>'connectionId')::uuid END,
    i.size_bytes,i.secret_digest,
    CASE WHEN i.result IS NOT NULL THEN (i.result->'item') || jsonb_build_object(
      'workingDirectory',NULL,'authentication','password','secretConfigured',true,'passphraseConfigured',false,
      'deletedAt',NULL,'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt',to_char(i.consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END,
    i.created_at,CASE WHEN i.result IS NOT NULL THEN i.consumed_at END
  FROM pe_ssh_upload_intents i LEFT JOIN pe_ssh_connections c
    ON c.id=(i.result->'item'->>'connectionId')::uuid AND c.user_id=i.user_id;
INSERT INTO pe_ssh_management_requests(user_id,request_id,purpose,request_format_version,request_digest,
  input,connection_id,base_revision,base_credential_revision,result,created_at,completed_at)
  SELECT u.user_id,u.request_id,'toggle',1,u.request_digest,
    jsonb_build_object('connectionId',u.connection_id,'baseRevision',(u.result->>'revision')::integer-1,
      'enabled',(u.result->>'enabled')::boolean),u.connection_id,(u.result->>'revision')::integer-1,
    (u.result->>'credentialRevision')::integer,u.result || jsonb_build_object(
      'workingDirectory',NULL,'authentication','password','secretConfigured',true,'passphraseConfigured',false,
      'deletedAt',NULL,'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt',to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    u.created_at,u.created_at
  FROM pe_ssh_updates u JOIN pe_ssh_connections c ON c.id=u.connection_id AND c.user_id=u.user_id;
ALTER TABLE pe_ssh_upload_intents ADD COLUMN format_version integer NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
ALTER TABLE pe_ssh_upload_intents ADD COLUMN purpose text NOT NULL DEFAULT 'create' CHECK(purpose IN ('create','update'));
ALTER TABLE pe_ssh_upload_intents ADD COLUMN verification_failures integer NOT NULL DEFAULT 0 CHECK(verification_failures>=0);
UPDATE pe_ssh_upload_intents SET verification_failures=COALESCE((result->>'failedVerifications')::integer,0);
ALTER TABLE pe_ssh_upload_intents DROP CONSTRAINT pe_ssh_upload_intents_size_bytes_check;
ALTER TABLE pe_ssh_upload_intents ADD CONSTRAINT pe_ssh_upload_intents_size_bytes_check CHECK(size_bytes BETWEEN 1 AND 65536);
ALTER TABLE pe_ssh_upload_intents ADD CONSTRAINT pe_ssh_upload_request
  FOREIGN KEY(user_id,request_id) REFERENCES pe_ssh_management_requests(user_id,request_id);

CREATE FUNCTION pe_ssh_reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SSH versions are immutable'; END; $$;
CREATE TRIGGER pe_ssh_configuration_immutable BEFORE UPDATE OR DELETE ON pe_ssh_configuration_versions
  FOR EACH ROW EXECUTE FUNCTION pe_ssh_reject_version_update();
CREATE TRIGGER pe_ssh_credential_immutable BEFORE UPDATE OR DELETE ON pe_ssh_credential_versions
  FOR EACH ROW EXECUTE FUNCTION pe_ssh_reject_version_update();
`
