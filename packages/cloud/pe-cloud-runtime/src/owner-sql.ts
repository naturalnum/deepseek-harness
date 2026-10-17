/** Fixed PostgreSQL statements; owner transitions never depend on a heartbeat lease. */

const projection = `jsonb_build_object(
  'accountId', account_id, 'ownerInstanceId', owner_instance_id,
  'epoch', epoch::text, 'phase', phase, 'recipeVersion', recipe_version,
  'heartbeatAt', to_char(heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
) AS owner`

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

/** Known setup cleanup or a ready graph can enter draining; this never publishes ready or unquarantines. */
export const beginOwnerDrainSql = `UPDATE public.pe_account_owners
SET phase = 'draining', updated_at = statement_timestamp()
WHERE account_id = $1 AND owner_instance_id = $2 AND epoch = $3::bigint AND phase IN ('mounting', 'ready')
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
