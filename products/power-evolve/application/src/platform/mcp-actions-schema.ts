/** V23 action history, revocable human permissions, and budgets shared by continuation operations. */
export const mcpActionsSchemaV23 = `
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
`
