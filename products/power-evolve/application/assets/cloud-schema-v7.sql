-- Foreground native tools retain their request and never create a continuation operation.
ALTER TABLE pe_cloud_executions
  ADD COLUMN result_delivery text NOT NULL DEFAULT 'continuation',
  ADD COLUMN requested_timeout_ms integer,
  ADD COLUMN command_timeout_ms integer,
  ADD COLUMN native_tool_grant_digest text,
  ADD COLUMN native_tool_credential_version integer,
  ADD COLUMN native_tool_stop_request_id uuid,
  ADD COLUMN native_tool_stop_target jsonb,
  ADD CONSTRAINT pe_cloud_executions_result_delivery CHECK (result_delivery IN ('continuation','native_tool')),
  ADD CONSTRAINT pe_cloud_executions_timeout CHECK (
    (requested_timeout_ms IS NULL OR requested_timeout_ms>0)
    AND (command_timeout_ms IS NULL OR command_timeout_ms>0)),
  ADD CONSTRAINT pe_cloud_executions_native_tool_identity CHECK (
    result_delivery<>'native_tool' OR (execution_kind='legacy_command'
      AND requested_timeout_ms IS NOT NULL AND command_timeout_ms IS NOT NULL
      AND requested_timeout_ms BETWEEN 1000 AND 300000 AND command_timeout_ms BETWEEN 1000 AND 300000
      AND native_tool_grant_digest IS NOT NULL AND native_tool_grant_digest ~ '^[a-f0-9]{64}$'
      AND native_tool_credential_version IS NOT NULL AND native_tool_credential_version>0)),
  ADD CONSTRAINT pe_cloud_executions_native_tool_stop CHECK (
    (native_tool_stop_request_id IS NULL AND native_tool_stop_target IS NULL)
    OR (result_delivery='native_tool' AND native_tool_stop_request_id IS NOT NULL
      AND native_tool_stop_target IS NOT NULL AND jsonb_typeof(native_tool_stop_target)='object'));

CREATE FUNCTION pe_cloud_execution_keep_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.result_delivery,NEW.requested_timeout_ms,NEW.command_timeout_ms,
      NEW.native_tool_grant_digest,NEW.native_tool_credential_version)
    IS DISTINCT FROM ROW(OLD.result_delivery,OLD.requested_timeout_ms,OLD.command_timeout_ms,
      OLD.native_tool_grant_digest,OLD.native_tool_credential_version) THEN
    RAISE EXCEPTION 'Cloud execution delivery and original request are immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.result_delivery='native_tool' AND (
      ROW(NEW.id,NEW.user_id,NEW.session_id,NEW.operation_id,NEW.call_id,NEW.command,NEW.cwd,NEW.request_digest,NEW.execution_kind)
        IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.session_id,OLD.operation_id,OLD.call_id,OLD.command,OLD.cwd,OLD.request_digest,OLD.execution_kind)
      OR (OLD.dispatch_request IS NOT NULL AND NEW.dispatch_request::jsonb IS DISTINCT FROM OLD.dispatch_request::jsonb)
      OR (OLD.native_tool_stop_request_id IS NOT NULL AND
        ROW(NEW.native_tool_stop_request_id,NEW.native_tool_stop_target)
          IS DISTINCT FROM ROW(OLD.native_tool_stop_request_id,OLD.native_tool_stop_target))) THEN
    RAISE EXCEPTION 'Native tool execution and exact stop identity are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_cloud_execution_keep_delivery BEFORE UPDATE ON pe_cloud_executions
  FOR EACH ROW EXECUTE FUNCTION pe_cloud_execution_keep_delivery();

CREATE FUNCTION pe_operation_require_continuation_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source='sandbox_result' AND EXISTS (
    SELECT 1 FROM pe_cloud_executions WHERE id=NEW.source_execution_id AND result_delivery='native_tool') THEN
    RAISE EXCEPTION 'Native tool results cannot create continuation operations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_operation_require_continuation_delivery BEFORE INSERT ON pe_operations
  FOR EACH ROW EXECUTE FUNCTION pe_operation_require_continuation_delivery();
