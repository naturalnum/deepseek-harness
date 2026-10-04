/** Adjacent Device identity migration; legacy commands receive no invented dispatch or stop evidence. */

/** Frozen command requests, process-bound dispatches, container capture and durable stop reports. */
export const schemaV29 = `
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
`
