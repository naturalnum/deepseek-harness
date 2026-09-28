/** Initial PG schema. Session bytes and operation ownership commit in the same database. */
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
  SELECT id,settings->>'model',settings->>'model',8192,true FROM pe_users;
UPDATE pe_schema SET version=11 WHERE version=10;
`
