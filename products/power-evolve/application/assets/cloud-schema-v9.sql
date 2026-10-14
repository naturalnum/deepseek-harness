-- Native execution worlds freeze storage, permission and original operation authority.
CREATE TABLE pe_native_execution_worlds (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 256),
  operation_id uuid NOT NULL REFERENCES pe_operations(id),
  operation_epoch bigint NOT NULL CHECK (operation_epoch > 0),
  grant_digest text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES pe_workspaces(id),
  storage_generation bigint NOT NULL CHECK (storage_generation > 0),
  permission_generation bigint NOT NULL CHECK (permission_generation > 0),
  mode text NOT NULL CHECK (mode IN ('read-only','workspace-write','danger-full-access')),
  binding_snapshot jsonb NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pe_native_execution_processes (
  id uuid PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES pe_native_execution_worlds(id),
  kind text NOT NULL CHECK (kind IN ('process','terminal','filesystem')),
  namespace text NOT NULL,
  pod_name text NOT NULL,
  pod_uid text,
  state text NOT NULL CHECK (state IN ('admitted','creating','running','stopping','stopped','uncertain')),
  request_digest text NOT NULL,
  first_stop_cause text CHECK (first_stop_cause IN ('abort','authority','dispose','completed','failure')),
  stop_evidence jsonb,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state <> 'stopped' OR stop_evidence IS NOT NULL)
);
CREATE UNIQUE INDEX pe_native_execution_pod_names ON pe_native_execution_processes(namespace,pod_name);
CREATE FUNCTION pe_native_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.world_id IS DISTINCT FROM NEW.world_id OR OLD.namespace IS DISTINCT FROM NEW.namespace
    OR OLD.pod_name IS DISTINCT FROM NEW.pod_name OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
    OR (OLD.pod_uid IS NOT NULL AND OLD.pod_uid IS DISTINCT FROM NEW.pod_uid)
    OR (OLD.first_stop_cause IS NOT NULL AND OLD.first_stop_cause IS DISTINCT FROM NEW.first_stop_cause) THEN
    RAISE EXCEPTION 'Native execution identity and first stop cause are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_execution_immutable BEFORE UPDATE ON pe_native_execution_processes
  FOR EACH ROW EXECUTE FUNCTION pe_native_execution_immutable();
