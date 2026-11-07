/** Atomic durable user-to-static-slot registry; schema drift cannot remove unique-slot ownership. */

/** Validate existing owned data and constraints without resetting or reassigning account storage. */
export const staticAccountMigrationSql = String.raw`DO $migration$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pe-cloud-runtime/static-accounts/0001', 0));
  CREATE TEMP TABLE pg_temp._pe_static_account_schema_0001 (
    account_id text PRIMARY KEY,
    inventory_sha256 text NOT NULL CHECK (inventory_sha256 ~ '^[a-f0-9]{64}$'),
    slot_id text NOT NULL UNIQUE,
    binding_revision bigint NOT NULL DEFAULT 1 CHECK (binding_revision > 0),
    workflow_revision bigint NOT NULL DEFAULT 1 CHECK (workflow_revision > 0),
    phase text NOT NULL CHECK (phase IN ('reserved','preparing','ready','disabled','failed','stop-unknown')),
    operation_id text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  ) ON COMMIT DROP;
  CREATE TABLE IF NOT EXISTS public.pe_account_static_bindings (LIKE pg_temp._pe_static_account_schema_0001 INCLUDING ALL);
  IF (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'public.pe_account_static_bindings'::regclass AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'pg_temp._pe_static_account_schema_0001'::regclass AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'incompatible pe_account_static_bindings columns';
  END IF;
  IF (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'public.pe_account_static_bindings'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'pg_temp._pe_static_account_schema_0001'::regclass
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pe_account_static_bindings'::regclass AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'incompatible pe_account_static_bindings constraints';
  END IF;
END
$migration$;`
