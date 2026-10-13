-- Adjacent native file intake; the original cloud generation remains unchanged.
CREATE TABLE pe_native_file_receipts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  storage_session_id uuid NOT NULL REFERENCES pe_sessions(id),
  file jsonb NOT NULL,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pe_native_file_receipts_session ON pe_native_file_receipts(user_id,session_id,request_id);
CREATE TABLE pe_native_prompt_inputs (
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  request_id uuid NOT NULL,
  submitted jsonb NOT NULL,
  admitted jsonb NOT NULL,
  PRIMARY KEY(session_id,request_id)
);
