-- Adjacent trusted tenant runtime credentials and bounded native subagent derivations.
CREATE TABLE pe_runtime_credentials (
  id uuid PRIMARY KEY,
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  runtime_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL CHECK (generation > 0),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,generation)
);
CREATE TABLE pe_native_subagent_grants (
  session_id uuid PRIMARY KEY REFERENCES pe_sessions(id),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  operation_id uuid NOT NULL UNIQUE REFERENCES pe_operations(id),
  parent_session_id uuid NOT NULL REFERENCES pe_sessions(id),
  parent_operation_id uuid NOT NULL REFERENCES pe_operations(id),
  parent_epoch bigint NOT NULL CHECK (parent_epoch > 0),
  parent_digest text NOT NULL CHECK (parent_digest ~ '^[a-f0-9]{64}$'),
  parent_writer_epoch bigint NOT NULL CHECK (parent_writer_epoch > 0),
  worker_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (session_id <> parent_session_id)
);
CREATE INDEX pe_native_subagent_parent ON pe_native_subagent_grants(parent_session_id,parent_epoch);
