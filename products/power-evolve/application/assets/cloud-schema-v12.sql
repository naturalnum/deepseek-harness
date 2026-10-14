-- Native descendants keep the exact parent permission ceiling and reject later parent policy generations.
ALTER TABLE pe_native_subagent_grants ADD COLUMN parent_mode text CHECK(parent_mode IN ('read-only','workspace-write','danger-full-access'));
ALTER TABLE pe_native_subagent_grants ADD COLUMN parent_permission_generation bigint CHECK(parent_permission_generation>0);
-- Interactive Session occupancy has its own bounded browser/Runtime derivation and never owns model input.
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_check;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_check CHECK (source IN
  ('user','native_interactive','platform_action','sandbox_result','stdio_mcp_result','ssh_execute_result','remote_mcp_result','stdio_v2_result','stdio_v2_no_start'));
ALTER TABLE pe_operations DROP CONSTRAINT pe_operations_source_action;
ALTER TABLE pe_operations ADD CONSTRAINT pe_operations_source_action CHECK (
  (source IN ('user','native_interactive') AND num_nonnulls(source_action_id,source_execution_id,source_stdio_mcp_call_id,
    source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id,source_stdio_v2_no_start_action_id)=0
    AND source_stdio_v2_phase IS NULL)
  OR (source NOT IN ('user','native_interactive') AND num_nonnulls(source_action_id,source_execution_id,source_stdio_mcp_call_id,
    source_ssh_execute_action_id,source_mcp_action_id,source_stdio_v2_action_id,source_stdio_v2_no_start_action_id)=1
    AND CASE source WHEN 'platform_action' THEN source_action_id WHEN 'sandbox_result' THEN source_execution_id
      WHEN 'stdio_mcp_result' THEN source_stdio_mcp_call_id WHEN 'ssh_execute_result' THEN source_ssh_execute_action_id
      WHEN 'remote_mcp_result' THEN source_mcp_action_id WHEN 'stdio_v2_result' THEN source_stdio_v2_action_id
      WHEN 'stdio_v2_no_start' THEN source_stdio_v2_no_start_action_id END IS NOT NULL
    AND ((source IN ('stdio_v2_result','stdio_v2_no_start') AND source_stdio_v2_phase='call')
      OR (source NOT IN ('stdio_v2_result','stdio_v2_no_start') AND source_stdio_v2_phase IS NULL))));
CREATE TABLE pe_native_interactive_grants (
  operation_id uuid PRIMARY KEY REFERENCES pe_operations(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  runtime_credential_id uuid NOT NULL REFERENCES pe_runtime_credentials(id),
  runtime_id uuid NOT NULL,
  runtime_generation integer NOT NULL CHECK(runtime_generation>0),
  browser_digest text NOT NULL CHECK(browser_digest ~ '^[a-f0-9]{64}$'),
  credential_version integer NOT NULL CHECK(credential_version>0),
  request_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(runtime_id,request_id)
);
CREATE INDEX pe_native_interactive_session ON pe_native_interactive_grants(session_id,expires_at);
CREATE TABLE pe_native_cleanup_receipts (
  operation_id uuid PRIMARY KEY REFERENCES pe_operations(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  worker_id uuid NOT NULL,
  operation_epoch bigint NOT NULL CHECK(operation_epoch>0),
  grant_digest text NOT NULL CHECK(grant_digest ~ '^[a-f0-9]{64}$'),
  writer_epoch bigint NOT NULL CHECK(writer_epoch>0),
  writer_digest text NOT NULL CHECK(writer_digest ~ '^[a-f0-9]{64}$'),
  error_code text NOT NULL,
  receipt jsonb NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
