/** Adjacent v1 attestation table; leaves all original allocation columns and rows unchanged. */
export const allocationBindingMigrationSql = String.raw`DO $migration$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pe-opensandbox/allocation-bindings/v1', 0));
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);
  CREATE TEMP TABLE pg_temp._pe_binding_schema_v1 (
    allocation_id text COLLATE "C" PRIMARY KEY,
    account_id text COLLATE "C" NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    workspace_id text COLLATE "C" NOT NULL,
    epoch bigint NOT NULL CHECK (epoch > 0),
    sandbox_id text COLLATE "C" NOT NULL CHECK (sandbox_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
    container_id text COLLATE "C" NOT NULL CHECK (container_id ~ '^[0-9a-f]{64}$'),
    provider_generation text COLLATE "C" NOT NULL CHECK (provider_generation ~ '^[0-9a-f]{64}$'),
    policy_digest text COLLATE "C" NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
    CHECK (octet_length(allocation_id) BETWEEN 1 AND 4096 AND octet_length(account_id) BETWEEN 1 AND 4096
      AND octet_length(session_id) BETWEEN 1 AND 4096 AND octet_length(workspace_id) BETWEEN 1 AND 4096)
  ) ON COMMIT DROP;
  IF to_regclass('public.pe_sandbox_allocation_bindings_v1') IS NULL THEN
    CREATE TABLE public.pe_sandbox_allocation_bindings_v1 (LIKE pg_temp._pe_binding_schema_v1 INCLUDING ALL);
    ALTER TABLE public.pe_sandbox_allocation_bindings_v1
      ADD FOREIGN KEY (allocation_id) REFERENCES public.pe_sandbox_allocations(allocation_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pe_sandbox_allocation_bindings_v1'::regclass
    AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity
    AND NOT relispartition AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass AND NOT tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = 'public.pe_sandbox_allocation_bindings_v1'::regclass
      OR inhrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass)
  THEN RAISE EXCEPTION 'incompatible allocation binding table'; END IF;
  IF (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, attcollation, attgenerated, attidentity,
      pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, attcollation, attgenerated, attidentity,
      pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'pg_temp._pe_binding_schema_v1'::regclass AND attnum > 0 AND NOT attisdropped
  ) THEN RAISE EXCEPTION 'incompatible allocation binding columns'; END IF;
  IF (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass AND contype <> 'f'
  ) IS DISTINCT FROM (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'pg_temp._pe_binding_schema_v1'::regclass
  ) OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass AND NOT convalidated)
  OR (
    SELECT array_agg(pg_get_constraintdef(oid, true)) FROM pg_constraint
    WHERE conrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass AND contype = 'f'
  ) IS DISTINCT FROM ARRAY['FOREIGN KEY (allocation_id) REFERENCES public.pe_sandbox_allocations(allocation_id) ON DELETE RESTRICT']
  THEN RAISE EXCEPTION 'incompatible allocation binding constraints'; END IF;
  IF (
    SELECT array_agg(ROW(indisunique, indisprimary, indimmediate, indisvalid, indisready, indnullsnotdistinct, indnkeyatts, indnatts,
      indkey::text, indclass::text, indcollation::text, indoption::text,
      pg_get_expr(indpred, indrelid), pg_get_expr(indexprs, indrelid), amname)::text ORDER BY indkey::text, indisprimary)
    FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid JOIN pg_am ON pg_am.oid = relam
    WHERE indrelid = 'public.pe_sandbox_allocation_bindings_v1'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(indisunique, indisprimary, indimmediate, indisvalid, indisready, indnullsnotdistinct, indnkeyatts, indnatts,
      indkey::text, indclass::text, indcollation::text, indoption::text,
      pg_get_expr(indpred, indrelid), pg_get_expr(indexprs, indrelid), amname)::text ORDER BY indkey::text, indisprimary)
    FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid JOIN pg_am ON pg_am.oid = relam
    WHERE indrelid = 'pg_temp._pe_binding_schema_v1'::regclass
  ) THEN RAISE EXCEPTION 'incompatible allocation binding indexes'; END IF;
  REVOKE ALL ON TABLE public.pe_sandbox_allocation_bindings_v1 FROM PUBLIC;
END
$migration$;`
