-- Owned source-only Schema37 fixture; never execute against a real source.

-- schema

CREATE TABLE IF NOT EXISTS pe_schema (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS pe_users (
  id uuid PRIMARY KEY, username text UNIQUE NOT NULL,
  password_hash text NOT NULL, settings jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS pe_credentials (
  digest text PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  audience text NOT NULL CHECK (audience = 'agent'), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS pe_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), create_request_id uuid NOT NULL,
  header jsonb NOT NULL, event_count integer NOT NULL DEFAULT 0, event_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  lease_epoch integer NOT NULL DEFAULT 0, lease_until timestamptz, grant_digest text,
  UNIQUE (user_id, create_request_id)
);
CREATE TABLE IF NOT EXISTS pe_operations (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES pe_sessions(id),
  request_id uuid NOT NULL, input text NOT NULL, settings jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(session_id, request_id)
);
CREATE TABLE IF NOT EXISTS pe_attempts (
  operation_id uuid NOT NULL REFERENCES pe_operations(id), epoch integer NOT NULL,
  worker_id uuid NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  PRIMARY KEY (operation_id, epoch)
);
CREATE TABLE IF NOT EXISTS pe_events (
  session_id uuid NOT NULL REFERENCES pe_sessions(id), seq integer NOT NULL,
  event jsonb NOT NULL, PRIMARY KEY(session_id, seq)
);
CREATE INDEX IF NOT EXISTS pe_operations_pending ON pe_operations (created_at) WHERE state IN ('queued','running');
CREATE INDEX IF NOT EXISTS pe_sessions_user ON pe_sessions (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pe_sessions_grant ON pe_sessions (grant_digest) WHERE grant_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS pe_credentials_expiration ON pe_credentials (expires_at);

INSERT INTO pe_schema(version) VALUES(1);

-- schemaV2

CREATE TABLE pe_workspaces (
  id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES pe_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_file_mutations (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES pe_workspaces(id), path text NOT NULL,
  digest text NOT NULL, base_digest text, mime text NOT NULL, size bigint NOT NULL,
  PRIMARY KEY (user_id,request_id)
);
CREATE TABLE pe_user_skills (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  name text NOT NULL, description text NOT NULL, digest text NOT NULL,
  enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id,name)
);
ALTER TABLE pe_operations ADD COLUMN skill_selection jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX pe_user_skills_user ON pe_user_skills(user_id,name);
UPDATE pe_schema SET version=2 WHERE version=1;


-- schemaV3

ALTER TABLE pe_credentials DROP CONSTRAINT pe_credentials_audience_check;
ALTER TABLE pe_credentials ADD CONSTRAINT pe_credentials_audience_check CHECK (audience IN ('agent','approval'));
CREATE TABLE pe_connector_actions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), operation_id uuid NOT NULL REFERENCES pe_operations(id),
  call_id text NOT NULL, action text NOT NULL CHECK (action IN ('trial_note_append')),
  request jsonb NOT NULL, request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','rejected','approved','dispatching','succeeded','failed','uncertain')),
  result jsonb, error_code text, decided_at timestamptz,
  lease_owner uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_id), UNIQUE(operation_id,action,request_digest)
);
CREATE TABLE pe_connector_permissions (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  capability text NOT NULL CHECK (capability IN ('trial_note_query','trial_note_append')),
  enabled boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,capability)
);
CREATE INDEX pe_connector_actions_user ON pe_connector_actions(user_id,created_at DESC);
CREATE INDEX pe_connector_actions_dispatch ON pe_connector_actions(created_at)
  WHERE state IN ('approved','dispatching','uncertain');
UPDATE pe_schema SET version=3 WHERE version=2;


-- schemaV4

ALTER TABLE pe_operations ADD COLUMN source text NOT NULL DEFAULT 'user'
  CHECK (source IN ('user','platform_action'));
ALTER TABLE pe_connector_actions ADD COLUMN continuation_request_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX pe_connector_actions_continuation ON pe_connector_actions(continuation_request_id);
ALTER TABLE pe_operations ADD COLUMN source_action_id uuid REFERENCES pe_connector_actions(id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action
  CHECK ((source='user' AND source_action_id IS NULL) OR (source='platform_action' AND source_action_id IS NOT NULL));
UPDATE pe_schema SET version=4 WHERE version=3;


-- schemaV5

CREATE TABLE pe_sandbox_instances (
  session_id uuid PRIMARY KEY REFERENCES pe_sessions(id), user_id uuid NOT NULL REFERENCES pe_users(id),
  name text UNIQUE NOT NULL, state text NOT NULL CHECK (state IN ('creating','ready','deleting','deleted','unknown')),
  pod_uid uuid, runner_instance_id uuid, last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_cloud_executions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), operation_id uuid NOT NULL REFERENCES pe_operations(id),
  call_id text NOT NULL, command text NOT NULL, cwd text NOT NULL, request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','starting','running','cancelling','succeeded','failed','cancelled','uncertain')),
  cancel_requested boolean NOT NULL DEFAULT false, result jsonb, error_code text,
  sandbox_name text, pod_uid uuid, runner_instance_id uuid,
  lease_owner uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  continuation_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_id), UNIQUE(continuation_request_id)
);
CREATE UNIQUE INDEX pe_cloud_executions_one_live_per_session ON pe_cloud_executions(session_id)
  WHERE state IN ('queued','starting','running','cancelling','uncertain');
CREATE INDEX pe_cloud_executions_user ON pe_cloud_executions(user_id,created_at DESC);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK (source IN ('user','platform_action','sandbox_result'));
ALTER TABLE pe_operations ADD COLUMN source_execution_id uuid REFERENCES pe_cloud_executions(id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK (
  (source='user' AND source_action_id IS NULL AND source_execution_id IS NULL)
  OR (source='platform_action' AND source_action_id IS NOT NULL AND source_execution_id IS NULL)
  OR (source='sandbox_result' AND source_action_id IS NULL AND source_execution_id IS NOT NULL));
UPDATE pe_schema SET version=5 WHERE version=4;


-- schemaV6

ALTER TABLE pe_sandbox_instances ADD COLUMN stop_pod_uid uuid;
ALTER TABLE pe_sandbox_instances ADD COLUMN stop_evidence jsonb;
UPDATE pe_schema SET version=6 WHERE version=5;


-- schemaV7

CREATE TABLE pe_device_pairings (
  digest text PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_devices (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  name text NOT NULL, token_digest text UNIQUE NOT NULL, instance_id uuid NOT NULL,
  last_seen_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pe_devices_user ON pe_devices(user_id,created_at DESC);
CREATE TABLE pe_device_directories (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES pe_devices(id),
  user_id uuid NOT NULL REFERENCES pe_users(id), label text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pe_device_directories_user ON pe_device_directories(user_id,created_at DESC);
ALTER TABLE pe_operations ADD COLUMN execution_target jsonb NOT NULL DEFAULT '{"kind":"cloud"}'::jsonb;
CREATE TABLE pe_desktop_executions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), operation_id uuid NOT NULL REFERENCES pe_operations(id),
  device_id uuid NOT NULL REFERENCES pe_devices(id), directory_id uuid NOT NULL REFERENCES pe_device_directories(id),
  call_id text NOT NULL, command text NOT NULL, cwd text NOT NULL, request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled','uncertain')),
  cancel_requested boolean NOT NULL DEFAULT false, result jsonb, error_code text,
  device_instance_id uuid, continuation_request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_id), UNIQUE(continuation_request_id)
);
CREATE UNIQUE INDEX pe_desktop_executions_one_live_per_session ON pe_desktop_executions(session_id)
  WHERE state IN ('queued','running','cancelling','uncertain');
CREATE INDEX pe_desktop_executions_device ON pe_desktop_executions(device_id,created_at)
  WHERE state IN ('queued','running','cancelling');
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK (source IN ('user','platform_action','sandbox_result','desktop_result'));
ALTER TABLE pe_operations ADD COLUMN source_desktop_execution_id uuid REFERENCES pe_desktop_executions(id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK (
  (source='user' AND source_action_id IS NULL AND source_execution_id IS NULL AND source_desktop_execution_id IS NULL)
  OR (source='platform_action' AND source_action_id IS NOT NULL AND source_execution_id IS NULL AND source_desktop_execution_id IS NULL)
  OR (source='sandbox_result' AND source_action_id IS NULL AND source_execution_id IS NOT NULL AND source_desktop_execution_id IS NULL)
  OR (source='desktop_result' AND source_action_id IS NULL AND source_execution_id IS NULL AND source_desktop_execution_id IS NOT NULL));
UPDATE pe_schema SET version=7 WHERE version=6;


-- schemaV8

ALTER TABLE pe_users ADD COLUMN last_claim_at timestamptz;
UPDATE pe_schema SET version=8 WHERE version=7;


-- schemaV9

ALTER TABLE pe_workspaces ADD COLUMN title text NOT NULL DEFAULT 'Workspace'
  CHECK (length(title) BETWEEN 1 AND 80);
ALTER TABLE pe_workspaces ADD COLUMN is_default boolean NOT NULL DEFAULT true;
ALTER TABLE pe_workspaces ADD COLUMN create_request_id uuid;
ALTER TABLE pe_workspaces DROP CONSTRAINT pe_workspaces_user_id_key;
CREATE UNIQUE INDEX pe_workspaces_default_user ON pe_workspaces(user_id) WHERE is_default;
CREATE UNIQUE INDEX pe_workspaces_create_request ON pe_workspaces(user_id,create_request_id)
  WHERE create_request_id IS NOT NULL;
CREATE UNIQUE INDEX pe_workspaces_owned_id ON pe_workspaces(id,user_id);
INSERT INTO pe_workspaces(id,user_id,title,is_default)
  SELECT gen_random_uuid(),u.id,'Workspace',true FROM pe_users u
  WHERE NOT EXISTS (SELECT 1 FROM pe_workspaces w WHERE w.user_id=u.id AND w.is_default);
ALTER TABLE pe_sessions ADD COLUMN workspace_id uuid;
UPDATE pe_sessions s SET workspace_id=w.id FROM pe_workspaces w WHERE w.user_id=s.user_id AND w.is_default;
ALTER TABLE pe_sessions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE pe_sessions ADD CONSTRAINT pe_sessions_owned_workspace
  FOREIGN KEY (workspace_id,user_id) REFERENCES pe_workspaces(id,user_id);
CREATE FUNCTION pe_session_workspace_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'Session Workspace is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_session_workspace_immutable BEFORE UPDATE OF workspace_id ON pe_sessions
  FOR EACH ROW EXECUTE FUNCTION pe_session_workspace_immutable();
CREATE UNIQUE INDEX pe_sessions_owned_workspace_id ON pe_sessions(id,user_id,workspace_id);
CREATE INDEX pe_sessions_workspace ON pe_sessions(workspace_id,updated_at DESC,id);
CREATE TABLE pe_mount_slots (
  user_id uuid PRIMARY KEY REFERENCES pe_users(id),
  session_id uuid, workspace_id uuid,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation>=0),
  state text NOT NULL DEFAULT 'free' CHECK (state IN ('free','reserved','ready','stopping','unknown')),
  pod_uid uuid, runner_instance_id uuid, stop_pod_uid uuid, stop_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id,user_id,workspace_id) REFERENCES pe_sessions(id,user_id,workspace_id),
  CHECK ((state='free' AND session_id IS NULL AND workspace_id IS NULL
      AND pod_uid IS NULL AND runner_instance_id IS NULL)
    OR (state='reserved' AND session_id IS NOT NULL AND workspace_id IS NOT NULL
      AND pod_uid IS NULL AND runner_instance_id IS NULL)
    OR (state IN ('ready','stopping') AND session_id IS NOT NULL AND workspace_id IS NOT NULL
      AND pod_uid IS NOT NULL AND runner_instance_id IS NOT NULL)
    OR (state='unknown' AND session_id IS NOT NULL AND workspace_id IS NOT NULL)),
  CHECK ((stop_pod_uid IS NULL) = (stop_evidence IS NULL))
);
ALTER TABLE pe_sandbox_instances DROP CONSTRAINT pe_sandbox_instances_name_key;
CREATE UNIQUE INDEX pe_sandbox_instances_live_name ON pe_sandbox_instances(name)
  WHERE state IN ('creating','ready','deleting','unknown');
INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,
  pod_uid,runner_instance_id,stop_pod_uid,stop_evidence)
  SELECT i.user_id,i.session_id,s.workspace_id,0,'unknown',
    i.pod_uid,i.runner_instance_id,i.stop_pod_uid,i.stop_evidence
  FROM pe_sandbox_instances i JOIN pe_sessions s ON s.id=i.session_id
  WHERE i.state IN ('creating','ready','deleting','unknown');
UPDATE pe_schema SET version=9 WHERE version=8;


-- schemaV10

CREATE TABLE pe_artifacts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  request_id uuid NOT NULL,
  source_path text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY (workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY (session_id,user_id,workspace_id) REFERENCES pe_sessions(id,user_id,workspace_id)
);
CREATE INDEX pe_artifacts_user_page ON pe_artifacts(user_id,created_at DESC,id DESC);
CREATE INDEX pe_artifacts_workspace_page ON pe_artifacts(workspace_id,created_at DESC,id DESC);
UPDATE pe_schema SET version=10 WHERE version=9;


-- schemaV11

CREATE TABLE pe_user_models (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 100),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  max_tokens integer NOT NULL CHECK (max_tokens BETWEEN 1 AND 8192),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY(user_id,model_id)
);
CREATE TABLE pe_settings_mutations (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id)
);
INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
  SELECT id,settings->>'model',settings->>'model',(settings->>'maxTokens')::integer,true FROM pe_users;
UPDATE pe_schema SET version=11 WHERE version=10;


-- schemaV12

ALTER TABLE pe_user_skills ADD COLUMN kind text NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text','package'));
ALTER TABLE pe_user_skills ADD COLUMN package_version_id uuid;
ALTER TABLE pe_user_skills ADD COLUMN revoked_at timestamptz;
ALTER TABLE pe_user_skills ADD CONSTRAINT pe_user_skills_id_user UNIQUE(id,user_id);
CREATE TABLE pe_skill_package_versions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  skill_id uuid NOT NULL,
  name text NOT NULL, description text NOT NULL, version text NOT NULL,
  archive_digest text NOT NULL, archive_size integer NOT NULL,
  instruction_digest text NOT NULL,
  manifest_digest text NOT NULL, manifest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id), UNIQUE(user_id,name,version), UNIQUE(user_id,archive_digest),
  FOREIGN KEY(skill_id,user_id) REFERENCES pe_user_skills(id,user_id)
);
CREATE INDEX pe_skill_package_versions_skill ON pe_skill_package_versions(skill_id,created_at);
ALTER TABLE pe_user_skills ADD CONSTRAINT pe_user_skills_package_version
  FOREIGN KEY(package_version_id,user_id) REFERENCES pe_skill_package_versions(id,user_id);
CREATE TABLE pe_skill_upload_intents (
  request_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  archive_digest text NOT NULL, token_digest text UNIQUE,
  expires_at timestamptz, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pe_skill_upload_intents_expiry ON pe_skill_upload_intents(expires_at);
UPDATE pe_schema SET version=12 WHERE version=11;


-- schemaV13

CREATE TABLE pe_user_plugins (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  plugin_id text NOT NULL CHECK (plugin_id IN ('notes')),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,plugin_id)
);
CREATE TABLE pe_plugin_mutations (
  user_id uuid NOT NULL,
  plugin_id text NOT NULL,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_enabled boolean NOT NULL,
  result_revision integer NOT NULL CHECK (result_revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(user_id,plugin_id) REFERENCES pe_user_plugins(user_id,plugin_id)
);
INSERT INTO pe_user_plugins(user_id,plugin_id,enabled,revision)
  SELECT id,'notes',true,1 FROM pe_users;
UPDATE pe_schema SET version=13 WHERE version=12;


-- schemaV14

CREATE TABLE pe_mcp_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES pe_users(id),
  install_request_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,install_request_id), UNIQUE(id,user_id)
);
CREATE TABLE pe_mcp_updates (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_connections(id,user_id)
);
ALTER TABLE pe_operations ADD COLUMN mcp_selection jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE pe_schema SET version=14 WHERE version=13;


-- schemaV15

CREATE TABLE pe_ssh_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  install_request_id uuid NOT NULL,
  install_digest text NOT NULL CHECK (install_digest ~ '^[a-f0-9]{64}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 100),
  host_key_sha256 text NOT NULL CHECK (host_key_sha256 ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  credential_kind text NOT NULL CHECK (credential_kind='password'),
  credential_revision integer NOT NULL DEFAULT 1 CHECK (credential_revision>0),
  encrypted_credential bytea NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,install_request_id), UNIQUE(id,user_id)
);
CREATE INDEX pe_ssh_connections_user ON pe_ssh_connections(user_id,created_at DESC);
CREATE TABLE pe_ssh_upload_intents (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  config jsonb NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8192),
  secret_digest text CHECK (secret_digest IS NULL OR secret_digest ~ '^[a-f0-9]{64}$'),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pe_ssh_upload_intents_user ON pe_ssh_upload_intents(user_id,expires_at DESC);
CREATE TABLE pe_ssh_updates (
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_ssh_connections(id,user_id)
);
UPDATE pe_schema SET version=15 WHERE version=14;


-- schemaV16

CREATE TABLE pe_ssh_calls (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision>0),
  credential_revision integer NOT NULL CHECK (credential_revision>0),
  operation_id uuid REFERENCES pe_operations(id),
  kind text NOT NULL CHECK (kind IN ('ssh.authenticate','ssh.execute')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('accepted','preparing','ready','dispatch-intent','running',
    'succeeded','failed','uncertain','cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  cleanup_complete boolean NOT NULL DEFAULT false,
  destination jsonb,
  pod_uid uuid,
  runner_instance_id uuid,
  dispatch_digest text CHECK (dispatch_digest IS NULL OR dispatch_digest ~ '^[a-f0-9]{64}$'),
  dispatch_owner uuid,
  dispatch_epoch integer CHECK (dispatch_epoch IS NULL OR dispatch_epoch>0),
  result jsonb,
  error_code text,
  lease_owner uuid,
  lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_ssh_connections(id,user_id),
  CHECK ((kind='ssh.authenticate' AND operation_id IS NULL)
    OR (kind='ssh.execute' AND operation_id IS NOT NULL)),
  CHECK ((pod_uid IS NULL AND runner_instance_id IS NULL)
    OR (pod_uid IS NOT NULL AND runner_instance_id IS NOT NULL AND destination IS NOT NULL)),
  CHECK ((dispatch_digest IS NULL AND dispatch_owner IS NULL AND dispatch_epoch IS NULL)
    OR (dispatch_digest IS NOT NULL AND dispatch_owner IS NOT NULL AND dispatch_epoch IS NOT NULL
      AND pod_uid IS NOT NULL AND runner_instance_id IS NOT NULL)),
  CHECK (state NOT IN ('ready','dispatch-intent','running') OR pod_uid IS NOT NULL),
  CHECK (state NOT IN ('dispatch-intent','running') OR dispatch_digest IS NOT NULL)
);
CREATE INDEX pe_ssh_calls_claim ON pe_ssh_calls(created_at,id)
  WHERE state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain');
CREATE INDEX pe_ssh_calls_user ON pe_ssh_calls(user_id,created_at DESC,id DESC);
UPDATE pe_schema SET version=16 WHERE version=15;


-- schemaV17

CREATE TABLE pe_stdio_mcp_connections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL UNIQUE REFERENCES pe_users(id),
  install_request_id uuid NOT NULL, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true, revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id), UNIQUE(user_id,install_request_id)
);
CREATE TABLE pe_stdio_mcp_updates (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  connection_id uuid NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_stdio_mcp_connections(id,user_id)
);
CREATE TABLE pe_stdio_mcp_calls (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  operation_id uuid NOT NULL REFERENCES pe_operations(id),
  connection_id uuid NOT NULL, connection_revision integer NOT NULL CHECK (connection_revision>0),
  call_key text NOT NULL CHECK (length(call_key) BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('accepted','preparing','ready','dispatch-intent','running',
    'succeeded','failed','uncertain')),
  pod_uid uuid, runner_instance_id uuid,
  dispatch_digest text CHECK (dispatch_digest IS NULL OR dispatch_digest ~ '^[a-f0-9]{64}$'),
  result text CHECK (result IS NULL OR octet_length(result)<=8192), error_code text,
  cleanup_complete boolean NOT NULL DEFAULT false,
  lease_owner uuid, lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch>=0), lease_until timestamptz,
  continuation_request_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_key),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_stdio_mcp_connections(id,user_id),
  CHECK ((pod_uid IS NULL AND runner_instance_id IS NULL)
    OR (pod_uid IS NOT NULL AND runner_instance_id IS NOT NULL)),
  CHECK (state NOT IN ('ready','dispatch-intent','running') OR pod_uid IS NOT NULL),
  CHECK (state NOT IN ('dispatch-intent','running') OR dispatch_digest IS NOT NULL)
);
CREATE INDEX pe_stdio_mcp_calls_claim ON pe_stdio_mcp_calls(created_at,id)
  WHERE state IN ('accepted','preparing','ready','dispatch-intent','running');
CREATE INDEX pe_stdio_mcp_calls_cleanup ON pe_stdio_mcp_calls(updated_at,id)
  WHERE cleanup_complete=false AND state IN ('succeeded','failed','uncertain');
ALTER TABLE pe_operations ADD COLUMN stdio_mcp_selection jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pe_operations ADD COLUMN source_stdio_mcp_call_id uuid REFERENCES pe_stdio_mcp_calls(id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK (source IN ('user','platform_action','sandbox_result','desktop_result','stdio_mcp_result'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK (
  (source='user' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL)
  OR (source='platform_action' AND source_action_id IS NOT NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL)
  OR (source='sandbox_result' AND source_action_id IS NULL AND source_execution_id IS NOT NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL)
  OR (source='desktop_result' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NOT NULL AND source_stdio_mcp_call_id IS NULL)
  OR (source='stdio_mcp_result' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NOT NULL));
UPDATE pe_schema SET version=17 WHERE version=16;


-- schemaV18

CREATE TABLE pe_ssh_execute_actions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  operation_id uuid NOT NULL REFERENCES pe_operations(id),
  call_key text NOT NULL CHECK (length(call_key) BETWEEN 1 AND 100),
  connection_id uuid NOT NULL,
  connection_revision integer NOT NULL CHECK (connection_revision>0),
  credential_revision integer NOT NULL CHECK (credential_revision>0),
  command_sealed bytea NOT NULL CHECK (octet_length(command_sealed) BETWEEN 29 AND 16412),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('pending','rejected','approved','succeeded','failed','uncertain','cancelled')),
  result_sealed bytea,
  error_code text,
  decided_at timestamptz,
  continuation_request_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id), UNIQUE(operation_id,call_key),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_ssh_connections(id,user_id)
);
CREATE INDEX pe_ssh_execute_actions_user ON pe_ssh_execute_actions(user_id,created_at DESC,id DESC);
ALTER TABLE pe_operations ADD COLUMN ssh_selection jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pe_operations ADD COLUMN source_ssh_execute_action_id uuid REFERENCES pe_ssh_execute_actions(id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK (source IN ('user','platform_action','sandbox_result','desktop_result','stdio_mcp_result','ssh_execute_result'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK (
  (source='user' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL
    AND source_ssh_execute_action_id IS NULL)
  OR (source='platform_action' AND source_action_id IS NOT NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL
    AND source_ssh_execute_action_id IS NULL)
  OR (source='sandbox_result' AND source_action_id IS NULL AND source_execution_id IS NOT NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL
    AND source_ssh_execute_action_id IS NULL)
  OR (source='desktop_result' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NOT NULL AND source_stdio_mcp_call_id IS NULL
    AND source_ssh_execute_action_id IS NULL)
  OR (source='stdio_mcp_result' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NOT NULL
    AND source_ssh_execute_action_id IS NULL)
  OR (source='ssh_execute_result' AND source_action_id IS NULL AND source_execution_id IS NULL
    AND source_desktop_execution_id IS NULL AND source_stdio_mcp_call_id IS NULL
    AND source_ssh_execute_action_id IS NOT NULL));
UPDATE pe_schema SET version=18 WHERE version=17;


-- schemaV19

CREATE TABLE pe_platform_admission_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  login_window_ms integer NOT NULL CHECK (login_window_ms>=1000),
  login_attempts_per_window integer NOT NULL CHECK (login_attempts_per_window>0),
  login_tracked_accounts integer NOT NULL CHECK (login_tracked_accounts>0),
  login_global_attempts_per_window integer NOT NULL CHECK (login_global_attempts_per_window>0),
  sandbox_concurrency integer NOT NULL CHECK (sandbox_concurrency>0)
);
CREATE TABLE pe_login_global_window (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  window_since timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts>=0),
  tracked_accounts integer NOT NULL DEFAULT 0 CHECK (tracked_accounts>=0)
);
INSERT INTO pe_login_global_window(singleton,window_since,attempts) VALUES(true,clock_timestamp(),0);
CREATE TABLE pe_login_attempt_windows (
  account_digest text PRIMARY KEY CHECK (account_digest ~ '^[a-f0-9]{64}$'),
  window_since timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts>0)
);
CREATE INDEX pe_login_attempt_windows_expiration ON pe_login_attempt_windows(window_since);
CREATE INDEX pe_cloud_executions_active_leases ON pe_cloud_executions(lease_until)
  WHERE lease_owner IS NOT NULL AND state IN ('starting','running','cancelling','uncertain');
UPDATE pe_schema SET version=19 WHERE version=18;


-- schemaV20

CREATE TABLE pe_builtin_skill_install_requests (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  catalog_id text NOT NULL CHECK (length(catalog_id) BETWEEN 1 AND 128),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  archive_digest text NOT NULL CHECK (archive_digest ~ '^[a-f0-9]{64}$'),
  package_version_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(package_version_id,user_id) REFERENCES pe_skill_package_versions(id,user_id)
);
CREATE INDEX pe_builtin_skill_install_requests_user ON pe_builtin_skill_install_requests(user_id,catalog_id);
UPDATE pe_schema SET version=20 WHERE version=19;


-- schemaV21

ALTER TABLE pe_cloud_executions ALTER COLUMN result TYPE json USING result::json;
ALTER TABLE pe_desktop_executions ALTER COLUMN result TYPE json USING result::json;
ALTER TABLE pe_connector_actions ALTER COLUMN result TYPE json USING result::json;
ALTER TABLE pe_events ALTER COLUMN event TYPE json USING event::json;
UPDATE pe_schema SET version=21 WHERE version=20;


-- schemaV22

CREATE TABLE pe_mcp_remote_connections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  server_name text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  configuration_revision integer NOT NULL CHECK(configuration_revision>0),
  enabled boolean NOT NULL, deleted_at timestamptz, current_catalog_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id), UNIQUE(user_id,server_name)
);
CREATE TABLE pe_mcp_configuration_versions (
  connection_id uuid NOT NULL, user_id uuid NOT NULL,
  configuration_revision integer NOT NULL CHECK(configuration_revision>0),
  credential_revision integer CHECK(credential_revision>0),
  configuration json NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,user_id,configuration_revision),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id)
);
ALTER TABLE pe_mcp_remote_connections ADD CONSTRAINT pe_mcp_remote_configuration
  FOREIGN KEY(id,user_id,configuration_revision)
  REFERENCES pe_mcp_configuration_versions(connection_id,user_id,configuration_revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE pe_mcp_credential_versions (
  connection_id uuid NOT NULL, user_id uuid NOT NULL,
  configuration_revision integer NOT NULL, credential_revision integer NOT NULL CHECK(credential_revision>0),
  format_version integer NOT NULL CHECK(format_version=1), sealed bytea NOT NULL CHECK(octet_length(sealed)>=29),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,user_id,configuration_revision,credential_revision),
  FOREIGN KEY(connection_id,user_id,configuration_revision)
    REFERENCES pe_mcp_configuration_versions(connection_id,user_id,configuration_revision)
);
CREATE TABLE pe_mcp_management_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('create','update','toggle','delete','draft','check')),
  metadata_digest text NOT NULL CHECK(metadata_digest ~ '^[a-f0-9]{64}$'),
  secret_digest text CHECK(secret_digest ~ '^[a-f0-9]{64}$'), result json,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,request_id)
);
CREATE TABLE pe_mcp_credential_tickets (
  user_id uuid NOT NULL, request_id uuid NOT NULL, token_digest text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK(purpose IN ('create','update','draft')), input json NOT NULL,
  resource_id uuid NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 19 AND 16384),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  PRIMARY KEY(user_id,request_id),
  FOREIGN KEY(user_id,request_id) REFERENCES pe_mcp_management_requests(user_id,request_id)
);
CREATE TABLE pe_mcp_drafts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), session_id uuid NOT NULL REFERENCES pe_sessions(id),
  source_connection_id uuid, source_revision integer, configuration json NOT NULL,
  configuration_revision integer NOT NULL CHECK(configuration_revision=1),
  credential_revision integer CHECK(credential_revision=1), credential_sealed bytea,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(id,user_id), FOREIGN KEY(source_connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  CHECK((source_connection_id IS NULL)=(source_revision IS NULL)),
  CHECK((credential_revision IS NULL)=(credential_sealed IS NULL))
);
CREATE TABLE pe_mcp_checks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), session_id uuid NOT NULL REFERENCES pe_sessions(id),
  connection_id uuid, draft_id uuid, connection_revision integer,
  configuration_revision integer NOT NULL CHECK(configuration_revision>0), credential_revision integer,
  state text NOT NULL CHECK(state IN ('queued','running','succeeded','failed','cancelled','expired')),
  catalog_id uuid, discovered_tools integer CHECK(discovered_tools>=0), error_code text,
  cancel_requested boolean NOT NULL DEFAULT false, lease_owner uuid,
  lease_epoch integer NOT NULL DEFAULT 0, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(id,user_id), FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES pe_mcp_drafts(id,user_id),
  CHECK((connection_id IS NOT NULL)<>(draft_id IS NOT NULL)),
  CHECK((connection_id IS NULL)=(connection_revision IS NULL))
);
CREATE INDEX pe_mcp_checks_work ON pe_mcp_checks(created_at,id) WHERE state IN ('queued','running');
CREATE TABLE pe_mcp_catalog_versions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id), connection_id uuid, draft_id uuid,
  configuration_revision integer NOT NULL CHECK(configuration_revision>0), credential_revision integer,
  catalog_digest text NOT NULL CHECK(catalog_digest ~ '^[a-f0-9]{64}$'), tools json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES pe_mcp_drafts(id,user_id),
  CHECK((connection_id IS NOT NULL)<>(draft_id IS NOT NULL))
);
CREATE UNIQUE INDEX pe_mcp_catalog_connection_digest
  ON pe_mcp_catalog_versions(connection_id,configuration_revision,COALESCE(credential_revision,0),catalog_digest)
  WHERE connection_id IS NOT NULL;
CREATE UNIQUE INDEX pe_mcp_catalog_draft_digest
  ON pe_mcp_catalog_versions(draft_id,COALESCE(credential_revision,0),catalog_digest) WHERE draft_id IS NOT NULL;
ALTER TABLE pe_mcp_remote_connections ADD CONSTRAINT pe_mcp_remote_catalog
  FOREIGN KEY(current_catalog_id,user_id) REFERENCES pe_mcp_catalog_versions(id,user_id);
ALTER TABLE pe_mcp_checks ADD CONSTRAINT pe_mcp_check_catalog
  FOREIGN KEY(catalog_id,user_id) REFERENCES pe_mcp_catalog_versions(id,user_id);
CREATE FUNCTION pe_mcp_reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'MCP snapshots are immutable'; END; $$;
CREATE TRIGGER pe_mcp_configuration_immutable BEFORE UPDATE OR DELETE ON pe_mcp_configuration_versions
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
CREATE TRIGGER pe_mcp_credential_immutable BEFORE UPDATE OR DELETE ON pe_mcp_credential_versions
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
CREATE TRIGGER pe_mcp_draft_immutable BEFORE UPDATE ON pe_mcp_drafts
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();
CREATE TRIGGER pe_mcp_catalog_immutable BEFORE UPDATE ON pe_mcp_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION pe_mcp_reject_version_update();

ALTER TABLE pe_operations ADD COLUMN remote_mcp_selection json NOT NULL DEFAULT '[]'::json;
UPDATE pe_schema SET version=22 WHERE version=21;


-- schemaV23

ALTER TABLE pe_operations ADD COLUMN mcp_root_operation_id uuid REFERENCES pe_operations(id);
ALTER TABLE pe_operations ADD COLUMN mcp_chain_cancelled_at timestamptz;
CREATE TABLE pe_mcp_action_chains (
  root_operation_id uuid PRIMARY KEY REFERENCES pe_operations(id),
  user_id uuid NOT NULL REFERENCES pe_users(id), session_id uuid NOT NULL REFERENCES pe_sessions(id),
  calls integer NOT NULL DEFAULT 0 CHECK(calls>=0), max_calls integer NOT NULL CHECK(max_calls>0),
  expires_at timestamptz NOT NULL, stopped_at timestamptz, error_code text
);
CREATE TABLE pe_mcp_permissions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid REFERENCES pe_sessions(id), connection_id uuid NOT NULL,
  connection_revision integer NOT NULL, configuration_revision integer NOT NULL,
  credential_revision integer, catalog_id uuid NOT NULL, tool_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_mcp_remote_connections(id,user_id),
  FOREIGN KEY(catalog_id,user_id) REFERENCES pe_mcp_catalog_versions(id,user_id)
);
CREATE INDEX pe_mcp_permissions_live ON pe_mcp_permissions(user_id,connection_id,tool_id)
  WHERE revoked_at IS NULL;
CREATE TABLE pe_mcp_actions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), operation_id uuid NOT NULL REFERENCES pe_operations(id),
  root_operation_id uuid NOT NULL REFERENCES pe_mcp_action_chains(root_operation_id), call_key text NOT NULL,
  tool json NOT NULL, arguments json NOT NULL, request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('pending','approved','preparing','dispatch-intent',
    'succeeded','failed','rejected','cancelled','expired','uncertain')),
  decision text CHECK(decision IN ('reject','once','session','persistent')),
  permission_id uuid REFERENCES pe_mcp_permissions(id), result json, error_code text,
  dispatch_id uuid UNIQUE, dispatch_at timestamptz, decided_at timestamptz,
  lease_owner uuid, lease_epoch integer NOT NULL DEFAULT 0, lease_until timestamptz,
  expires_at timestamptz NOT NULL, continuation_request_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_key), CHECK((dispatch_id IS NULL)=(dispatch_at IS NULL))
);
CREATE INDEX pe_mcp_actions_work ON pe_mcp_actions(created_at,id)
  WHERE state IN ('pending','approved','preparing','dispatch-intent');
ALTER TABLE pe_operations ADD COLUMN source_mcp_action_id uuid REFERENCES pe_mcp_actions(id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK(source IN ('user','platform_action','sandbox_result','desktop_result','stdio_mcp_result',
    'ssh_execute_result','remote_mcp_result'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK(
  (source='user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id)=0)
  OR (source<>'user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id)=1 AND
    CASE source WHEN 'platform_action' THEN source_action_id
      WHEN 'sandbox_result' THEN source_execution_id WHEN 'desktop_result' THEN source_desktop_execution_id
      WHEN 'stdio_mcp_result' THEN source_stdio_mcp_call_id WHEN 'ssh_execute_result' THEN source_ssh_execute_action_id
      WHEN 'remote_mcp_result' THEN source_mcp_action_id END IS NOT NULL));

UPDATE pe_schema SET version=23 WHERE version=22;


-- schemaV24

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

UPDATE pe_schema SET version=24 WHERE version=23;


-- schemaV25

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

UPDATE pe_schema SET version=25 WHERE version=24;


-- schemaV26

ALTER TABLE pe_artifacts ADD COLUMN expected_revision text
  CHECK (expected_revision IS NULL OR expected_revision ~ '^[a-f0-9]{64}$');
UPDATE pe_schema SET version=26 WHERE version=25;


-- schemaV27

CREATE TABLE pe_storage_spaces (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  root_key uuid NOT NULL UNIQUE, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  is_default boolean NOT NULL DEFAULT false,
  root_state text NOT NULL CHECK(root_state IN ('provisioning','ready')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX pe_storage_spaces_default ON pe_storage_spaces(user_id) WHERE is_default;
CREATE FUNCTION pe_storage_root_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.root_key IS DISTINCT FROM OLD.root_key OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Storage root identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_storage_root_immutable BEFORE UPDATE OF root_key,user_id ON pe_storage_spaces
  FOR EACH ROW EXECUTE FUNCTION pe_storage_root_immutable();
INSERT INTO pe_storage_spaces(id,user_id,root_key,title,is_default,root_state,created_at)
  SELECT id,user_id,id,title,false,'ready',created_at FROM pe_workspaces;
ALTER TABLE pe_workspaces ADD COLUMN binding_generation bigint NOT NULL DEFAULT 1 CHECK(binding_generation>=1);
ALTER TABLE pe_workspaces ADD COLUMN binding_state text NOT NULL DEFAULT 'provisioning'
  CHECK(binding_state IN ('provisioning','ready','missing','recovering','blocked'));
ALTER TABLE pe_workspaces ADD COLUMN recovery_request_id uuid;
ALTER TABLE pe_workspaces ADD COLUMN create_storage_target jsonb;
ALTER TABLE pe_workspaces ADD COLUMN binding_updated_at timestamptz NOT NULL DEFAULT now();
UPDATE pe_workspaces SET binding_state='ready';
CREATE TABLE pe_workspace_bindings (
  workspace_id uuid PRIMARY KEY, user_id uuid NOT NULL,
  space_id uuid NOT NULL, root_relative_path text NOT NULL DEFAULT '' CHECK(length(root_relative_path)<=512),
  FOREIGN KEY(workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY(space_id,user_id) REFERENCES pe_storage_spaces(id,user_id)
);
CREATE INDEX pe_workspace_bindings_space ON pe_workspace_bindings(space_id,root_relative_path);
INSERT INTO pe_workspace_bindings(workspace_id,user_id,space_id,root_relative_path)
  SELECT id,user_id,id,'' FROM pe_workspaces;
CREATE TABLE pe_storage_directory_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  space_id uuid NOT NULL, parent_path text NOT NULL, name text NOT NULL,
  state text NOT NULL CHECK(state IN ('accepted','completed')), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id), FOREIGN KEY(space_id,user_id) REFERENCES pe_storage_spaces(id,user_id),
  CHECK((state='completed')=(result IS NOT NULL))
);
CREATE TABLE pe_workspace_binding_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL, workspace_id uuid NOT NULL,
  space_id uuid NOT NULL, root_relative_path text NOT NULL CHECK(length(root_relative_path)<=512),
  expected_generation bigint NOT NULL CHECK(expected_generation>=1),
  state text NOT NULL CHECK(state IN ('accepted','stopping','completed','blocked')),
  stop_target jsonb NOT NULL, stop_proof jsonb,
  lease_owner uuid, lease_until timestamptz, lease_epoch bigint NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),
  error_code text, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id), UNIQUE(user_id,request_id,workspace_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY(space_id,user_id) REFERENCES pe_storage_spaces(id,user_id),
  CHECK((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK((state='completed')=(result IS NOT NULL)),
  CHECK((state='blocked')=(error_code IS NOT NULL))
);
CREATE INDEX pe_workspace_binding_requests_pending ON pe_workspace_binding_requests(created_at)
  WHERE state IN ('accepted','stopping');
ALTER TABLE pe_workspaces ADD CONSTRAINT pe_workspace_recovery_request
  FOREIGN KEY(user_id,recovery_request_id,id)
  REFERENCES pe_workspace_binding_requests(user_id,request_id,workspace_id);
ALTER TABLE pe_file_mutations ADD COLUMN binding_generation bigint NOT NULL DEFAULT 1 CHECK(binding_generation>=1);
ALTER TABLE pe_mount_slots ADD COLUMN binding_snapshot jsonb;
ALTER TABLE pe_sandbox_instances ADD COLUMN binding_snapshot jsonb;
UPDATE pe_mount_slots m SET binding_snapshot=jsonb_build_object(
  'workspaceId',w.id,'spaceId',b.space_id,'rootKey',s.root_key,
  'rootRelativePath',b.root_relative_path,'generation',w.binding_generation)
  FROM pe_workspaces w JOIN pe_workspace_bindings b ON b.workspace_id=w.id
  JOIN pe_storage_spaces s ON s.id=b.space_id WHERE m.workspace_id=w.id AND m.state<>'free';
UPDATE pe_sandbox_instances i SET binding_snapshot=jsonb_build_object(
  'workspaceId',w.id,'spaceId',b.space_id,'rootKey',s.root_key,
  'rootRelativePath',b.root_relative_path,'generation',w.binding_generation)
  FROM pe_sessions session JOIN pe_workspaces w ON w.id=session.workspace_id
  JOIN pe_workspace_bindings b ON b.workspace_id=w.id JOIN pe_storage_spaces s ON s.id=b.space_id
  WHERE i.session_id=session.id AND i.state<>'deleted';
UPDATE pe_schema SET version=27 WHERE version=26;


-- schemaV28

ALTER TABLE pe_cloud_executions DROP CONSTRAINT pe_cloud_executions_state_check;
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_state_check
  CHECK (state IN ('queued','starting','running','cancelling','succeeded','failed','cancelled','uncertain','closed_unknown'));
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_resolution_owner
  UNIQUE(id,user_id,session_id);
ALTER TABLE pe_cloud_executions ADD COLUMN dispatch_request json;
CREATE TABLE pe_cloud_execution_resolutions (
  id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), execution_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL REFERENCES pe_workspaces(id),
  mount_generation bigint NOT NULL CHECK (mount_generation > 0), sandbox_name text NOT NULL,
  pod_uid uuid NOT NULL, runner_instance_id uuid NOT NULL,
  binding_snapshot jsonb NOT NULL CHECK (jsonb_typeof(binding_snapshot)='object'),
  execution_request_digest text NOT NULL CHECK (execution_request_digest ~ '^[a-f0-9]{64}$'),
  runner_request_digest text CHECK (runner_request_digest ~ '^[a-f0-9]{64}$'),
  note text NOT NULL CHECK (char_length(note)<=500),
  state text NOT NULL CHECK (state IN ('accepted','stopping','completed','blocked')),
  observed_result json, stop_evidence jsonb,
  final_execution_state text CHECK (final_execution_state IN ('succeeded','failed','cancelled','closed_unknown')),
  continuation_request_id uuid NOT NULL UNIQUE,
  continuation_queued boolean NOT NULL DEFAULT false, error_code text,
  lease_owner uuid, lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0), lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(execution_id,user_id,session_id) REFERENCES pe_cloud_executions(id,user_id,session_id),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (state<>'completed' OR (final_execution_state IS NOT NULL AND stop_evidence IS NOT NULL AND error_code IS NULL)),
  CHECK (state='completed' OR (final_execution_state IS NULL AND NOT continuation_queued)),
  CHECK ((state='blocked')=(error_code IS NOT NULL))
);
CREATE INDEX pe_cloud_execution_resolutions_pending ON pe_cloud_execution_resolutions(lease_until,created_at)
  WHERE state IN ('accepted','stopping');
CREATE INDEX pe_cloud_execution_resolutions_slot ON pe_cloud_execution_resolutions(user_id,mount_generation,pod_uid);
UPDATE pe_schema SET version=28 WHERE version=27;


-- schemaV29

ALTER TABLE pe_desktop_executions ADD COLUMN dispatch_request json;
ALTER TABLE pe_desktop_executions ADD COLUMN dispatch_id uuid UNIQUE;
ALTER TABLE pe_desktop_executions ADD COLUMN dispatch_process_id uuid;
ALTER TABLE pe_desktop_executions ADD COLUMN container_receipt jsonb;
ALTER TABLE pe_desktop_executions ADD COLUMN start_authorized_at timestamptz;
ALTER TABLE pe_desktop_executions ADD COLUMN stop_request_id uuid UNIQUE;
ALTER TABLE pe_desktop_executions ADD COLUMN stop_record_digest text
  CHECK (stop_record_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE pe_desktop_executions ADD COLUMN stop_observation jsonb;
ALTER TABLE pe_desktop_executions ADD COLUMN continuation_queued boolean NOT NULL DEFAULT false;
UPDATE pe_desktop_executions e SET continuation_queued=true
  WHERE EXISTS (SELECT 1 FROM pe_operations o WHERE o.source_desktop_execution_id=e.id
    AND o.request_id=e.continuation_request_id);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_dispatch_identity
  CHECK ((dispatch_id IS NULL)=(dispatch_process_id IS NULL));
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_container_capture
  CHECK (container_receipt IS NULL OR (dispatch_id IS NOT NULL AND dispatch_request IS NOT NULL
    AND jsonb_typeof(container_receipt)='object'));
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_start_authority
  CHECK (start_authorized_at IS NULL OR container_receipt IS NOT NULL);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_stop_capture
  CHECK ((stop_request_id IS NULL)=(stop_record_digest IS NULL)
    AND (stop_request_id IS NULL)=(stop_observation IS NULL)
    AND (stop_observation IS NULL OR (container_receipt IS NOT NULL
      AND jsonb_typeof(stop_observation)='object')));
UPDATE pe_schema SET version=29 WHERE version=28;


-- schemaV30

ALTER TABLE pe_desktop_executions DROP CONSTRAINT pe_desktop_executions_state_check;
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_state_check
  CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled','uncertain','closed_unknown'));
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_execution_resolution_owner
  UNIQUE(id,user_id,session_id);
CREATE TABLE pe_device_execution_resolutions (
  id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), execution_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot json NOT NULL,
  note text NOT NULL CHECK (char_length(note)<=500),
  state text NOT NULL CHECK (state='completed'),
  final_execution_state text NOT NULL CHECK (final_execution_state='closed_unknown'),
  continuation_request_id uuid NOT NULL UNIQUE,
  continuation_queued boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(execution_id,user_id,session_id) REFERENCES pe_desktop_executions(id,user_id,session_id)
);
UPDATE pe_schema SET version=30 WHERE version=29;


-- schemaV31

CREATE TABLE pe_device_claim_closures (
  id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), execution_id uuid NOT NULL UNIQUE,
  device_id uuid NOT NULL REFERENCES pe_devices(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request json NOT NULL, receipt json NOT NULL,
  continuation_request_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(execution_id,user_id,session_id) REFERENCES pe_desktop_executions(id,user_id,session_id)
);
UPDATE pe_schema SET version=31 WHERE version=30;


-- schemaV32

CREATE TABLE pe_office_preview_jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[[:cntrl:]]'),
  generation text NOT NULL CHECK (generation ~ '^[a-f0-9]{64}$'),
  request_digest text CHECK (request_digest ~ '^[a-f0-9]{64}$'), request jsonb,
  session_id uuid, workspace_id uuid, binding_snapshot jsonb, source_snapshot jsonb, converter_snapshot jsonb,
  state text NOT NULL CHECK (state IN ('queued','creating','running','stopping','succeeded','failed','cancelled','blocked')),
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IN ('input-too-large','output-too-large','invalid-document','unsupported-format',
    'invalid-output','timeout','unavailable','failed','busy','source-changed')),
  deadline_at timestamptz, lease_owner uuid, lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  parser_slot integer CHECK (parser_slot >= 0),
  creation_intent jsonb, pod_identity jsonb, worker_observation jsonb, stop_evidence jsonb, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(user_id,request_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY(session_id,user_id,workspace_id) REFERENCES pe_sessions(id,user_id,workspace_id),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state IN ('failed','blocked')) = (error_code IS NOT NULL)),
  CHECK ((state IN ('succeeded','failed','cancelled')) = (completed_at IS NOT NULL)),
  CHECK (
    (request_digest IS NULL AND state='cancelled' AND cancel_requested AND request IS NULL
      AND session_id IS NULL AND workspace_id IS NULL AND binding_snapshot IS NULL AND source_snapshot IS NULL
      AND converter_snapshot IS NULL AND deadline_at IS NULL AND creation_intent IS NULL AND pod_identity IS NULL
      AND worker_observation IS NULL AND stop_evidence IS NULL AND result IS NULL AND lease_owner IS NULL
      AND lease_until IS NULL AND lease_epoch=0 AND attempts=0 AND parser_slot IS NULL)
    OR
    (request_digest IS NOT NULL AND request IS NOT NULL AND session_id IS NOT NULL AND workspace_id IS NOT NULL
      AND binding_snapshot IS NOT NULL AND source_snapshot IS NOT NULL AND converter_snapshot IS NOT NULL
      AND deadline_at IS NOT NULL)
  ),
  CHECK (parser_slot IS NULL OR (creation_intent IS NOT NULL AND state IN ('creating','running','stopping','blocked'))),
  CHECK (creation_intent IS NULL OR parser_slot IS NOT NULL
    OR (state IN ('succeeded','failed','cancelled') AND stop_evidence IS NOT NULL)),
  CHECK (pod_identity IS NULL OR creation_intent IS NOT NULL),
  CHECK (worker_observation IS NULL OR pod_identity IS NOT NULL),
  CHECK (stop_evidence IS NULL OR creation_intent IS NOT NULL),
  CHECK (state <> 'succeeded' OR (result IS NOT NULL AND stop_evidence IS NOT NULL)),
  CHECK (request IS NULL OR jsonb_typeof(request)='object'),
  CHECK (binding_snapshot IS NULL OR jsonb_typeof(binding_snapshot)='object'),
  CHECK (source_snapshot IS NULL OR jsonb_typeof(source_snapshot)='object'),
  CHECK (converter_snapshot IS NULL OR jsonb_typeof(converter_snapshot)='object'),
  CHECK (creation_intent IS NULL OR jsonb_typeof(creation_intent)='object'),
  CHECK (pod_identity IS NULL OR jsonb_typeof(pod_identity)='object'),
  CHECK (worker_observation IS NULL OR jsonb_typeof(worker_observation)='object'),
  CHECK (stop_evidence IS NULL OR jsonb_typeof(stop_evidence)='object'),
  CHECK (result IS NULL OR jsonb_typeof(result)='object')
);
CREATE UNIQUE INDEX pe_office_preview_parser_slots ON pe_office_preview_jobs(parser_slot) WHERE parser_slot IS NOT NULL;
CREATE INDEX pe_office_preview_pending ON pe_office_preview_jobs(created_at)
  WHERE state IN ('queued','creating','running','stopping','blocked');
CREATE INDEX pe_office_preview_user ON pe_office_preview_jobs(user_id,created_at DESC);
CREATE FUNCTION pe_office_preview_keep_cancelled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.request_digest IS NULL AND (NEW.request_digest IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.generation IS DISTINCT FROM OLD.generation) THEN
    RAISE EXCEPTION 'Office cancellation cannot become an admission' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_office_preview_cancelled BEFORE UPDATE ON pe_office_preview_jobs
  FOR EACH ROW EXECUTE FUNCTION pe_office_preview_keep_cancelled();
UPDATE pe_schema SET version=32 WHERE version=31;


-- schemaV33

UPDATE pe_schema SET version=33 WHERE version=32;


-- schemaV34


ALTER TABLE pe_cloud_executions ADD COLUMN execution_kind text NOT NULL DEFAULT 'legacy_command'
  CHECK (execution_kind IN ('legacy_command','stdio_v2'));
ALTER TABLE pe_cloud_executions ADD COLUMN execution_target text NOT NULL DEFAULT 'cloud'
  CHECK (execution_target='cloud');
ALTER TABLE pe_cloud_executions ADD COLUMN origin_kind text NOT NULL DEFAULT 'operation'
  CHECK (origin_kind IN ('operation','stdio_discovery'));
ALTER TABLE pe_cloud_executions ADD COLUMN task_version integer;
ALTER TABLE pe_cloud_executions ADD COLUMN stdio_phase text;
ALTER TABLE pe_cloud_executions ADD COLUMN stdio_task json;
ALTER TABLE pe_cloud_executions ADD COLUMN stdio_action_id uuid;
ALTER TABLE pe_cloud_executions ALTER COLUMN operation_id DROP NOT NULL;
ALTER TABLE pe_cloud_executions ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE pe_cloud_executions ALTER COLUMN command DROP NOT NULL;
ALTER TABLE pe_cloud_executions ALTER COLUMN cwd DROP NOT NULL;
ALTER TABLE pe_cloud_executions ALTER COLUMN continuation_request_id DROP NOT NULL;
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_task_branch CHECK (
  (execution_kind='legacy_command' AND origin_kind='operation'
    AND task_version IS NULL AND stdio_phase IS NULL AND stdio_task IS NULL AND stdio_action_id IS NULL
    AND operation_id IS NOT NULL AND call_id IS NOT NULL AND command IS NOT NULL AND cwd IS NOT NULL
    AND continuation_request_id IS NOT NULL)
  OR (execution_kind='stdio_v2' AND task_version IS NOT NULL AND task_version=2
    AND stdio_phase IS NOT NULL AND stdio_phase='discover' AND origin_kind='stdio_discovery'
    AND stdio_task IS NOT NULL AND (json_typeof(stdio_task)='object') IS TRUE AND stdio_action_id IS NOT NULL
    AND operation_id IS NULL AND call_id IS NULL AND command IS NULL AND cwd IS NULL
    AND continuation_request_id IS NULL)
  OR (execution_kind='stdio_v2' AND task_version IS NOT NULL AND task_version=2
    AND stdio_phase IS NOT NULL AND stdio_phase='call' AND origin_kind='operation'
    AND stdio_task IS NOT NULL AND (json_typeof(stdio_task)='object') IS TRUE AND stdio_action_id IS NOT NULL
    AND operation_id IS NOT NULL AND call_id IS NOT NULL AND command IS NULL AND cwd IS NULL
    AND continuation_request_id IS NOT NULL));
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_stdio_identity
  UNIQUE(id,user_id,session_id,stdio_phase,stdio_action_id);
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_stdio_action_unique UNIQUE(stdio_action_id);


ALTER TABLE pe_desktop_executions ADD COLUMN execution_kind text NOT NULL DEFAULT 'legacy_command'
  CHECK (execution_kind IN ('legacy_command','stdio_v2'));
ALTER TABLE pe_desktop_executions ADD COLUMN execution_target text NOT NULL DEFAULT 'desktop'
  CHECK (execution_target='desktop');
ALTER TABLE pe_desktop_executions ADD COLUMN origin_kind text NOT NULL DEFAULT 'operation'
  CHECK (origin_kind IN ('operation','stdio_discovery'));
ALTER TABLE pe_desktop_executions ADD COLUMN task_version integer;
ALTER TABLE pe_desktop_executions ADD COLUMN stdio_phase text;
ALTER TABLE pe_desktop_executions ADD COLUMN stdio_task json;
ALTER TABLE pe_desktop_executions ADD COLUMN stdio_action_id uuid;
ALTER TABLE pe_desktop_executions ALTER COLUMN operation_id DROP NOT NULL;
ALTER TABLE pe_desktop_executions ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE pe_desktop_executions ALTER COLUMN command DROP NOT NULL;
ALTER TABLE pe_desktop_executions ALTER COLUMN cwd DROP NOT NULL;
ALTER TABLE pe_desktop_executions ALTER COLUMN continuation_request_id DROP NOT NULL;
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_task_branch CHECK (
  (execution_kind='legacy_command' AND origin_kind='operation'
    AND task_version IS NULL AND stdio_phase IS NULL AND stdio_task IS NULL AND stdio_action_id IS NULL
    AND operation_id IS NOT NULL AND call_id IS NOT NULL AND command IS NOT NULL AND cwd IS NOT NULL
    AND continuation_request_id IS NOT NULL)
  OR (execution_kind='stdio_v2' AND task_version IS NOT NULL AND task_version=2
    AND stdio_phase IS NOT NULL AND stdio_phase='discover' AND origin_kind='stdio_discovery'
    AND stdio_task IS NOT NULL AND (json_typeof(stdio_task)='object') IS TRUE AND stdio_action_id IS NOT NULL
    AND operation_id IS NULL AND call_id IS NULL AND command IS NULL AND cwd IS NULL
    AND continuation_request_id IS NULL)
  OR (execution_kind='stdio_v2' AND task_version IS NOT NULL AND task_version=2
    AND stdio_phase IS NOT NULL AND stdio_phase='call' AND origin_kind='operation'
    AND stdio_task IS NOT NULL AND (json_typeof(stdio_task)='object') IS TRUE AND stdio_action_id IS NOT NULL
    AND operation_id IS NOT NULL AND call_id IS NOT NULL AND command IS NULL AND cwd IS NULL
    AND continuation_request_id IS NOT NULL));
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_stdio_identity
  UNIQUE(id,user_id,session_id,stdio_phase,stdio_action_id);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_stdio_action_unique UNIQUE(stdio_action_id);

ALTER TABLE pe_sessions ADD CONSTRAINT pe_sessions_stdio_owner UNIQUE(id,user_id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_session UNIQUE(id,session_id);
ALTER TABLE pe_devices ADD CONSTRAINT pe_devices_stdio_owner UNIQUE(id,user_id);
ALTER TABLE pe_device_directories ADD CONSTRAINT pe_device_directories_stdio_owner UNIQUE(id,device_id,user_id);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_owned_device
  FOREIGN KEY(device_id,user_id) REFERENCES pe_devices(id,user_id);
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_owned_directory
  FOREIGN KEY(directory_id,device_id,user_id) REFERENCES pe_device_directories(id,device_id,user_id);

CREATE TABLE pe_stdio_v2_connections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  revision integer NOT NULL CHECK (revision>0), enabled boolean NOT NULL DEFAULT false,
  current_catalog_id uuid, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id), CHECK (deleted_at IS NULL OR NOT enabled)
);
CREATE TABLE pe_stdio_v2_configurations (
  connection_id uuid NOT NULL, user_id uuid NOT NULL, revision integer NOT NULL CHECK (revision>0),
  configuration json NOT NULL CHECK ((json_typeof(configuration)='object') IS TRUE),
  config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,revision),
  UNIQUE(connection_id,user_id,revision,config_digest), UNIQUE(connection_id,user_id,revision),
  FOREIGN KEY(connection_id,user_id) REFERENCES pe_stdio_v2_connections(id,user_id)
);
ALTER TABLE pe_stdio_v2_connections ADD CONSTRAINT pe_stdio_v2_connections_current_config
  FOREIGN KEY(id,user_id,revision) REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE pe_stdio_v2_management_requests (
  user_id uuid NOT NULL REFERENCES pe_users(id), request_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('create','update','toggle','delete','check')),
  request json NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  receipt json NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,request_id)
);
CREATE TABLE pe_stdio_v2_actions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL,
  connection_id uuid NOT NULL, config_revision integer NOT NULL, config_digest text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('discover','call')),
  execution_target text NOT NULL CHECK (execution_target IN ('cloud','desktop')),
  execution_id uuid NOT NULL UNIQUE,
  cloud_execution_id uuid GENERATED ALWAYS AS
    (CASE WHEN execution_target='cloud' THEN execution_id END) STORED,
  desktop_execution_id uuid GENERATED ALWAYS AS
    (CASE WHEN execution_target='desktop' THEN execution_id END) STORED,
  request_id uuid, operation_id uuid, root_operation_id uuid, call_id text,
  task json NOT NULL CHECK ((json_typeof(task)='object') IS TRUE),
  task_digest text NOT NULL CHECK (task_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('queued','preparing','pending','approved','dispatch-intent',
    'running','stopping','blocked','succeeded','failed','cancelled','rejected','expired')),
  cancel_requested boolean NOT NULL DEFAULT false, error_code text,
  lease_owner uuid, lease_until timestamptz, lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  continuation_request_id uuid UNIQUE, continuation_queued boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,call_id), UNIQUE(user_id,request_id), UNIQUE(id,session_id,phase),
  UNIQUE(id,session_id,phase,continuation_request_id),
  UNIQUE(id,user_id,session_id,connection_id,config_revision,config_digest,phase),
  UNIQUE(id,user_id,session_id,phase,execution_target,execution_id,task_digest),
  FOREIGN KEY(session_id,user_id) REFERENCES pe_sessions(id,user_id),
  FOREIGN KEY(connection_id,user_id,config_revision,config_digest)
    REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision,config_digest),
  FOREIGN KEY(user_id,request_id) REFERENCES pe_stdio_v2_management_requests(user_id,request_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(operation_id,session_id) REFERENCES pe_operations(id,session_id),
  FOREIGN KEY(root_operation_id,session_id) REFERENCES pe_operations(id,session_id),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK ((phase='discover' AND request_id IS NOT NULL AND operation_id IS NULL AND root_operation_id IS NULL
      AND call_id IS NULL AND continuation_request_id IS NULL AND NOT continuation_queued)
    OR (phase='call' AND request_id IS NULL AND operation_id IS NOT NULL AND root_operation_id IS NOT NULL
      AND call_id IS NOT NULL AND continuation_request_id IS NOT NULL))
);

ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_stdio_action
  FOREIGN KEY(stdio_action_id,user_id,session_id,stdio_phase,execution_target,id,request_digest)
  REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pe_stdio_v2_actions ADD CONSTRAINT pe_stdio_v2_actions_cloud_execution
  FOREIGN KEY(cloud_execution_id,user_id,session_id,phase,id)
  REFERENCES pe_cloud_executions(id,user_id,session_id,stdio_phase,stdio_action_id)
  DEFERRABLE INITIALLY DEFERRED;


ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_stdio_action
  FOREIGN KEY(stdio_action_id,user_id,session_id,stdio_phase,execution_target,id,request_digest)
  REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE pe_stdio_v2_actions ADD CONSTRAINT pe_stdio_v2_actions_desktop_execution
  FOREIGN KEY(desktop_execution_id,user_id,session_id,phase,id)
  REFERENCES pe_desktop_executions(id,user_id,session_id,stdio_phase,stdio_action_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX pe_stdio_v2_actions_pending ON pe_stdio_v2_actions(created_at,id)
  WHERE state IN ('queued','preparing','approved','dispatch-intent','running','stopping','blocked');

CREATE TABLE pe_stdio_v2_preparations (
  action_id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL,
  phase text NOT NULL, execution_target text NOT NULL, execution_id uuid NOT NULL UNIQUE,
  task_digest text NOT NULL, prepared json NOT NULL CHECK ((json_typeof(prepared)='object') IS TRUE),
  prepared_digest text NOT NULL CHECK (prepared_digest ~ '^[a-f0-9]{64}$'),
  approval_binding json NOT NULL CHECK ((json_typeof(approval_binding)='object') IS TRUE),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  approval_epoch integer NOT NULL CHECK (approval_epoch=1), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,user_id,fingerprint),
  UNIQUE(action_id,execution_id,task_digest,prepared_digest,fingerprint,expires_at),
  FOREIGN KEY(action_id,user_id,session_id,phase,execution_target,execution_id,task_digest)
    REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
);
CREATE TABLE pe_stdio_v2_decisions (
  action_id uuid PRIMARY KEY, user_id uuid NOT NULL, fingerprint text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('once','reject')), decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(action_id,decision), FOREIGN KEY(action_id,user_id,fingerprint)
    REFERENCES pe_stdio_v2_preparations(action_id,user_id,fingerprint)
);
CREATE TABLE pe_stdio_v2_start_permits (
  action_id uuid PRIMARY KEY, permit_id uuid NOT NULL UNIQUE,
  authorization_request_id uuid NOT NULL, execution_id uuid NOT NULL UNIQUE,
  task_digest text NOT NULL, prepared_digest text NOT NULL, fingerprint text NOT NULL,
  decision text NOT NULL CHECK (decision='once'),
  executor_owner json NOT NULL CHECK ((json_typeof(executor_owner)='object') IS TRUE),
  permit json NOT NULL CHECK ((json_typeof(permit)='object') IS TRUE),
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  FOREIGN KEY(action_id,decision) REFERENCES pe_stdio_v2_decisions(action_id,decision),
  FOREIGN KEY(action_id,execution_id,task_digest,prepared_digest,fingerprint,expires_at)
    REFERENCES pe_stdio_v2_preparations(action_id,execution_id,task_digest,prepared_digest,fingerprint,expires_at)
);
CREATE TABLE pe_stdio_v2_dispatches (
  action_id uuid PRIMARY KEY REFERENCES pe_stdio_v2_start_permits(action_id),
  dispatch json NOT NULL CHECK ((json_typeof(dispatch)='object') IS TRUE),
  dispatch_digest text NOT NULL CHECK (dispatch_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_stdio_v2_results (
  action_id uuid PRIMARY KEY REFERENCES pe_stdio_v2_actions(id),
  result json NOT NULL, result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  observation json NOT NULL CHECK ((json_typeof(observation)='object') IS TRUE),
  stop_evidence json NOT NULL CHECK ((json_typeof(stop_evidence)='object') IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pe_stdio_v2_catalogs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, connection_id uuid NOT NULL,
  config_revision integer NOT NULL, config_digest text NOT NULL,
  action_id uuid NOT NULL UNIQUE, session_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase='discover'),
  raw_catalog json NOT NULL CHECK ((json_typeof(raw_catalog)='array') IS TRUE),
  image_expectation json NOT NULL CHECK ((json_typeof(image_expectation)='object') IS TRUE),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id,connection_id,config_revision),
  FOREIGN KEY(connection_id,user_id,config_revision,config_digest)
    REFERENCES pe_stdio_v2_configurations(connection_id,user_id,revision,config_digest),
  FOREIGN KEY(action_id,user_id,session_id,connection_id,config_revision,config_digest,phase)
    REFERENCES pe_stdio_v2_actions(id,user_id,session_id,connection_id,config_revision,config_digest,phase),
  FOREIGN KEY(action_id) REFERENCES pe_stdio_v2_results(action_id)
);
ALTER TABLE pe_stdio_v2_connections ADD CONSTRAINT pe_stdio_v2_connections_current_catalog
  FOREIGN KEY(current_catalog_id,user_id,id,revision)
    REFERENCES pe_stdio_v2_catalogs(id,user_id,connection_id,config_revision);

CREATE FUNCTION pe_stdio_v2_keep_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'STDIO original record cannot be replaced' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER pe_stdio_v2_configurations_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_configurations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_management_requests_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_management_requests
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_preparations_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_preparations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_decisions_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_decisions
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_start_permits_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_start_permits
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_dispatches_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_dispatches
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_results_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_results
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE TRIGGER pe_stdio_v2_catalogs_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_catalogs
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE FUNCTION pe_stdio_v2_keep_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.session_id,NEW.connection_id,NEW.config_revision,NEW.config_digest,NEW.phase,
    NEW.execution_target,NEW.execution_id,NEW.request_id,NEW.operation_id,NEW.root_operation_id,NEW.call_id,
    NEW.task::text,NEW.task_digest,NEW.continuation_request_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_id,OLD.connection_id,OLD.config_revision,OLD.config_digest,
    OLD.phase,OLD.execution_target,OLD.execution_id,OLD.request_id,OLD.operation_id,OLD.root_operation_id,OLD.call_id,
    OLD.task::text,OLD.task_digest,OLD.continuation_request_id) THEN
    RAISE EXCEPTION 'STDIO accepted task cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_stdio_v2_actions_original BEFORE UPDATE ON pe_stdio_v2_actions
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_task();

CREATE FUNCTION pe_stdio_v2_keep_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_kind IS DISTINCT FROM OLD.execution_kind
    OR (OLD.execution_kind='stdio_v2' AND ROW(NEW.id,NEW.user_id,NEW.session_id,NEW.operation_id,NEW.call_id,
      NEW.execution_target,NEW.origin_kind,NEW.task_version,NEW.stdio_phase,NEW.stdio_task::text,
      NEW.stdio_action_id,NEW.request_digest,NEW.continuation_request_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_id,OLD.operation_id,OLD.call_id,
      OLD.execution_target,OLD.origin_kind,OLD.task_version,OLD.stdio_phase,OLD.stdio_task::text,
      OLD.stdio_action_id,OLD.request_digest,OLD.continuation_request_id)) THEN
    RAISE EXCEPTION 'STDIO original execution cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION pe_stdio_v2_match_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected pe_stdio_v2_actions%ROWTYPE;
BEGIN
  IF NEW.execution_kind='stdio_v2' THEN
    SELECT * INTO expected FROM pe_stdio_v2_actions WHERE id=NEW.stdio_action_id;
    IF NOT FOUND OR ROW(NEW.stdio_task::text,NEW.operation_id,NEW.call_id,NEW.continuation_request_id)
      IS DISTINCT FROM ROW(expected.task::text,expected.operation_id,expected.call_id,expected.continuation_request_id) THEN
      RAISE EXCEPTION 'STDIO execution does not match original action' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_cloud_executions_stdio_original BEFORE UPDATE ON pe_cloud_executions
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_execution();
CREATE CONSTRAINT TRIGGER pe_cloud_executions_stdio_match AFTER INSERT OR UPDATE ON pe_cloud_executions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_match_execution();
CREATE TRIGGER pe_desktop_executions_stdio_original BEFORE UPDATE ON pe_desktop_executions
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_execution();
CREATE CONSTRAINT TRIGGER pe_desktop_executions_stdio_match AFTER INSERT OR UPDATE ON pe_desktop_executions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_match_execution();

ALTER TABLE pe_operations ADD COLUMN stdio_v2_selection json NOT NULL DEFAULT '[]'::json;
ALTER TABLE pe_operations ADD COLUMN source_stdio_v2_action_id uuid;
ALTER TABLE pe_operations ADD COLUMN source_stdio_v2_phase text;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_v2_source
  FOREIGN KEY(source_stdio_v2_action_id,session_id,source_stdio_v2_phase,request_id)
    REFERENCES pe_stdio_v2_actions(id,session_id,phase,continuation_request_id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_v2_result
  FOREIGN KEY(source_stdio_v2_action_id) REFERENCES pe_stdio_v2_results(action_id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK(source IN ('user','platform_action','sandbox_result','desktop_result','stdio_mcp_result',
    'ssh_execute_result','remote_mcp_result','stdio_v2_result'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK(
  (source='user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id)=0
    AND source_stdio_v2_phase IS NULL)
  OR (source<>'user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id)=1
    AND CASE source WHEN 'platform_action' THEN source_action_id
      WHEN 'sandbox_result' THEN source_execution_id WHEN 'desktop_result' THEN source_desktop_execution_id
      WHEN 'stdio_mcp_result' THEN source_stdio_mcp_call_id WHEN 'ssh_execute_result' THEN source_ssh_execute_action_id
      WHEN 'remote_mcp_result' THEN source_mcp_action_id WHEN 'stdio_v2_result' THEN source_stdio_v2_action_id END IS NOT NULL
    AND ((source='stdio_v2_result' AND source_stdio_v2_phase IS NOT NULL AND source_stdio_v2_phase='call')
      OR (source<>'stdio_v2_result' AND source_stdio_v2_phase IS NULL))));
CREATE FUNCTION pe_stdio_v2_keep_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stdio_v2_selection::text IS DISTINCT FROM OLD.stdio_v2_selection::text
    OR (OLD.source_stdio_v2_action_id IS NOT NULL AND ROW(NEW.id,NEW.session_id,NEW.request_id,NEW.source,
      NEW.source_stdio_v2_action_id,NEW.source_stdio_v2_phase)
      IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.request_id,OLD.source,
      OLD.source_stdio_v2_action_id,OLD.source_stdio_v2_phase)) THEN
    RAISE EXCEPTION 'STDIO original operation cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_operations_stdio_original BEFORE UPDATE ON pe_operations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_operation();
UPDATE pe_schema SET version=34 WHERE version=33;


-- schemaV35

CREATE TABLE pe_stdio_v2_observations (
  id uuid PRIMARY KEY, action_id uuid NOT NULL REFERENCES pe_stdio_v2_actions(id),
  worker_id uuid NOT NULL, lease_epoch bigint NOT NULL CHECK (lease_epoch>0),
  observation json NOT NULL CHECK ((json_typeof(observation)='object') IS TRUE),
  observation_digest text NOT NULL CHECK (observation_digest ~ '^[a-f0-9]{64}$'),
  stop_evidence json CHECK (stop_evidence IS NULL OR (json_typeof(stop_evidence)='object') IS TRUE),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(action_id,observation_digest)
);
CREATE TRIGGER pe_stdio_v2_observations_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_observations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
UPDATE pe_schema SET version=35 WHERE version=34;


-- schemaV36

CREATE TABLE pe_stdio_v2_no_start_closures (
  action_id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('discover','call')),
  execution_target text NOT NULL CHECK (execution_target='cloud'),
  execution_id uuid NOT NULL UNIQUE, task_digest text NOT NULL CHECK (task_digest ~ '^[a-f0-9]{64}$'),
  prepared_digest text CHECK (prepared_digest IS NULL OR prepared_digest ~ '^[a-f0-9]{64}$'),
  worker_id uuid NOT NULL, lease_epoch bigint NOT NULL CHECK (lease_epoch>0),
  receipt json NOT NULL CHECK ((json_typeof(receipt)='object') IS TRUE),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(action_id,user_id,session_id,phase,execution_target,execution_id,task_digest)
    REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
);
CREATE TRIGGER pe_stdio_v2_no_start_closures_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_no_start_closures
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE FUNCTION pe_stdio_v2_exclude_closed_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM pe_stdio_v2_actions WHERE id=NEW.action_id FOR UPDATE;
  IF TG_TABLE_NAME='pe_stdio_v2_no_start_closures' THEN
    IF EXISTS(SELECT 1 FROM pe_stdio_v2_start_permits WHERE action_id=NEW.action_id)
      OR EXISTS(SELECT 1 FROM pe_stdio_v2_results WHERE action_id=NEW.action_id) THEN
      RAISE EXCEPTION 'STDIO start authority conflicts with no-start closure' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM pe_stdio_v2_no_start_closures WHERE action_id=NEW.action_id) THEN
    RAISE EXCEPTION 'STDIO no-start closure excludes start authority and Runner results' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER pe_stdio_v2_no_start_closures_exclude_closed_start AFTER INSERT ON pe_stdio_v2_no_start_closures
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_exclude_closed_start();

CREATE CONSTRAINT TRIGGER pe_stdio_v2_start_permits_exclude_closed_start AFTER INSERT ON pe_stdio_v2_start_permits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_exclude_closed_start();

CREATE CONSTRAINT TRIGGER pe_stdio_v2_results_exclude_closed_start AFTER INSERT ON pe_stdio_v2_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_exclude_closed_start();
UPDATE pe_schema SET version=36 WHERE version=35;


-- schemaV37

ALTER TABLE pe_operations ADD COLUMN source_stdio_v2_no_start_action_id uuid;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_v2_no_start_source
  FOREIGN KEY(source_stdio_v2_no_start_action_id,session_id,source_stdio_v2_phase,request_id)
    REFERENCES pe_stdio_v2_actions(id,session_id,phase,continuation_request_id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_stdio_v2_no_start_closure
  FOREIGN KEY(source_stdio_v2_no_start_action_id) REFERENCES pe_stdio_v2_no_start_closures(action_id);
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check
  CHECK(source IN ('user','platform_action','sandbox_result','desktop_result','stdio_mcp_result',
    'ssh_execute_result','remote_mcp_result','stdio_v2_result','stdio_v2_no_start'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK(
  (source='user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id,
    source_stdio_v2_no_start_action_id)=0 AND source_stdio_v2_phase IS NULL)
  OR (source<>'user' AND num_nonnulls(source_action_id,source_execution_id,source_desktop_execution_id,
    source_stdio_mcp_call_id,source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id,
    source_stdio_v2_no_start_action_id)=1
    AND CASE source WHEN 'platform_action' THEN source_action_id
      WHEN 'sandbox_result' THEN source_execution_id WHEN 'desktop_result' THEN source_desktop_execution_id
      WHEN 'stdio_mcp_result' THEN source_stdio_mcp_call_id WHEN 'ssh_execute_result' THEN source_ssh_execute_action_id
      WHEN 'remote_mcp_result' THEN source_mcp_action_id WHEN 'stdio_v2_result' THEN source_stdio_v2_action_id
      WHEN 'stdio_v2_no_start' THEN source_stdio_v2_no_start_action_id END IS NOT NULL
    AND ((source IN ('stdio_v2_result','stdio_v2_no_start')
      AND source_stdio_v2_phase IS NOT NULL AND source_stdio_v2_phase='call')
      OR (source NOT IN ('stdio_v2_result','stdio_v2_no_start') AND source_stdio_v2_phase IS NULL))));
CREATE FUNCTION pe_stdio_v2_keep_no_start_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_stdio_v2_no_start_action_id IS DISTINCT FROM OLD.source_stdio_v2_no_start_action_id
    OR (OLD.source_stdio_v2_no_start_action_id IS NOT NULL AND ROW(NEW.id,NEW.session_id,NEW.request_id,
      NEW.source,NEW.source_stdio_v2_phase,NEW.mcp_root_operation_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.request_id,
      OLD.source,OLD.source_stdio_v2_phase,OLD.mcp_root_operation_id)) THEN
    RAISE EXCEPTION 'STDIO no-start operation source cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_operations_stdio_no_start_original BEFORE UPDATE ON pe_operations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_no_start_operation();
UPDATE pe_schema SET version=37 WHERE version=36;

UPDATE pe_schema SET version=37;
