/** Parameterized writes touch only the current process-registration row, never account owners. */
const projection = String.raw`jsonb_build_object(
  'instanceId', instance_id, 'internalAddress', internal_address, 'recipeVersion', recipe_version,
  'phase', phase, 'heartbeatAt', to_char(heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
) AS instance`

/** Duplicate ids never replace deployment metadata or reopen a closed registration. */
export const registerInstanceSql = `INSERT INTO public.pe_instances (instance_id, internal_address, recipe_version, phase)
VALUES ($1, $2, $3, 'registered') ON CONFLICT (instance_id) DO NOTHING RETURNING ${projection}`

/** A point lookup reports metadata only; it is not a routing or recovery decision. */
export const locateInstanceSql = `SELECT ${projection} FROM public.pe_instances WHERE instance_id = $1`

/** Staleness never appears in a predicate granting or removing owner authority. */
export const heartbeatInstanceSql = `UPDATE public.pe_instances SET heartbeat_at = statement_timestamp()
WHERE instance_id = $1 AND internal_address = $2 AND recipe_version = $3 AND phase = 'registered' RETURNING ${projection}`

/** Closed is an explicit registration observation, not proof that the process or its accounts stopped. */
export const closeInstanceSql = `UPDATE public.pe_instances SET phase = 'closed', heartbeat_at = statement_timestamp()
WHERE instance_id = $1 AND internal_address = $2 AND recipe_version = $3 AND phase = 'registered' RETURNING ${projection}`
