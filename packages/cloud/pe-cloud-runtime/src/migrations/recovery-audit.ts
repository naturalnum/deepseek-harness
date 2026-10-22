/** Protected bounded recovery audit and one atomic locked CAS; no process/provider action is implemented in SQL. */
import { ownerJsonSql } from '../owner-sql.ts'

const signature = 'public.pe_recover_released_0001(text,text,bigint,text,jsonb,integer,integer,integer)'
const body = `DECLARE
  existing public.pe_recovery_audit%ROWTYPE;
  v_postimage jsonb;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN; END IF;
  IF p_max_allocations NOT BETWEEN 1 AND 128 OR p_max_audit_rows < 1 OR p_max_age_ms < 1
    OR jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR octet_length(p_proof::text) > 131072
    OR jsonb_typeof(p_proof->'verifiedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_proof->'writersVerifiedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_proof->'databaseRole') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_proof->'allocations') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_proof->'allocations') > p_max_allocations
    OR p_proof->>'accountId' IS DISTINCT FROM p_account_id
    OR p_proof->>'oldInstanceId' IS DISTINCT FROM p_old_instance_id
    OR p_proof->>'epoch' IS DISTINCT FROM p_epoch::text
    OR p_proof->>'auditRef' IS DISTINCT FROM p_audit_ref
    OR p_proof->>'verifierId' IS DISTINCT FROM 'local-original-process-and-provider-v1' THEN RETURN; END IF;

  -- A prepared writer can retain row/table locks after its connection exits.
  IF current_user::text IS DISTINCT FROM p_proof->>'databaseRole'
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE owner = current_user) THEN RETURN; END IF;

  -- Serialize audit capacity and duplicate identities, then exclude allocation inserts/updates through this commit.
  LOCK TABLE public.pe_recovery_audit IN EXCLUSIVE MODE;
  SELECT * INTO existing FROM public.pe_recovery_audit WHERE audit_ref = p_audit_ref;
  IF FOUND THEN
    IF existing.account_id = p_account_id AND existing.old_instance_id = p_old_instance_id AND existing.epoch = p_epoch THEN
      RETURN NEXT jsonb_build_object('proof', existing.proof, 'postimage', existing.postimage);
    END IF;
    RETURN;
  END IF;
  LOCK TABLE public.pe_sandbox_allocations IN SHARE MODE;
  PERFORM pg_stat_clear_snapshot();
  IF current_user::text IS DISTINCT FROM p_proof->>'databaseRole'
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE owner = current_user)
    OR (p_proof->>'writersVerifiedAt')::timestamptz > (p_proof->>'verifiedAt')::timestamptz
    OR EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename = current_user
      AND backend_type = 'client backend' AND pid <> pg_backend_pid()
      AND backend_start <= (p_proof->>'writersVerifiedAt')::timestamptz)
    OR (p_proof->>'verifiedAt')::timestamptz > clock_timestamp()
    OR clock_timestamp() - (p_proof->>'verifiedAt')::timestamptz > make_interval(secs => p_max_age_ms / 1000.0)
    OR (SELECT count(*) FROM public.pe_recovery_audit) >= p_max_audit_rows
    OR EXISTS (SELECT 1 FROM public.pe_recovery_audit
      WHERE account_id = p_account_id AND old_instance_id = p_old_instance_id AND epoch = p_epoch)
    OR EXISTS (SELECT 1 FROM public.pe_sandbox_allocations
      WHERE account_id = p_account_id AND epoch = p_epoch AND state NOT IN ('released','failed'))
    OR (SELECT count(*) FROM public.pe_sandbox_allocations
      WHERE account_id = p_account_id AND epoch = p_epoch) > p_max_allocations
    OR (SELECT array_agg(allocation_id ORDER BY allocation_id COLLATE "C") FROM public.pe_sandbox_allocations
      WHERE account_id = p_account_id AND epoch = p_epoch) IS DISTINCT FROM
      (SELECT array_agg(item->>'allocationId' ORDER BY (item->>'allocationId') COLLATE "C")
       FROM jsonb_array_elements(p_proof->'allocations') item)
    THEN RETURN; END IF;

  UPDATE public.pe_account_owners SET owner_instance_id = NULL, phase = 'unowned', updated_at = clock_timestamp()
    WHERE account_id = p_account_id AND owner_instance_id = p_old_instance_id AND epoch = p_epoch
      AND phase IN ('ready','draining','quarantined','mounting')
    RETURNING ${ownerJsonSql} INTO v_postimage;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.pe_recovery_audit(audit_ref,account_id,old_instance_id,epoch,verifier_id,verified_at,proof,postimage)
    VALUES(p_audit_ref,p_account_id,p_old_instance_id,p_epoch,'local-original-process-and-provider-v1',
      (p_proof->>'verifiedAt')::timestamptz,p_proof,v_postimage);
  RETURN NEXT jsonb_build_object('proof', p_proof, 'postimage', v_postimage);
END;`

const closeSignature = 'public.pe_close_recovered_instance_0001(text,text,bigint,text,text,text,jsonb,integer)'
const closeBody = `BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN; END IF;
  IF p_max_age_ms < 1 OR jsonb_typeof(p_proof) IS DISTINCT FROM 'object'
    OR octet_length(p_proof::text) > 131072 OR current_user::text IS DISTINCT FROM p_proof->>'databaseRole'
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE owner=current_user) THEN RETURN; END IF;
  -- Lock every owner mutation while checking the whole old instance, not just the audit's account.
  LOCK TABLE public.pe_account_owners IN SHARE MODE;
  PERFORM pg_stat_clear_snapshot();
  IF p_proof->>'accountId' IS DISTINCT FROM p_account_id OR p_proof->>'oldInstanceId' IS DISTINCT FROM p_old_instance_id
    OR p_proof->>'epoch' IS DISTINCT FROM p_epoch::text OR p_proof->>'auditRef' IS DISTINCT FROM p_audit_ref
    OR p_proof->>'verifierId' IS DISTINCT FROM 'local-original-process-and-provider-v1'
    OR jsonb_typeof(p_proof->'verifiedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_proof->'writersVerifiedAt') IS DISTINCT FROM 'string'
    OR (p_proof->>'verifiedAt')::timestamptz > clock_timestamp()
    OR (p_proof->>'writersVerifiedAt')::timestamptz > (p_proof->>'verifiedAt')::timestamptz
    OR clock_timestamp() - (p_proof->>'verifiedAt')::timestamptz > make_interval(secs => p_max_age_ms / 1000.0)
    OR EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE owner=current_user)
    OR EXISTS (SELECT 1 FROM pg_stat_activity WHERE usename=current_user AND backend_type='client backend'
      AND pid<>pg_backend_pid() AND backend_start<=(p_proof->>'writersVerifiedAt')::timestamptz)
    OR EXISTS (SELECT 1 FROM public.pe_account_owners WHERE owner_instance_id=p_old_instance_id)
    OR NOT EXISTS (SELECT 1 FROM public.pe_account_owners WHERE account_id=p_account_id AND epoch=p_epoch
      AND phase='unowned' AND owner_instance_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.pe_recovery_audit
      WHERE audit_ref=p_audit_ref AND account_id=p_account_id AND old_instance_id=p_old_instance_id AND epoch=p_epoch)
    THEN RETURN; END IF;
  RETURN QUERY UPDATE public.pe_instances SET phase='closed',heartbeat_at=clock_timestamp()
    WHERE instance_id=p_old_instance_id AND internal_address=p_internal_address AND recipe_version=p_recipe_version
      AND phase='registered' RETURNING instance_id;
END;`

/** Atomic idempotent migration, explicitly invoked after owner/allocation migrations; incompatible audit schema rejects. */
export const recoveryAuditMigrationSql = `DO $migration$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pe-cloud-runtime/recovery-audit/0001', 0));
  IF to_regclass('public.pe_account_owners') IS NULL OR to_regclass('public.pe_sandbox_allocations') IS NULL
    OR to_regclass('public.pe_instances') IS NULL THEN
    RAISE EXCEPTION 'recovery requires original instance, owner and allocation migrations';
  END IF;
  CREATE TEMP TABLE pg_temp._pe_recovery_schema_0001 (
    audit_ref text PRIMARY KEY,
    account_id text NOT NULL,
    old_instance_id text NOT NULL,
    epoch bigint NOT NULL CHECK (epoch > 0),
    verifier_id text NOT NULL CHECK (verifier_id = 'local-original-process-and-provider-v1'),
    verified_at timestamptz NOT NULL,
    committed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object' AND octet_length(proof::text) <= 131072),
    postimage jsonb NOT NULL CHECK (jsonb_typeof(postimage) = 'object' AND octet_length(postimage::text) <= 16384),
    UNIQUE(account_id, old_instance_id, epoch),
    CHECK (octet_length(audit_ref) BETWEEN 1 AND 4096 AND octet_length(account_id) BETWEEN 1 AND 4096
      AND octet_length(old_instance_id) BETWEEN 1 AND 4096)
  ) ON COMMIT DROP;
  CREATE TABLE IF NOT EXISTS public.pe_recovery_audit (LIKE pg_temp._pe_recovery_schema_0001 INCLUDING ALL);
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.pe_recovery_audit'::regclass AND relkind = 'r' AND relowner=current_user::regrole)
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pe_recovery_audit'::regclass AND NOT tgisinternal)
    OR (
      SELECT array_agg(ROW(attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(adbin,adrelid))::text ORDER BY attnum)
      FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
      WHERE attrelid='public.pe_recovery_audit'::regclass AND attnum>0 AND NOT attisdropped
    ) IS DISTINCT FROM (
      SELECT array_agg(ROW(attname,format_type(atttypid,atttypmod),attnotnull,pg_get_expr(adbin,adrelid))::text ORDER BY attnum)
      FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
      WHERE attrelid='pg_temp._pe_recovery_schema_0001'::regclass AND attnum>0 AND NOT attisdropped
    ) OR (
      SELECT array_agg(pg_get_constraintdef(oid,true) ORDER BY pg_get_constraintdef(oid,true))
      FROM pg_constraint WHERE conrelid='public.pe_recovery_audit'::regclass
    ) IS DISTINCT FROM (
      SELECT array_agg(pg_get_constraintdef(oid,true) ORDER BY pg_get_constraintdef(oid,true))
      FROM pg_constraint WHERE conrelid='pg_temp._pe_recovery_schema_0001'::regclass
    ) OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.pe_recovery_audit'::regclass AND NOT convalidated)
    THEN RAISE EXCEPTION 'incompatible recovery audit schema'; END IF;

  IF to_regprocedure('${signature}') IS NULL THEN
    EXECUTE $definition$CREATE FUNCTION public.pe_recover_released_0001(
      p_account_id text,p_old_instance_id text,p_epoch bigint,p_audit_ref text,p_proof jsonb,
      p_max_allocations integer,p_max_audit_rows integer,p_max_age_ms integer)
      RETURNS SETOF jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public
      AS $function$${body}$function$$definition$;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('${signature}')
    AND proowner=current_user::regrole AND prosrc = $source$${body}$source$ AND NOT prosecdef AND provolatile='v' AND proretset
    AND prorettype='jsonb'::regtype AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND proconfig=ARRAY['search_path=pg_catalog, public']::text[])
    THEN RAISE EXCEPTION 'incompatible recovery function'; END IF;
  IF to_regprocedure('${closeSignature}') IS NULL THEN
    EXECUTE $definition$CREATE FUNCTION public.pe_close_recovered_instance_0001(
      p_account_id text,p_old_instance_id text,p_epoch bigint,p_audit_ref text,p_internal_address text,p_recipe_version text,
      p_proof jsonb,p_max_age_ms integer)
      RETURNS SETOF text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public
      AS $function$${closeBody}$function$$definition$;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('${closeSignature}') AND proowner=current_user::regrole
    AND prosrc=$source$${closeBody}$source$ AND NOT prosecdef AND provolatile='v' AND proretset
    AND prorettype='text'::regtype AND prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    AND proconfig=ARRAY['search_path=pg_catalog, public']::text[])
    THEN RAISE EXCEPTION 'incompatible recovered-instance function'; END IF;
  REVOKE ALL ON TABLE public.pe_recovery_audit FROM PUBLIC;
  EXECUTE 'REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION ${closeSignature} FROM PUBLIC';
END
$migration$;`
