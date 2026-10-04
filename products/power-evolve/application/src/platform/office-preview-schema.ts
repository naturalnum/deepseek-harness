/** Adjacent Office task migration; existing Session and execution records are preserved. */

/** Durable early cancellation, immutable source admission and unreleased parser reservations. */
export const schemaV32 = `
CREATE TABLE pe_office_preview_jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES pe_users(id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128 AND request_id !~ '[[:cntrl:]]'),
  generation text NOT NULL CHECK (generation ~ '^[a-f0-9]{64}$'),
  request_digest text CHECK (request_digest ~ '^[a-f0-9]{64}$'), request jsonb,
  session_id uuid, workspace_id uuid, binding_snapshot jsonb, source_snapshot jsonb, converter_snapshot jsonb,
  state text NOT NULL CHECK (state IN ('queued','creating','running','stopping','succeeded','failed','cancelled','blocked')),
  cancel_requested boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IN ('input-too-large','output-too-large','invalid-document','unsupported-format',
    'invalid-output','timeout','unavailable','failed','busy','source-changed')),
  deadline_at timestamptz, lease_owner uuid, lease_epoch integer NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  parser_slot integer CHECK (parser_slot >= 0),
  creation_intent jsonb, pod_identity jsonb, worker_observation jsonb, stop_evidence jsonb, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(user_id,request_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES pe_workspaces(id,user_id),
  FOREIGN KEY(session_id,user_id,workspace_id) REFERENCES pe_sessions(id,user_id,workspace_id),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state IN ('failed','blocked')) = (error_code IS NOT NULL)),
  CHECK ((state IN ('succeeded','failed','cancelled')) = (completed_at IS NOT NULL)),
  CHECK (
    (request_digest IS NULL AND state='cancelled' AND cancel_requested AND request IS NULL
      AND session_id IS NULL AND workspace_id IS NULL AND binding_snapshot IS NULL AND source_snapshot IS NULL
      AND converter_snapshot IS NULL AND deadline_at IS NULL AND creation_intent IS NULL AND pod_identity IS NULL
      AND worker_observation IS NULL AND stop_evidence IS NULL AND result IS NULL AND lease_owner IS NULL
      AND lease_until IS NULL AND lease_epoch=0 AND attempts=0 AND parser_slot IS NULL)
    OR
    (request_digest IS NOT NULL AND request IS NOT NULL AND session_id IS NOT NULL AND workspace_id IS NOT NULL
      AND binding_snapshot IS NOT NULL AND source_snapshot IS NOT NULL AND converter_snapshot IS NOT NULL
      AND deadline_at IS NOT NULL)
  ),
  CHECK (parser_slot IS NULL OR (creation_intent IS NOT NULL AND state IN ('creating','running','stopping','blocked'))),
  CHECK (creation_intent IS NULL OR parser_slot IS NOT NULL
    OR (state IN ('succeeded','failed','cancelled') AND stop_evidence IS NOT NULL)),
  CHECK (pod_identity IS NULL OR creation_intent IS NOT NULL),
  CHECK (worker_observation IS NULL OR pod_identity IS NOT NULL),
  CHECK (stop_evidence IS NULL OR creation_intent IS NOT NULL),
  CHECK (state <> 'succeeded' OR (result IS NOT NULL AND stop_evidence IS NOT NULL)),
  CHECK (request IS NULL OR jsonb_typeof(request)='object'),
  CHECK (binding_snapshot IS NULL OR jsonb_typeof(binding_snapshot)='object'),
  CHECK (source_snapshot IS NULL OR jsonb_typeof(source_snapshot)='object'),
  CHECK (converter_snapshot IS NULL OR jsonb_typeof(converter_snapshot)='object'),
  CHECK (creation_intent IS NULL OR jsonb_typeof(creation_intent)='object'),
  CHECK (pod_identity IS NULL OR jsonb_typeof(pod_identity)='object'),
  CHECK (worker_observation IS NULL OR jsonb_typeof(worker_observation)='object'),
  CHECK (stop_evidence IS NULL OR jsonb_typeof(stop_evidence)='object'),
  CHECK (result IS NULL OR jsonb_typeof(result)='object')
);
CREATE UNIQUE INDEX pe_office_preview_parser_slots ON pe_office_preview_jobs(parser_slot) WHERE parser_slot IS NOT NULL;
CREATE INDEX pe_office_preview_pending ON pe_office_preview_jobs(created_at)
  WHERE state IN ('queued','creating','running','stopping','blocked');
CREATE INDEX pe_office_preview_user ON pe_office_preview_jobs(user_id,created_at DESC);
CREATE FUNCTION pe_office_preview_keep_cancelled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.request_digest IS NULL AND (NEW.request_digest IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.generation IS DISTINCT FROM OLD.generation) THEN
    RAISE EXCEPTION 'Office cancellation cannot become an admission' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_office_preview_cancelled BEFORE UPDATE ON pe_office_preview_jobs
  FOR EACH ROW EXECUTE FUNCTION pe_office_preview_keep_cancelled();
UPDATE pe_schema SET version=32 WHERE version=31;
`
