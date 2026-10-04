/** Adjacent migration for permanent interrupted-claim fences; legacy execution facts remain unchanged. */

/** One immutable no-start receipt and original continuation per interrupted Device execution. */
export const schemaV31 = `
CREATE TABLE pe_device_claim_closures (
  id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), execution_id uuid NOT NULL UNIQUE,
  device_id uuid NOT NULL REFERENCES pe_devices(id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request json NOT NULL, receipt json NOT NULL,
  continuation_request_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(execution_id,user_id,session_id) REFERENCES pe_desktop_executions(id,user_id,session_id)
);
UPDATE pe_schema SET version=31 WHERE version=30;
`
