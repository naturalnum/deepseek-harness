/** Add the v1 application receipt table and atomic release operation beside the original allocation schema. */
export const allocationReceiptMigrationSql = String.raw`DO $migration$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pe-opensandbox/deletion-receipts/v1', 0));
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog', true);

  CREATE TEMP TABLE pg_temp._pe_allocation_receipt_schema_v1 (
    allocation_id text COLLATE "C" PRIMARY KEY,
    account_id text COLLATE "C" NOT NULL,
    session_id text COLLATE "C" NOT NULL,
    workspace_id text COLLATE "C" NOT NULL,
    epoch bigint NOT NULL CHECK (epoch > 0),
    sandbox_id text COLLATE "C" NOT NULL,
    container_id text COLLATE "C" NOT NULL CHECK (container_id ~ '^[0-9a-f]{64}$'),
    provider_generation text COLLATE "C" NOT NULL CHECK (provider_generation ~ '^[0-9a-f]{64}$'),
    policy_digest text COLLATE "C" NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
    receipt_digest text COLLATE "C" NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
    pending_slot smallint UNIQUE CHECK (pending_slot BETWEEN 1 AND 128),
    CHECK (octet_length(allocation_id) BETWEEN 1 AND 4096
      AND octet_length(account_id) BETWEEN 1 AND 4096
      AND octet_length(session_id) BETWEEN 1 AND 4096
      AND octet_length(workspace_id) BETWEEN 1 AND 4096
      AND octet_length(sandbox_id) BETWEEN 1 AND 4096)
  ) ON COMMIT DROP;

  IF to_regclass('public.pe_sandbox_deletion_receipts_v1') IS NULL THEN
    CREATE TABLE public.pe_sandbox_deletion_receipts_v1
      (LIKE pg_temp._pe_allocation_receipt_schema_v1 INCLUDING ALL);
    ALTER TABLE public.pe_sandbox_deletion_receipts_v1
      ADD FOREIGN KEY (allocation_id) REFERENCES public.pe_sandbox_allocations(allocation_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pe_sandbox_deletion_receipts_v1'::regclass
    AND relkind = 'r' AND relpersistence = 'p' AND NOT relrowsecurity AND NOT relforcerowsecurity
    AND NOT relispartition AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass AND NOT tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = 'public.pe_sandbox_deletion_receipts_v1'::regclass
      OR inhrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass)
  THEN RAISE EXCEPTION 'incompatible deletion receipt table'; END IF;
  IF (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, attcollation, attgenerated, attidentity,
      pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(attname, format_type(atttypid, atttypmod), attnotnull, attcollation, attgenerated, attidentity,
      pg_get_expr(adbin, adrelid))::text ORDER BY attnum)
    FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum
    WHERE attrelid = 'pg_temp._pe_allocation_receipt_schema_v1'::regclass AND attnum > 0 AND NOT attisdropped
  ) THEN RAISE EXCEPTION 'incompatible deletion receipt columns'; END IF;
  IF (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass AND contype <> 'f'
  ) IS DISTINCT FROM (
    SELECT array_agg(pg_get_constraintdef(oid, true) ORDER BY pg_get_constraintdef(oid, true))
    FROM pg_constraint WHERE conrelid = 'pg_temp._pe_allocation_receipt_schema_v1'::regclass
  ) OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass AND NOT convalidated)
  OR (
    SELECT array_agg(pg_get_constraintdef(oid, true)) FROM pg_constraint
    WHERE conrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass AND contype = 'f'
  ) IS DISTINCT FROM ARRAY['FOREIGN KEY (allocation_id) REFERENCES public.pe_sandbox_allocations(allocation_id) ON DELETE RESTRICT']
  THEN RAISE EXCEPTION 'incompatible deletion receipt constraints'; END IF;
  IF (
    SELECT array_agg(ROW(indisunique, indisprimary, indimmediate, indisvalid, indisready, indnullsnotdistinct, indnkeyatts, indnatts,
      indkey::text, indclass::text, indcollation::text, indoption::text,
      pg_get_expr(indpred, indrelid), pg_get_expr(indexprs, indrelid), amname)::text ORDER BY indkey::text, indisprimary)
    FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid JOIN pg_am ON pg_am.oid = relam
    WHERE indrelid = 'public.pe_sandbox_deletion_receipts_v1'::regclass
  ) IS DISTINCT FROM (
    SELECT array_agg(ROW(indisunique, indisprimary, indimmediate, indisvalid, indisready, indnullsnotdistinct, indnkeyatts, indnatts,
      indkey::text, indclass::text, indcollation::text, indoption::text,
      pg_get_expr(indpred, indrelid), pg_get_expr(indexprs, indrelid), amname)::text ORDER BY indkey::text, indisprimary)
    FROM pg_index JOIN pg_class ON pg_class.oid = indexrelid JOIN pg_am ON pg_am.oid = relam
    WHERE indrelid = 'pg_temp._pe_allocation_receipt_schema_v1'::regclass
  ) THEN RAISE EXCEPTION 'incompatible deletion receipt indexes'; END IF;

  CREATE OR REPLACE FUNCTION public.pe_release_sandbox_deletion_receipt_v1(
    p_allocation_id text, p_account_id text, p_session_id text, p_workspace_id text, p_epoch bigint,
    p_sandbox_id text, p_container_id text, p_provider_generation text, p_policy_digest text, p_receipt_digest text
  ) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path TO pg_catalog AS $release$
  DECLARE
    allocation_state text;
    retained public.pe_sandbox_deletion_receipts_v1%ROWTYPE;
    selected_slot smallint;
  BEGIN
    IF current_setting('transaction_isolation') <> 'read committed'
      OR current_setting('fsync') <> 'on'
      OR current_setting('synchronous_commit') NOT IN ('on', 'remote_apply')
    THEN RAISE EXCEPTION 'deletion receipt release requires a durable read-committed transaction'; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('pe-opensandbox/deletion-receipts/v1', 0));
    SELECT state INTO allocation_state FROM public.pe_sandbox_allocations
    WHERE allocation_id = p_allocation_id AND account_id = p_account_id AND session_id = p_session_id
      AND workspace_id = p_workspace_id AND epoch = p_epoch AND sandbox_id = p_sandbox_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN 'conflict'; END IF;

    SELECT * INTO retained FROM public.pe_sandbox_deletion_receipts_v1 WHERE allocation_id = p_allocation_id;
    IF FOUND THEN
      IF allocation_state = 'released'
        AND ROW(retained.account_id, retained.session_id, retained.workspace_id, retained.epoch, retained.sandbox_id,
          retained.container_id, retained.provider_generation, retained.policy_digest, retained.receipt_digest)
          = ROW(p_account_id, p_session_id, p_workspace_id, p_epoch, p_sandbox_id,
            p_container_id, p_provider_generation, p_policy_digest, p_receipt_digest)
      THEN RETURN 'recorded'; END IF;
      RETURN 'conflict';
    END IF;
    IF allocation_state <> 'stopping' THEN RETURN 'conflict'; END IF;

    SELECT candidate.slot INTO selected_slot FROM generate_series(1, 128) AS candidate(slot)
    WHERE NOT EXISTS (SELECT 1 FROM public.pe_sandbox_deletion_receipts_v1 WHERE pending_slot = candidate.slot)
    ORDER BY candidate.slot LIMIT 1;
    IF NOT FOUND THEN RETURN 'capacity'; END IF;

    UPDATE public.pe_sandbox_allocations SET state = 'released', last_checked_at = statement_timestamp()
    WHERE allocation_id = p_allocation_id AND account_id = p_account_id AND session_id = p_session_id
      AND workspace_id = p_workspace_id AND epoch = p_epoch AND sandbox_id = p_sandbox_id AND state = 'stopping';
    IF NOT FOUND THEN RETURN 'conflict'; END IF;

    INSERT INTO public.pe_sandbox_deletion_receipts_v1 (
      allocation_id, account_id, session_id, workspace_id, epoch, sandbox_id, container_id,
      provider_generation, policy_digest, receipt_digest, pending_slot
    ) VALUES (
      p_allocation_id, p_account_id, p_session_id, p_workspace_id, p_epoch, p_sandbox_id, p_container_id,
      p_provider_generation, p_policy_digest, p_receipt_digest, selected_slot
    );
    RETURN 'recorded';
  END;
  $release$;
  REVOKE ALL ON TABLE public.pe_sandbox_deletion_receipts_v1 FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.pe_release_sandbox_deletion_receipt_v1(
    text, text, text, text, bigint, text, text, text, text, text
  ) FROM PUBLIC;
END
$migration$;`
