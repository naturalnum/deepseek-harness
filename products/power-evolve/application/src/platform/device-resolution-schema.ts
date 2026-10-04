/** Adjacent Device unknown-result closure migration; legacy facts and output remain unchanged. */

/** Independent approvals retain exact original Device stop facts and one original continuation. */
export const schemaV30 = `
ALTER TABLE pe_desktop_executions DROP CONSTRAINT pe_desktop_executions_state_check;
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_executions_state_check
  CHECK (state IN ('queued','running','cancelling','succeeded','failed','cancelled','uncertain','closed_unknown'));
ALTER TABLE pe_desktop_executions ADD CONSTRAINT pe_desktop_execution_resolution_owner
  UNIQUE(id,user_id,session_id);
CREATE TABLE pe_device_execution_resolutions (
  id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), execution_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot json NOT NULL,
  note text NOT NULL CHECK (char_length(note)<=500),
  state text NOT NULL CHECK (state='completed'),
  final_execution_state text NOT NULL CHECK (final_execution_state='closed_unknown'),
  continuation_request_id uuid NOT NULL UNIQUE,
  continuation_queued boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(execution_id,user_id,session_id) REFERENCES pe_desktop_executions(id,user_id,session_id)
);
UPDATE pe_schema SET version=30 WHERE version=29;
`
