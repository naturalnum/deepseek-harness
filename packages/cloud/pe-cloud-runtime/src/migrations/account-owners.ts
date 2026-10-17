/** Atomic owner-table migration bundled with the runtime Host entry. */

/** Versioned idempotent DDL; incompatible existing columns/constraints reject rather than reset data. */
export const accountOwnerMigrationSql = String.raw`DO $migration$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pe-cloud-runtime/account-owners/0001', 0));
  CREATE TEMP TABLE pg_temp._pe_owner_schema_0001 (
    account_id text PRIMARY KEY,
    owner_instance_id text,
    epoch bigint NOT NULL,
    phase text NOT NULL,
    recipe_version text NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT pe_owner_account_nonempty CHECK (account_id <> ''),
    CONSTRAINT pe_owner_epoch_positive CHECK (epoch > 0),
    CONSTRAINT pe_owner_recipe_nonempty CHECK (recipe_version <> ''),
    CONSTRAINT pe_owner_phase_valid CHECK (phase IN ('unowned', 'mounting', 'ready', 'draining', 'parked', 'reconfiguring', 'quarantined')),
    CONSTRAINT pe_owner_identity_valid CHECK (
      (phase = 'unowned' AND owner_instance_id IS NULL)
      OR (phase <> 'unowned' AND owner_instance_id IS NOT NULL AND owner_instance_id <> '')
    )
  ) ON COMMIT DROP;
  CREATE TABLE IF NOT EXISTS public.pe_account_owners (LIKE pg_temp._pe_owner_schema_0001 INCLUDING ALL);
  IF (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'public.pe_account_owners'::regclass AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'pg_temp._pe_owner_schema_0001'::regclass AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'incompatible pe_account_owners columns';
  END IF;
  IF (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'public.pe_account_owners'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'pg_temp._pe_owner_schema_0001'::regclass
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pe_account_owners'::regclass AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'incompatible pe_account_owners constraints';
  END IF;
END
$migration$;`
