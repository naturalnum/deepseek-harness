/** Adjacent no-start receipts retain cancellation separately from actual Runner outcomes. */

/** Bind one immutable no-start closure to its original action, execution and worker generation. */
export const schemaV36 = `
CREATE TABLE pe_stdio_v2_no_start_closures (
  action_id uuid PRIMARY KEY, user_id uuid NOT NULL, session_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('discover','call')),
  execution_target text NOT NULL CHECK (execution_target='cloud'),
  execution_id uuid NOT NULL UNIQUE, task_digest text NOT NULL CHECK (task_digest ~ '^[a-f0-9]{64}$'),
  prepared_digest text CHECK (prepared_digest IS NULL OR prepared_digest ~ '^[a-f0-9]{64}$'),
  worker_id uuid NOT NULL, lease_epoch bigint NOT NULL CHECK (lease_epoch>0),
  receipt json NOT NULL CHECK ((json_typeof(receipt)='object') IS TRUE),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(action_id,user_id,session_id,phase,execution_target,execution_id,task_digest)
    REFERENCES pe_stdio_v2_actions(id,user_id,session_id,phase,execution_target,execution_id,task_digest)
);
CREATE TRIGGER pe_stdio_v2_no_start_closures_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_no_start_closures
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
CREATE FUNCTION pe_stdio_v2_exclude_closed_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM pe_stdio_v2_actions WHERE id=NEW.action_id FOR UPDATE;
  IF TG_TABLE_NAME='pe_stdio_v2_no_start_closures' THEN
    IF EXISTS(SELECT 1 FROM pe_stdio_v2_start_permits WHERE action_id=NEW.action_id)
      OR EXISTS(SELECT 1 FROM pe_stdio_v2_results WHERE action_id=NEW.action_id) THEN
      RAISE EXCEPTION 'STDIO start authority conflicts with no-start closure' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS(SELECT 1 FROM pe_stdio_v2_no_start_closures WHERE action_id=NEW.action_id) THEN
    RAISE EXCEPTION 'STDIO no-start closure excludes start authority and Runner results' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
${['no_start_closures', 'start_permits', 'results'].map(name => `
CREATE CONSTRAINT TRIGGER pe_stdio_v2_${name}_exclude_closed_start AFTER INSERT ON pe_stdio_v2_${name}
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_exclude_closed_start();`).join('\n')}
UPDATE pe_schema SET version=36 WHERE version=35;
`
