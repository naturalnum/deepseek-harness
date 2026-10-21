/** Private allocation DDL; no backend resources or caller-selected schema are involved. */

/** Atomic idempotent DDL; incompatible columns, constraints or indexes reject without resetting data. */
export const allocationMigrationSql = String.raw`DO $migration$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pe-opensandbox/allocations/0001', 0));
  CREATE TEMP TABLE pg_temp._pe_allocation_schema_0001 (
    allocation_id text COLLATE "C" PRIMARY KEY,
    account_id text COLLATE "C" NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    workspace_id text COLLATE "C" NOT NULL,
    epoch bigint NOT NULL,
    environment_version text NOT NULL,
    provider text NOT NULL,
    state text NOT NULL,
    sandbox_id text,
    project_mount_version text NOT NULL,
    requested_at timestamptz NOT NULL,
    create_deadline_at timestamptz NOT NULL,
    last_activity_at timestamptz NOT NULL,
    last_checked_at timestamptz NOT NULL,
    runtime_identity text,
    execution_protocol_version text,
    execution_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
    failure_code text,
    CONSTRAINT pe_allocation_epoch CHECK (epoch > 0),
    CONSTRAINT pe_allocation_dates CHECK (create_deadline_at >= requested_at),
    CONSTRAINT pe_allocation_state CHECK (state IN ('creating','ready','uncertain','stopping','failed','released')),
    CONSTRAINT pe_allocation_identifiers CHECK (
      allocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(allocation_id) <= 4096
      AND account_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(account_id) <= 4096
      AND session_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(session_id) <= 4096
      AND workspace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(workspace_id) <= 4096
      AND environment_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(environment_version) <= 4096
      AND provider ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(provider) <= 4096
      AND project_mount_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(project_mount_version) <= 4096
      AND (sandbox_id IS NULL OR (sandbox_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(sandbox_id) <= 4096))
      AND (runtime_identity IS NULL OR (runtime_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(runtime_identity) <= 4096))
      AND (execution_protocol_version IS NULL OR (execution_protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' AND octet_length(execution_protocol_version) <= 4096))
      AND (failure_code IS NULL OR (failure_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' AND octet_length(failure_code) <= 4096))
    ),
    CONSTRAINT pe_allocation_capabilities CHECK (
      jsonb_typeof(execution_capabilities) = 'array' AND jsonb_array_length(execution_capabilities) <= 5
      AND execution_capabilities <@ '["argv-collect","pipes","control","inherit","terminal"]'::jsonb
      AND jsonb_array_length(execution_capabilities) =
        (CASE WHEN execution_capabilities ? 'argv-collect' THEN 1 ELSE 0 END)
        + (CASE WHEN execution_capabilities ? 'pipes' THEN 1 ELSE 0 END)
        + (CASE WHEN execution_capabilities ? 'control' THEN 1 ELSE 0 END)
        + (CASE WHEN execution_capabilities ? 'inherit' THEN 1 ELSE 0 END)
        + (CASE WHEN execution_capabilities ? 'terminal' THEN 1 ELSE 0 END)
    ),
    CONSTRAINT pe_allocation_ready CHECK (state <> 'ready' OR (
      sandbox_id IS NOT NULL AND runtime_identity IS NOT NULL AND execution_protocol_version IS NOT NULL
      AND jsonb_array_length(execution_capabilities) > 0 AND failure_code IS NULL
    )),
    CONSTRAINT pe_allocation_failed CHECK (state <> 'failed' OR (sandbox_id IS NULL AND failure_code IS NOT NULL))
  ) ON COMMIT DROP;
  CREATE TABLE IF NOT EXISTS public.pe_sandbox_allocations (LIKE pg_temp._pe_allocation_schema_0001 INCLUDING ALL);
  CREATE UNIQUE INDEX IF NOT EXISTS pe_sandbox_allocations_nonterminal
    ON public.pe_sandbox_allocations (account_id, session_id, epoch)
    WHERE state IN ('creating','ready','uncertain','stopping');
  CREATE UNIQUE INDEX _pe_allocation_nonterminal_schema_0001
    ON pg_temp._pe_allocation_schema_0001 (account_id, session_id, epoch)
    WHERE state IN ('creating','ready','uncertain','stopping');
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pe_sandbox_allocations'::regclass
    AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity)
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pe_sandbox_allocations'::regclass AND NOT tgisinternal)
  THEN RAISE EXCEPTION 'incompatible pe_sandbox_allocations table'; END IF;
  IF (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, attcollation,
      pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'public.pe_sandbox_allocations'::regclass AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, attcollation,
      pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'pg_temp._pe_allocation_schema_0001'::regclass AND attnum > 0 AND NOT attisdropped
  ) THEN RAISE EXCEPTION 'incompatible pe_sandbox_allocations columns'; END IF;
  IF (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'public.pe_sandbox_allocations'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'pg_temp._pe_allocation_schema_0001'::regclass
  ) OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pe_sandbox_allocations'::regclass AND NOT convalidated)
  THEN RAISE EXCEPTION 'incompatible pe_sandbox_allocations constraints'; END IF;
  IF (
    SELECT array_agg(ROW(indisunique, indisprimary, indimmediate, indisvalid, indisready, indnkeyatts, indnatts,
      indkey::text, indclass::text, indcollation::text, indoption::text,
      pg_get_expr(indpred, indrelid), pg_get_expr(indexprs, indrelid), amname)::text ORDER BY indkey::text, indisprimary)
    FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid JOIN pg_am ON pg_am.oid = relam
    WHERE indrelid = 'public.pe_sandbox_allocations'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(indisunique, indisprimary, indimmediate, indisvalid, indisready, indnkeyatts, indnatts,
      indkey::text, indclass::text, indcollation::text, indoption::text,
      pg_get_expr(indpred, indrelid), pg_get_expr(indexprs, indrelid), amname)::text ORDER BY indkey::text, indisprimary)
    FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid JOIN pg_am ON pg_am.oid = relam
    WHERE indrelid = 'pg_temp._pe_allocation_schema_0001'::regclass
  ) THEN RAISE EXCEPTION 'incompatible pe_sandbox_allocations indexes'; END IF;
END
$migration$;`
