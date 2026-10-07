/** Adjacent append-only STDIO observations; committed V34 originals remain immutable. */

/** Retain incomplete execution facts under their exact lease without prematurely writing a final result. */
export const schemaV35 = `
CREATE TABLE pe_stdio_v2_observations (
  id uuid PRIMARY KEY, action_id uuid NOT NULL REFERENCES pe_stdio_v2_actions(id),
  worker_id uuid NOT NULL, lease_epoch bigint NOT NULL CHECK (lease_epoch>0),
  observation json NOT NULL CHECK ((json_typeof(observation)='object') IS TRUE),
  observation_digest text NOT NULL CHECK (observation_digest ~ '^[a-f0-9]{64}$'),
  stop_evidence json CHECK (stop_evidence IS NULL OR (json_typeof(stop_evidence)='object') IS TRUE),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(action_id,observation_digest)
);
CREATE TRIGGER pe_stdio_v2_observations_original BEFORE UPDATE OR DELETE ON pe_stdio_v2_observations
  FOR EACH ROW EXECUTE FUNCTION pe_stdio_v2_keep_original();
UPDATE pe_schema SET version=35 WHERE version=34;
`
