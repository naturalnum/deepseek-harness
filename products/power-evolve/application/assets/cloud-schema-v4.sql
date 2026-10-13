-- Adjacent Session writer occupancy; independent of operation/execution capacity.
-- Released rows retain exact owner/digest/epoch for retry and fencing.
CREATE TABLE pe_native_writers (
  session_id uuid PRIMARY KEY REFERENCES pe_sessions(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0 AND epoch <= 9007199254740991),
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz
);
