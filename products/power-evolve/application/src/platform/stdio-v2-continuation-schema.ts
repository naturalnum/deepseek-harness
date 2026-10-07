/** Adjacent operation sources for a real no-start call closure, distinct from Runner results. */

/** Keep no-start continuations bound to their original call, Session and unique continuation request. */
export const schemaV37 = `
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
`
