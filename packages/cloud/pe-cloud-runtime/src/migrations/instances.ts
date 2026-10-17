/** Atomic five-field C-12 process-instance metadata migration. */

/** Existing schema differences reject without dropping rows, owners or prior instance identities. */
export const instanceMigrationSql = String.raw`DO $migration$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pe-cloud-runtime/instances/0001', 0));
  CREATE TEMP TABLE pg_temp._pe_instance_schema_0001 (
    instance_id text PRIMARY KEY,
    internal_address text NOT NULL,
    recipe_version text NOT NULL,
    phase text NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT pe_instance_id_nonempty CHECK (instance_id <> ''),
    CONSTRAINT pe_instance_address_nonempty CHECK (internal_address <> ''),
    CONSTRAINT pe_instance_recipe_nonempty CHECK (recipe_version <> ''),
    CONSTRAINT pe_instance_phase_valid CHECK (phase IN ('registered', 'closed'))
  ) ON COMMIT DROP;
  CREATE TABLE IF NOT EXISTS public.pe_instances (LIKE pg_temp._pe_instance_schema_0001 INCLUDING ALL);
  IF (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'public.pe_instances'::regclass AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'pg_temp._pe_instance_schema_0001'::regclass AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'incompatible pe_instances columns';
  END IF;
  IF (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'public.pe_instances'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'pg_temp._pe_instance_schema_0001'::regclass
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pe_instances'::regclass AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'incompatible pe_instances constraints';
  END IF;
END
$migration$;`
