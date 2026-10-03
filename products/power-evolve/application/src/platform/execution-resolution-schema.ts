/** Adjacent Cloud execution reconciliation migration; existing unknown executions stay unchanged. */

/** Durable cleanup ownership, frozen writer identities and lossless observed results. */
export const schemaV28 = `
ALTER TABLE pe_cloud_executions DROP CONSTRAINT pe_cloud_executions_state_check;
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_state_check
  CHECK (state IN ('queued','starting','running','cancelling','succeeded','failed','cancelled','uncertain','closed_unknown'));
ALTER TABLE pe_cloud_executions ADD CONSTRAINT pe_cloud_executions_resolution_owner
  UNIQUE(id,user_id,session_id);
ALTER TABLE pe_cloud_executions ADD COLUMN dispatch_request json;
CREATE TABLE pe_cloud_execution_resolutions (
  id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id), execution_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  workspace_id uuid NOT NULL REFERENCES pe_workspaces(id),
  mount_generation bigint NOT NULL CHECK (mount_generation > 0), sandbox_name text NOT NULL,
  pod_uid uuid NOT NULL, runner_instance_id uuid NOT NULL,
  binding_snapshot jsonb NOT NULL CHECK (jsonb_typeof(binding_snapshot)='object'),
  execution_request_digest text NOT NULL CHECK (execution_request_digest ~ '^[a-f0-9]{64}$'),
  runner_request_digest text CHECK (runner_request_digest ~ '^[a-f0-9]{64}$'),
  note text NOT NULL CHECK (char_length(note)<=500),
  state text NOT NULL CHECK (state IN ('accepted','stopping','completed','blocked')),
  observed_result json, stop_evidence jsonb,
  final_execution_state text CHECK (final_execution_state IN ('succeeded','failed','cancelled','closed_unknown')),
  continuation_request_id uuid NOT NULL UNIQUE,
  continuation_queued boolean NOT NULL DEFAULT false, error_code text,
  lease_owner uuid, lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch>=0), lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(execution_id,user_id,session_id) REFERENCES pe_cloud_executions(id,user_id,session_id),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK (state<>'completed' OR (final_execution_state IS NOT NULL AND stop_evidence IS NOT NULL AND error_code IS NULL)),
  CHECK (state='completed' OR (final_execution_state IS NULL AND NOT continuation_queued)),
  CHECK ((state='blocked')=(error_code IS NOT NULL))
);
CREATE INDEX pe_cloud_execution_resolutions_pending ON pe_cloud_execution_resolutions(lease_until,created_at)
  WHERE state IN ('accepted','stopping');
CREATE INDEX pe_cloud_execution_resolutions_slot ON pe_cloud_execution_resolutions(user_id,mount_generation,pod_uid);
UPDATE pe_schema SET version=28 WHERE version=27;
`
