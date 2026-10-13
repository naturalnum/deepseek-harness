-- Adjacent private journal generation. Ciphertext never enters public preference projections.
CREATE TABLE pe_native_retained_intents (
  intent_id text PRIMARY KEY CHECK (intent_id ~ '^[a-f0-9]{64}$'),
  mutation_key text NOT NULL CHECK (mutation_key ~ '^[a-f0-9]{64}$'),
  family text NOT NULL CHECK (family IN ('publication','admission','claim','queue','step',
    'prepared-cancel','archive-cancel','turn-transition')),
  fence_kind text NOT NULL CHECK (fence_kind IN ('operation','operation-and-writer')),
  user_id uuid NOT NULL REFERENCES pe_users(id),
  session_id uuid NOT NULL REFERENCES pe_sessions(id),
  operation_id uuid NOT NULL REFERENCES pe_operations(id),
  operation_epoch integer NOT NULL CHECK (operation_epoch>0),
  operation_digest text NOT NULL CHECK (operation_digest ~ '^[a-f0-9]{64}$'),
  worker_id uuid NOT NULL,
  writer_epoch bigint CHECK (writer_epoch BETWEEN 1 AND 9007199254740991),
  writer_digest text CHECK (writer_digest ~ '^[a-f0-9]{64}$'),
  prepared_event_count integer NOT NULL CHECK (prepared_event_count>=0),
  request_sealed bytea CHECK (octet_length(request_sealed)>28),
  request_bytes integer NOT NULL CHECK (request_bytes>=0),
  state text NOT NULL CHECK (state IN ('prepared','committed','abandoned')),
  receipt_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (session_id,family,mutation_key),
  FOREIGN KEY (operation_id,operation_epoch) REFERENCES pe_attempts(operation_id,epoch),
  CHECK ((writer_epoch IS NULL)=(writer_digest IS NULL)),
  CHECK ((family='publication' AND fence_kind='operation' AND writer_epoch IS NULL)
    OR (family<>'publication' AND fence_kind='operation-and-writer' AND writer_epoch IS NOT NULL)),
  CHECK ((request_sealed IS NOT NULL AND request_bytes>0 AND resolved_at IS NULL)
    OR (request_sealed IS NULL AND request_bytes=0 AND resolved_at IS NOT NULL AND state='committed')),
  CHECK ((state='committed' AND receipt_json IS NOT NULL AND receipt_json->>'family'=family)
    OR (state IN ('prepared','abandoned') AND receipt_json IS NULL))
);
CREATE INDEX pe_native_retained_intents_worker ON pe_native_retained_intents(worker_id,created_at,intent_id);
CREATE INDEX pe_native_retained_intents_pending ON pe_native_retained_intents(session_id) WHERE state='prepared';

CREATE FUNCTION pe_native_retained_intent_keep_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state='committed' AND OLD.request_sealed IS NOT NULL
    AND NEW.request_sealed IS NULL AND NEW.request_bytes=0 AND NEW.resolved_at IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['request_sealed','request_bytes','resolved_at','updated_at'])
      IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['request_sealed','request_bytes','resolved_at','updated_at']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.state<>'prepared' OR NEW.state NOT IN ('committed','abandoned')
    OR (to_jsonb(NEW)-ARRAY['state','receipt_json','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','receipt_json','updated_at']) THEN
    RAISE EXCEPTION 'Native retained intent identity and terminal result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pe_native_retained_intents_keep BEFORE UPDATE OR DELETE ON pe_native_retained_intents
  FOR EACH ROW EXECUTE FUNCTION pe_native_retained_intent_keep_identity();
