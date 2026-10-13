-- Native foreground cancellation retains its first cause across every provider and retry.
ALTER TABLE pe_cloud_executions
  ADD COLUMN native_tool_cancel_cause text,
  ADD CONSTRAINT pe_cloud_executions_native_cancel_cause CHECK (
    native_tool_cancel_cause IS NULL OR (result_delivery='native_tool' AND cancel_requested
      AND native_tool_cancel_cause IN ('timeout','abort')));

CREATE FUNCTION pe_cloud_execution_capture_native_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.native_tool_cancel_cause IS NOT NULL
    AND NEW.native_tool_cancel_cause IS DISTINCT FROM OLD.native_tool_cancel_cause THEN
    RAISE EXCEPTION 'Native tool first cancellation cause is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.result_delivery='native_tool' AND NEW.cancel_requested AND NEW.native_tool_cancel_cause IS NULL THEN
    NEW.native_tool_cancel_cause := 'abort';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_cloud_execution_capture_native_cancel BEFORE INSERT OR UPDATE ON pe_cloud_executions
  FOR EACH ROW EXECUTE FUNCTION pe_cloud_execution_capture_native_cancel();

-- The prior protocol carried only an abort request. Preserve that known meaning.
UPDATE pe_cloud_executions SET native_tool_cancel_cause='abort'
  WHERE result_delivery='native_tool' AND cancel_requested;
