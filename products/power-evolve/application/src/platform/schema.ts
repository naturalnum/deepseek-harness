/** Initial PG schema. Session bytes and operation ownership commit in the same database. */
import { mcpConnectionsSchemaV22 } from './mcp-connections-schema.ts'
import { mcpActionsSchemaV23 } from './mcp-actions-schema.ts'
import { sshSchemaV24 } from './ssh-schema.ts'
import { accountSchemaV25 } from './account-schema.ts'

/** Latest supported product database version; older binaries reject newer state. */
export const CURRENT_SCHEMA_VERSION = 30

export const schema = `
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
`

/** Add persistent user workspaces and separately versioned personal skill packages. */
export const schemaV2 = `
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
`

/** Separate human approval credentials and durable, action-bound connector intent. */
export const schemaV3 = `
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
`

/** Durable platform-origin continuation after a human decision or remote result. */
export const schemaV4 = `
ALTER TABLE pe_operations ADD COLUMN source text NOT NULL DEFAULT 'user'
  CHECK (source IN ('user','platform_action'));
ALTER TABLE pe_connector_actions ADD COLUMN continuation_request_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX pe_connector_actions_continuation ON pe_connector_actions(continuation_request_id);
ALTER TABLE pe_operations ADD COLUMN source_action_id uuid REFERENCES pe_connector_actions(id);
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action
  CHECK ((source='user' AND source_action_id IS NULL) OR (source='platform_action' AND source_action_id IS NOT NULL));
UPDATE pe_schema SET version=4 WHERE version=3;
`

/** On-demand Sandbox instances and idempotent execution requests. */
export const schemaV5 = `
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
`

/** Retain native Pod stop evidence before releasing a writable workspace mount. */
export const schemaV6 = `
ALTER TABLE pe_sandbox_instances ADD COLUMN stop_pod_uid uuid;
ALTER TABLE pe_sandbox_instances ADD COLUMN stop_evidence jsonb;
UPDATE pe_schema SET version=6 WHERE version=5;
`

/** Device identity, local directory grants, and a separate durable desktop execution lane. */
export const schemaV7 = `
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
`

/** Rotate eligible users when claiming work, while preserving FIFO within each user. */
export const schemaV8 = `
ALTER TABLE pe_users ADD COLUMN last_claim_at timestamptz;
UPDATE pe_schema SET version=8 WHERE version=7;
`

/** Bind Sessions to persistent workspaces and reserve one writable cloud mount per user. */
export const schemaV9 = `
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
`

/** Record immutable artifacts outside writable Sandbox mounts. */
export const schemaV10 = `
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
`

/** Per-user model grants and durable, user-scoped setting mutation receipts. */
export const schemaV11 = `
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
`

/** Immutable executable Skill versions and short-lived browser upload intent. */
export const schemaV12 = `
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
`

/** User-controlled built-in Plugin state, separate from platform connector capabilities. */
export const schemaV13 = `
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
`

/** One user-scoped, operator-owned, read-only remote MCP connection. */
export const schemaV14 = `
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
`

/** Personal SSH metadata, one-use credential intake, and encrypted credential revisions. */
export const schemaV15 = `
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
`

/** Durable SSH call admission and fenced Runner dispatch without plaintext credentials or commands. */
export const schemaV16 = `
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
`

/** User-scoped process MCP preset, durable Runner calls, and one session continuation per result. */
export const schemaV17 = `
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
`

/** Encrypted, approval-bound SSH command proposals and Session-visible outcomes. */
export const schemaV18 = `
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
`

/** Share login windows and worker limits across trusted Platform replicas. */
export const schemaV19 = `
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
`

/** Deduplicate catalog installations even when several requests select an existing package version. */
export const schemaV20 = `
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
`

/** Preserve opaque native events and command results, including escaped NUL characters. */
export const schemaV21 = `
ALTER TABLE pe_cloud_executions ALTER COLUMN result TYPE json USING result::json;
ALTER TABLE pe_desktop_executions ALTER COLUMN result TYPE json USING result::json;
ALTER TABLE pe_connector_actions ALTER COLUMN result TYPE json USING result::json;
ALTER TABLE pe_events ALTER COLUMN event TYPE json USING event::json;
UPDATE pe_schema SET version=21 WHERE version=20;
`

/** Remote MCP management versions and exact per-operation tool snapshots. */
export const schemaV22 = `${mcpConnectionsSchemaV22}
ALTER TABLE pe_operations ADD COLUMN remote_mcp_selection json NOT NULL DEFAULT '[]'::json;
UPDATE pe_schema SET version=22 WHERE version=21;
`

/** Revocable MCP approvals, one-use dispatch intent, and continuation budgets. */
export const schemaV23 = `${mcpActionsSchemaV23}
UPDATE pe_schema SET version=23 WHERE version=22;
`

/** Immutable SSH configuration and credential versions with owner-scoped mutation receipts. */
export const schemaV24 = `${sshSchemaV24}
UPDATE pe_schema SET version=24 WHERE version=23;
`

/** Account authority, audience isolation, durable mutation receipts and identity tombstones. */
export const schemaV25 = `${accountSchemaV25}
UPDATE pe_schema SET version=25 WHERE version=24;
`

/** Bind immutable publication retries to an optional expected source digest. */
export const schemaV26 = `
ALTER TABLE pe_artifacts ADD COLUMN expected_revision text
  CHECK (expected_revision IS NULL OR expected_revision ~ '^[a-f0-9]{64}$');
UPDATE pe_schema SET version=26 WHERE version=25;
`
