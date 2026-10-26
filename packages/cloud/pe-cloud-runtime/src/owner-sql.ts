/** Fixed PostgreSQL statements; owner transitions never depend on a heartbeat lease. */

/** Original owner projection shared by ordinary reads and the atomic recovery audit. */
export const ownerJsonSql = `jsonb_build_object(
  'accountId', account_id, 'ownerInstanceId', owner_instance_id,
  'epoch', epoch::text, 'phase', phase, 'recipeVersion', recipe_version,
  'heartbeatAt', to_char(heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
)`

const projection = `${ownerJsonSql} AS owner`

/** Read ownership without acquiring it or interpreting lease expiry. */
export const locateOwnerSql = `SELECT ${projection} FROM public.pe_account_owners WHERE account_id = $1`

/** One atomic initial insert or expected-epoch update; a retained row is never deleted or reset. */
export const claimOwnerSql = `WITH changed AS (
  UPDATE public.pe_account_owners
  SET owner_instance_id = $2, epoch = epoch + 1, phase = 'mounting', recipe_version = $3,
      heartbeat_at = statement_timestamp(), updated_at = statement_timestamp()
  WHERE account_id = $1 AND epoch = $4::bigint
    AND (phase = 'unowned' OR (phase = 'parked' AND owner_instance_id = $2))
  RETURNING ${projection}
), initial AS (
  INSERT INTO public.pe_account_owners (account_id, owner_instance_id, epoch, phase, recipe_version)
  SELECT $1, $2, 1, 'mounting', $3 WHERE $4::bigint IS NULL
  ON CONFLICT (account_id) DO NOTHING
  RETURNING ${projection}
)
SELECT owner FROM changed UNION ALL SELECT owner FROM initial`

/** Heartbeat observes an exact owned generation; it never changes phase or owner. */
export const heartbeatOwnerSql = `UPDATE public.pe_account_owners
SET heartbeat_at = statement_timestamp(), updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint
RETURNING ${projection}`

/** Commit only an exact mounting generation and approved recipe; no graph or provider is inspected here. */
export const readyOwnerSql = `UPDATE public.pe_account_owners
SET phase = 'ready', updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint
  AND phase = 'mounting' AND recipe_version = $4
RETURNING ${projection}`

/** Enter only the same ready generation's nonterminal exclusive update window. */
export const beginOwnerReconfigurationSql = `UPDATE public.pe_account_owners
SET phase = 'reconfiguring', updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint AND phase = 'ready'
RETURNING ${projection}`

/** Republish only the same audited generation and immutable recipe after a local update. */
export const finishOwnerReconfigurationSql = `UPDATE public.pe_account_owners
SET phase = 'ready', updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint
  AND phase = 'reconfiguring' AND recipe_version = $4
RETURNING ${projection}`

/** Known setup cleanup or a ready graph can enter draining; this never publishes ready or unquarantines. */
export const beginOwnerDrainSql = `UPDATE public.pe_account_owners
SET phase = 'draining', updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint AND phase IN ('mounting', 'ready', 'reconfiguring')
RETURNING ${projection}`

/** Failure retains ownership and epoch; quarantine has no normal claim/release exit. */
export const quarantineOwnerSql = `UPDATE public.pe_account_owners
SET phase = 'quarantined', updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint AND phase <> 'unowned'
RETURNING ${projection}`

/** Only runtime-confirmed teardown can invoke this CAS from draining to unowned or parked. */
export const finishOwnerDrainSql = `UPDATE public.pe_account_owners
SET phase = $4, owner_instance_id = CASE WHEN $4 = 'unowned' THEN NULL ELSE owner_instance_id END,
    updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint AND phase = 'draining'
RETURNING ${projection}`

/** Atomic locked recovery function; all physical verification remains with the selected Root callback. */
export const recoverReleasedSql = 'SELECT public.pe_recover_released_0001($1,$2,$3::bigint,$4,$5::jsonb,$6::integer,$7::integer,$8::integer) AS recovery'

/** One read-only snapshot of exact audit identity and current owner; absence never authorizes a retry. */
export const inspectRecoverySql = `SELECT
  (SELECT jsonb_build_object('proof', proof, 'postimage', postimage)
   FROM public.pe_recovery_audit WHERE audit_ref = $1) AS recovery,
  (SELECT ${projection} FROM public.pe_account_owners WHERE account_id = $2) AS owner,
  COALESCE((SELECT ${ownerJsonSql} = (SELECT postimage FROM public.pe_recovery_audit WHERE audit_ref=$1)
    FROM public.pe_account_owners WHERE account_id=$2),false) AS matches`

/** Independently locked instance closure; requires an existing exact account recovery audit and no retained old owner. */
export const closeRecoveredInstanceSql = 'SELECT public.pe_close_recovered_instance_0001($1,$2,$3::bigint,$4,$5,$6,$7::jsonb,$8::integer) AS closed_instance'

/** Exact registration/audit postimage only; never erases uncertain local mutation responsibility. */
export const inspectRecoveredInstanceSql = `SELECT
  EXISTS (SELECT 1 FROM public.pe_recovery_audit WHERE audit_ref=$4 AND account_id=$1 AND old_instance_id=$2 AND epoch=$3::bigint) AS audited,
  EXISTS (SELECT 1 FROM public.pe_instances WHERE instance_id=$2 AND internal_address=$5 AND recipe_version=$6 AND phase='closed') AS closed,
  EXISTS (SELECT 1 FROM public.pe_account_owners WHERE owner_instance_id=$2) AS retained`
