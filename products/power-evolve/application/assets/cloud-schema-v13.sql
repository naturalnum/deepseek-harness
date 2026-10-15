-- Independent service owners share the native physical provider without a user-wide mount slot.
CREATE TABLE pe_native_execution_services (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  workspace_id uuid NOT NULL REFERENCES pe_workspaces(id),
  authority_kind text NOT NULL CHECK (authority_kind IN ('cloud-command','stdio-action','mcp-service')),
  authority_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  owner_id uuid NOT NULL,
  grant_digest text NOT NULL,
  source_snapshot jsonb NOT NULL,
  lease_until timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX pe_native_execution_service_owners
  ON pe_native_execution_services(authority_kind,authority_id,authority_epoch) WHERE revoked_at IS NULL;
ALTER TABLE pe_native_execution_worlds
  ALTER COLUMN agent_id DROP NOT NULL,
  ALTER COLUMN operation_id DROP NOT NULL,
  ALTER COLUMN operation_epoch DROP NOT NULL,
  ADD COLUMN service_id uuid REFERENCES pe_native_execution_services(id),
  ADD COLUMN service_epoch bigint,
  ADD COLUMN authority_kind text,
  ADD CONSTRAINT pe_native_execution_world_owner CHECK (
    (service_id IS NULL AND service_epoch IS NULL AND authority_kind IS NULL
      AND agent_id IS NOT NULL AND operation_id IS NOT NULL AND operation_epoch IS NOT NULL)
    OR (service_id IS NOT NULL AND service_epoch IS NOT NULL AND service_epoch > 0
      AND authority_kind IS NOT NULL AND authority_kind IN ('cloud-command','stdio-action','mcp-service')
      AND agent_id IS NULL AND operation_id IS NULL AND operation_epoch IS NULL)
  );
CREATE UNIQUE INDEX pe_native_execution_service_world ON pe_native_execution_worlds(service_id)
  WHERE service_id IS NOT NULL;
ALTER TABLE pe_native_execution_processes ADD COLUMN activation_digest text;
UPDATE pe_native_execution_processes SET activation_digest=request_digest;
CREATE FUNCTION pe_native_execution_activation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.activation_digest IS NOT NULL AND OLD.activation_digest IS DISTINCT FROM NEW.activation_digest THEN
    RAISE EXCEPTION 'Native process activation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_execution_activation_immutable BEFORE UPDATE ON pe_native_execution_processes
  FOR EACH ROW EXECUTE FUNCTION pe_native_execution_activation_immutable();
CREATE FUNCTION pe_native_execution_service_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.session_id IS DISTINCT FROM NEW.session_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.authority_kind IS DISTINCT FROM NEW.authority_kind OR OLD.authority_id IS DISTINCT FROM NEW.authority_id
    OR OLD.authority_epoch IS DISTINCT FROM NEW.authority_epoch OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.grant_digest IS DISTINCT FROM NEW.grant_digest OR OLD.source_snapshot IS DISTINCT FROM NEW.source_snapshot
    OR (OLD.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at) THEN
    RAISE EXCEPTION 'Native service execution owner is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_execution_service_immutable BEFORE UPDATE ON pe_native_execution_services
  FOR EACH ROW EXECUTE FUNCTION pe_native_execution_service_immutable();

CREATE TABLE pe_native_stdio_executions (
  action_id uuid PRIMARY KEY REFERENCES pe_stdio_v2_actions(id),
  world_id uuid NOT NULL UNIQUE REFERENCES pe_native_execution_worlds(id),
  process_id uuid NOT NULL UNIQUE,
  runner_instance_id uuid NOT NULL,
  prepared jsonb,
  observation jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION pe_native_stdio_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action_id IS DISTINCT FROM NEW.action_id OR OLD.world_id IS DISTINCT FROM NEW.world_id
    OR OLD.process_id IS DISTINCT FROM NEW.process_id OR OLD.runner_instance_id IS DISTINCT FROM NEW.runner_instance_id
    OR OLD.prepared IS NOT NULL AND OLD.prepared IS DISTINCT FROM NEW.prepared
    OR OLD.observation IS NOT NULL AND OLD.observation IS DISTINCT FROM NEW.observation THEN
    RAISE EXCEPTION 'Native STDIO execution is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_stdio_execution_immutable BEFORE UPDATE ON pe_native_stdio_executions
  FOR EACH ROW EXECUTE FUNCTION pe_native_stdio_execution_immutable();
