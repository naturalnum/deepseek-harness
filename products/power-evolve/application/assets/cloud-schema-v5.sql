-- Adjacent native input audit, exact execution frames and version-two turn receipts.
-- Original operation and Session Writer bearers remain outside durable records.
CREATE TABLE pe_native_turn_frames (
  operation_id uuid NOT NULL REFERENCES pe_operations(id),
  operation_epoch bigint NOT NULL CHECK (operation_epoch BETWEEN 1 AND 2147483647),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  writer_epoch bigint NOT NULL CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  request_id uuid NOT NULL,
  message_id uuid NOT NULL,
  grant_digest text NOT NULL UNIQUE CHECK (grant_digest ~ '^[a-f0-9]{64}$'),
  frame_json jsonb NOT NULL,
  grant_json jsonb NOT NULL CHECK (NOT (grant_json ? 'token')),
  prepared_event_count integer NOT NULL CHECK (prepared_event_count >= 0),
  PRIMARY KEY (operation_id, operation_epoch),
  FOREIGN KEY (operation_id, operation_epoch) REFERENCES pe_attempts(operation_id, epoch),
  UNIQUE (session_id, operation_epoch),
  FOREIGN KEY (session_id, request_id) REFERENCES pe_operations(session_id, request_id)
);

ALTER TABLE pe_native_turn_frames ADD CONSTRAINT pe_native_frames_exact_identity
  UNIQUE (operation_id, operation_epoch, session_id, writer_epoch);
ALTER TABLE pe_operations ADD CONSTRAINT pe_native_origin_exact_operation
  UNIQUE (id, session_id, request_id);

CREATE TABLE pe_native_input_origins (
  origin_input_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  origin_operation_id uuid NOT NULL UNIQUE,
  original_request_id uuid NOT NULL,
  message_id uuid NOT NULL,
  accepted_snapshot_digest text NOT NULL CHECK (accepted_snapshot_digest ~ '^[a-f0-9]{64}$'),
  accepted_audit_json jsonb NOT NULL CHECK (jsonb_typeof(accepted_audit_json)='object'
    AND NOT (accepted_audit_json ?| ARRAY['token','epoch','executionEnabled','skills'])),
  UNIQUE (origin_input_id, session_id),
  UNIQUE (origin_input_id, origin_operation_id, session_id),
  UNIQUE (session_id, message_id),
  FOREIGN KEY (origin_operation_id, session_id, original_request_id) REFERENCES pe_operations(id, session_id, request_id)
);

CREATE TABLE pe_native_input_commands (
  command_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('browser','writer')),
  actor_id uuid NOT NULL,
  writer_epoch bigint CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  transport_nonce text NOT NULL CHECK (length(transport_nonce) BETWEEN 1 AND 128),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('admission','edit','remove','retarget','claim')),
  target_origin_input_id uuid,
  committed_event_count integer NOT NULL CHECK (committed_event_count >= 0),
  receipt_json jsonb NOT NULL CHECK (jsonb_typeof(receipt_json)='object'
    AND NOT (receipt_json ?| ARRAY['token','grant','operationToken','candidateToken'])),
  PRIMARY KEY (session_id, command_id),
  UNIQUE (session_id, command_id, kind),
  UNIQUE NULLS NOT DISTINCT (session_id, actor_kind, actor_id, writer_epoch, transport_nonce),
  FOREIGN KEY (target_origin_input_id, session_id) REFERENCES pe_native_input_origins(origin_input_id, session_id),
  CHECK ((actor_kind='browser' AND writer_epoch IS NULL AND actor_id=user_id AND kind<>'claim')
    OR (actor_kind='writer' AND writer_epoch IS NOT NULL)),
  CHECK ((kind='claim' AND target_origin_input_id IS NULL)
    OR (kind<>'claim' AND target_origin_input_id IS NOT NULL))
);

CREATE TABLE pe_native_input_revisions (
  origin_input_id uuid NOT NULL,
  session_id uuid NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision >= 1),
  previous_revision integer,
  cause text NOT NULL CHECK (cause IN ('admission','edit')),
  message_json jsonb NOT NULL CHECK (jsonb_typeof(message_json)='object'),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  committed_splice_seq integer NOT NULL CHECK (committed_splice_seq >= 0),
  command_id uuid NOT NULL,
  command_kind text NOT NULL,
  PRIMARY KEY (origin_input_id, input_revision),
  UNIQUE (origin_input_id, input_revision, session_id, input_digest),
  FOREIGN KEY (origin_input_id, session_id) REFERENCES pe_native_input_origins(origin_input_id, session_id),
  FOREIGN KEY (origin_input_id, previous_revision) REFERENCES pe_native_input_revisions(origin_input_id, input_revision),
  FOREIGN KEY (session_id, committed_splice_seq) REFERENCES pe_events(session_id, seq),
  FOREIGN KEY (session_id, command_id, command_kind) REFERENCES pe_native_input_commands(session_id, command_id, kind),
  CHECK ((input_revision=1 AND previous_revision IS NULL AND cause='admission' AND command_kind='admission')
    OR (input_revision>1 AND previous_revision IS NOT NULL AND previous_revision=input_revision-1 AND cause='edit' AND command_kind='edit'))
);

CREATE TABLE pe_native_input_cohorts (
  cohort_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  execution_operation_id uuid NOT NULL,
  operation_epoch bigint NOT NULL CHECK (operation_epoch BETWEEN 1 AND 2147483647),
  writer_epoch bigint NOT NULL CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  frozen_snapshot_digest text NOT NULL CHECK (frozen_snapshot_digest ~ '^[a-f0-9]{64}$'),
  owner_kind text NOT NULL CHECK (owner_kind IN ('next-turn-head','first-next-step','current-frame')),
  owner_origin_input_id uuid NOT NULL,
  owner_input_revision integer NOT NULL,
  owner_input_digest text NOT NULL,
  turn_start_seq integer NOT NULL CHECK (turn_start_seq >= 0),
  turn_number integer NOT NULL CHECK (turn_number >= 1),
  boundary_ordinal integer NOT NULL CHECK (boundary_ordinal >= 0),
  step_start_seq integer CHECK (step_start_seq > turn_start_seq),
  claim_count integer NOT NULL CHECK (claim_count >= 0),
  command_id uuid NOT NULL,
  command_kind text NOT NULL DEFAULT 'claim' CHECK (command_kind='claim'),
  UNIQUE (cohort_id, session_id),
  UNIQUE (session_id, execution_operation_id, operation_epoch, turn_start_seq, boundary_ordinal),
  UNIQUE (session_id, step_start_seq),
  UNIQUE (session_id, command_id),
  FOREIGN KEY (execution_operation_id, operation_epoch, session_id, writer_epoch)
    REFERENCES pe_native_turn_frames(operation_id, operation_epoch, session_id, writer_epoch),
  FOREIGN KEY (owner_origin_input_id, execution_operation_id, session_id)
    REFERENCES pe_native_input_origins(origin_input_id, origin_operation_id, session_id),
  FOREIGN KEY (owner_origin_input_id, owner_input_revision, session_id, owner_input_digest)
    REFERENCES pe_native_input_revisions(origin_input_id, input_revision, session_id, input_digest),
  FOREIGN KEY (session_id, turn_start_seq) REFERENCES pe_events(session_id, seq),
  FOREIGN KEY (session_id, step_start_seq) REFERENCES pe_events(session_id, seq),
  FOREIGN KEY (session_id, command_id, command_kind) REFERENCES pe_native_input_commands(session_id, command_id, kind)
);

CREATE TABLE pe_native_input_claims (
  origin_input_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  input_revision integer NOT NULL,
  input_digest text NOT NULL,
  cohort_id uuid NOT NULL,
  claim_splice_seq integer NOT NULL CHECK (claim_splice_seq >= 0),
  splice_item_ordinal integer NOT NULL CHECK (splice_item_ordinal >= 0),
  cohort_ordinal integer NOT NULL CHECK (cohort_ordinal >= 0),
  target text NOT NULL CHECK (target IN ('next-step','next-turn')),
  UNIQUE (session_id, claim_splice_seq, splice_item_ordinal),
  UNIQUE (cohort_id, cohort_ordinal),
  FOREIGN KEY (origin_input_id, input_revision, session_id, input_digest)
    REFERENCES pe_native_input_revisions(origin_input_id, input_revision, session_id, input_digest),
  FOREIGN KEY (cohort_id, session_id) REFERENCES pe_native_input_cohorts(cohort_id, session_id),
  FOREIGN KEY (session_id, claim_splice_seq) REFERENCES pe_events(session_id, seq)
);

CREATE INDEX pe_native_input_claims_cohort ON pe_native_input_claims(cohort_id);
CREATE INDEX pe_native_input_removals ON pe_native_input_commands(target_origin_input_id) WHERE kind='remove';

-- This proves structural completeness, not native event semantics or execution authority.
CREATE FUNCTION pe_native_input_complete_cohort() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer; actual integer; first_ordinal integer; last_ordinal integer;
BEGIN
  SELECT claim_count INTO expected FROM pe_native_input_cohorts WHERE cohort_id=NEW.cohort_id;
  SELECT count(*), min(cohort_ordinal), max(cohort_ordinal) INTO actual, first_ordinal, last_ordinal
    FROM pe_native_input_claims WHERE cohort_id=NEW.cohort_id;
  IF actual IS DISTINCT FROM expected OR (actual>0 AND (first_ordinal<>0 OR last_ordinal<>actual-1))
    OR (SELECT count(*) FROM pe_native_input_claims WHERE cohort_id=NEW.cohort_id AND target='next-turn')>1
    OR EXISTS (SELECT target FROM pe_native_input_claims WHERE cohort_id=NEW.cohort_id
      GROUP BY target HAVING count(DISTINCT claim_splice_seq)>1) THEN
    RAISE EXCEPTION 'Native input cohort is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER pe_native_input_cohort_complete AFTER INSERT ON pe_native_input_cohorts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_native_input_complete_cohort();
CREATE CONSTRAINT TRIGGER pe_native_input_claim_complete AFTER INSERT ON pe_native_input_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_native_input_complete_cohort();

-- Permanent facts cannot disappear when an execution expires or a revision changes.
CREATE FUNCTION pe_native_input_keep_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Native input audit facts are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER pe_native_input_origins_keep BEFORE UPDATE OR DELETE ON pe_native_input_origins
  FOR EACH ROW EXECUTE FUNCTION pe_native_input_keep_fact();
CREATE TRIGGER pe_native_input_revisions_keep BEFORE UPDATE OR DELETE ON pe_native_input_revisions
  FOR EACH ROW EXECUTE FUNCTION pe_native_input_keep_fact();
CREATE TRIGGER pe_native_input_commands_keep BEFORE UPDATE OR DELETE ON pe_native_input_commands
  FOR EACH ROW EXECUTE FUNCTION pe_native_input_keep_fact();
CREATE TRIGGER pe_native_input_claims_keep BEFORE UPDATE OR DELETE ON pe_native_input_claims
  FOR EACH ROW EXECUTE FUNCTION pe_native_input_keep_fact();

-- Claim survives without a step. A later real step may bind once, never rewrite the cohort.
CREATE FUNCTION pe_native_input_bind_step_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Native input cohort cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF OLD.step_start_seq IS NOT NULL OR NEW.step_start_seq IS NULL
    OR (to_jsonb(NEW)-'step_start_seq') IS DISTINCT FROM (to_jsonb(OLD)-'step_start_seq') THEN
    RAISE EXCEPTION 'Only one initial native step binding is mutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_input_cohorts_keep BEFORE UPDATE OR DELETE ON pe_native_input_cohorts
  FOR EACH ROW EXECUTE FUNCTION pe_native_input_bind_step_once();

CREATE TABLE pe_native_turn_transitions_v2 (
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  writer_epoch bigint NOT NULL CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  transition_id uuid NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  candidate_digest text NOT NULL UNIQUE CHECK (candidate_digest ~ '^[a-f0-9]{64}$'),
  from_operation_id uuid NOT NULL,
  from_operation_epoch bigint NOT NULL,
  receipt_json jsonb NOT NULL CHECK (receipt_json->>'version'='2'
    AND NOT (receipt_json ?| ARRAY['token','operationToken','candidateToken'])
    AND NOT ((receipt_json->'from') ? 'operationToken')
    AND NOT ((receipt_json->'result'->'grant') ? 'token')),
  PRIMARY KEY (session_id,writer_epoch,transition_id),
  UNIQUE (from_operation_id,from_operation_epoch),
  FOREIGN KEY (from_operation_id,from_operation_epoch,session_id,writer_epoch)
    REFERENCES pe_native_turn_frames(operation_id,operation_epoch,session_id,writer_epoch)
);
