/** User-owned settings and platform-owned model grants. No provider credentials are stored here. */
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { PlatformError, settings, type Identity, type Settings, type SettingsUpdateRequest } from '../contracts.ts'
import { lockAccountAdministration, requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'

/** Operator seed grant fields; existing seeds never update persisted authorization. */
export const seedModel = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  label: z.string().trim().min(1).max(100),
  maxTokens: z.number().int().min(1).max(8192),
  enabled: z.boolean().default(true),
}).strict()
/** Validated initial platform-owned model grant. */
export type SeedModel = z.infer<typeof seedModel>

/**
 * Existing seed files implicitly grant only the initial model.
 * @param initial Validated initial user settings.
 * @param requested Optional explicit seed grants.
 * @returns Unique grants covering the initial settings.
 */
export function initialModels(initial: Settings, requested?: readonly SeedModel[]): SeedModel[] {
  const models = requested ? [...requested] : [seedModel.parse({
    id: initial.model, label: initial.model, maxTokens: initial.maxTokens, enabled: true,
  })]
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Duplicate seeded model ID')
  if (!models.some(model => model.id === initial.model && model.enabled && model.maxTokens >= initial.maxTokens)) {
    throw new Error('Initial user model must be enabled and cover initial maxTokens')
  }
  return models
}

/**
 * Never reseed grants or password for an existing username or tombstone after a restart.
 * @param pool Platform database pool.
 * @param username Exact existing seed login name.
 * @param passwordHash Salted password record used only for a new identity.
 * @param initial Initial settings used only for a new identity.
 * @param requested Optional initial grants used only for a new identity.
 */
export async function seedNewUser(pool: Pool, username: string, passwordHash: string,
  initial: Settings, requested?: readonly SeedModel[]): Promise<void> {
  await transaction(pool, async (client) => {
    await lockAccountAdministration(client)
    if ((await client.query('SELECT 1 FROM pe_users WHERE username=$1', [username])).rowCount) return
    if ((await client.query('SELECT 1 FROM pe_users WHERE lower(username)=lower($1)', [username])).rowCount) {
      throw new Error('Seed username conflicts with an existing account identity')
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)
       ON CONFLICT(username) DO NOTHING RETURNING id`,
      [randomUUID(), username, passwordHash, initial],
    )
    const id = inserted.rows[0]?.id
    if (!id) return
    const models = initialModels(initial, requested)
    for (const model of models) await client.query(
      'INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$3,$4,$5)',
      [id, model.id, model.label, model.maxTokens, model.enabled],
    )
  })
}

/**
 * Check the current model grant even when the operation was accepted earlier.
 * @param client The caller's transaction query interface.
 * @param userId User owning the execution grant.
 * @param model Requested deployment model ID.
 * @param maxTokens Requested token ceiling.
 * @param provider Native route; omission retains the historical deployment grant.
 * @param reasoningEffort Native resolved effort, if one was selected.
 */
export async function requireModelGrant(client: Pick<PoolClient, 'query'>, userId: string,
  model: string, maxTokens: number, provider = 'power-evolve', reasoningEffort?: string): Promise<void> {
  if (provider !== 'power-evolve') {
    const row = await client.query<{ descriptor: unknown }>(`SELECT descriptor FROM pe_tenant_model_catalog
      WHERE user_id=$1 AND provider=$2 AND model_id=$3 AND max_tokens >= $4 FOR SHARE`, [userId, provider, model, maxTokens])
    if (!row.rows[0]) throw new PlatformError(403, 'model_not_authorized')
    if (reasoningEffort !== undefined) {
      const descriptor = z.object({ reasoning: z.object({ efforts: z.array(z.object({ id: z.string() })) }).optional() })
        .parse(row.rows[0].descriptor)
      if (descriptor.reasoning === undefined ? reasoningEffort !== 'off'
        : !descriptor.reasoning.efforts.some(effort => effort.id === reasoningEffort)) throw new PlatformError(403, 'model_reasoning_not_authorized')
    }
    return
  }
  if (reasoningEffort !== undefined && reasoningEffort !== 'off') throw new PlatformError(403, 'model_reasoning_not_authorized')
  const result = await client.query(
    'SELECT 1 FROM pe_user_models WHERE user_id=$1 AND model_id=$2 AND enabled=true AND max_tokens >= $3 FOR SHARE',
    [userId, model, maxTokens],
  )
  if (!result.rowCount) throw new PlatformError(403, 'model_not_authorized')
}

/** Preserve existing Session defaults before changing an account's next-Session selection.
 * @param client Account-locked transaction.
 * @param userId Original authenticated account.
 * @param previous Original account default.
 */
export async function retainSessionModelDefaults(client: PoolClient, userId: string, previous: Settings): Promise<void> {
  await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision)
    SELECT user_id,'session-model:'||id::text,$2::jsonb,1 FROM pe_sessions WHERE user_id=$1
    ON CONFLICT(user_id,namespace) DO NOTHING`, [userId, { provider: previous.provider ?? 'power-evolve', model: previous.model,
    ...previous.reasoningEffort === undefined ? previous.provider === undefined ? { reasoningEffort: 'off' } : {}
      : { reasoningEffort: previous.reasoningEffort } }])
}

/** Materialize the maintained adapter's default effort for native selection persistence.
 * @param client Current account transaction.
 * @param userId Original authenticated owner.
 * @param provider Native adapter route.
 * @param model Native model identity.
 * @param requested Explicit effort; omission follows the adapter's stored native default.
 * @returns The same optional resolved effort that native LlmRuntime would select.
 */
export async function resolveModelEffort(client: PoolClient, userId: string, provider: string,
  model: string, requested?: string): Promise<string | undefined> {
  if (requested !== undefined) return requested
  if (provider === 'power-evolve') return 'off'
  const row = await client.query<{ descriptor: unknown }>('SELECT descriptor FROM pe_tenant_model_catalog WHERE user_id=$1 AND provider=$2 AND model_id=$3', [userId, provider, model])
  if (!row.rows[0]) throw new PlatformError(403, 'model_not_authorized')
  return z.object({ reasoning: z.object({ defaultEffort: z.string().optional() }).optional() })
    .parse(row.rows[0].descriptor).reasoning?.defaultEffort
}

/** Resolve one Session's selection without allowing another Session's newer default to replace it.
 * @param client Original account and Session transaction.
 * @param userId Authenticated Session owner.
 * @param sessionId Exact receiving Session.
 * @param current Current account settings, including its token ceiling and revision.
 * @returns Detached settings checked against the original owner's current model grant.
 */
export async function sessionModelSettings(client: PoolClient, userId: string, sessionId: SessionId, current: Settings): Promise<Settings> {
  const selected = await client.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
    [userId, `session-model:${sessionId}`])
  const config = { ...current }
  if (selected.rows[0]) {
    const value = z.object({ provider: z.string().min(1).max(128), model: z.string().min(1).max(1024),
      reasoningEffort: z.string().min(1).max(128).optional() }).strict().parse(selected.rows[0].value)
    const legacy = value.provider === 'power-evolve'
    const grant = await client.query<{ max_tokens: number }>(legacy
      ? 'SELECT max_tokens FROM pe_user_models WHERE user_id=$1 AND model_id=$2 AND enabled=true'
      : 'SELECT max_tokens FROM pe_tenant_model_catalog WHERE user_id=$1 AND model_id=$2 AND provider=$3',
    legacy ? [userId, value.model] : [userId, value.model, value.provider])
    if (!grant.rows[0]) throw new PlatformError(403, 'model_not_authorized')
    config.model = value.model
    config.maxTokens = Math.min(current.maxTokens, grant.rows[0].max_tokens)
    delete config.provider
    delete config.reasoningEffort
    if (!legacy) {
      config.provider = value.provider
      if (value.reasoningEffort !== undefined) config.reasoningEffort = value.reasoningEffort
    }
  }
  await requireModelGrant(client, userId, config.model, config.maxTokens, config.provider, config.reasoningEffort)
  return config
}

/** Authenticated requests derive their owner from the credential, never from request JSON. */
export class AccountSettingsService {
  constructor(private readonly pool: Pool) {}

  /**
   * Return model grants after checking the raw browser credential in the read transaction.
   * @param user Stable identity from the outer authentication step.
   * @param credentialToken Raw Agent bearer rechecked against the locked user.
   * @returns Current enabled model grants.
   */
  async modelsList(user: Identity, credentialToken: string): Promise<{ models: { id: string; label: string; maxTokens: number }[] }> {
    return transaction(this.pool, async (client) => {
      const authority = await requireBrowserAccount(client, credentialToken)
      if (authority.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const result = await client.query<{ id: string; label: string; maxTokens: number }>(
        `SELECT model_id AS id,label,max_tokens AS "maxTokens" FROM pe_user_models
         WHERE user_id=$1 AND enabled=true ORDER BY model_id`, [user.userId],
      )
      return { models: result.rows }
    })
  }

  /**
   * Persist a revisioned settings mutation after transaction-local credential and grant checks.
   * @param user Stable identity from the outer authentication step.
   * @param input Parsed settings request and expected revision.
   * @param credentialToken Raw Agent bearer rechecked under the exclusive user lock.
   * @returns New settings or the original settings receipt for an identical request.
   */
  async update(user: Identity, input: SettingsUpdateRequest, credentialToken: string): Promise<Settings> {
    const fields = [input.expectedRevision, input.model, input.maxTokens]
    const fingerprint = createHash('sha256').update(JSON.stringify(input.provider === undefined && input.reasoningEffort === undefined
      ? fields : [...fields, input.provider, input.reasoningEffort])).digest('hex')
    return transaction(this.pool, async (client) => {
      const authority = await requireBrowserAccount(client, credentialToken, { lock: 'update' })
      if (authority.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const current = await client.query<{ settings: unknown }>(
        'SELECT settings FROM pe_users WHERE id=$1', [user.userId],
      )
      if (!current.rows[0]) throw new PlatformError(401, 'unauthorized')
      const prior = await client.query<{ request_digest: string; result_settings: unknown }>(
        'SELECT request_digest,result_settings FROM pe_settings_mutations WHERE user_id=$1 AND request_id=$2',
        [user.userId, input.requestId],
      )
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== fingerprint) throw new PlatformError(409, 'request_id_conflict')
        return settings.parse(prior.rows[0].result_settings)
      }
      const previous = settings.parse(current.rows[0].settings)
      if (previous.revision !== input.expectedRevision) throw new PlatformError(409, 'settings_revision_conflict')
      await requireModelGrant(client, user.userId, input.model, input.maxTokens, input.provider, input.reasoningEffort)
      await retainSessionModelDefaults(client, user.userId, previous)
      const next = settings.parse({ model: input.model, maxTokens: input.maxTokens, revision: previous.revision + 1,
        ...input.provider === undefined ? {} : { provider: input.provider },
        ...input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort } })
      await client.query('UPDATE pe_users SET settings=$2 WHERE id=$1', [user.userId, next])
      await client.query(
        'INSERT INTO pe_settings_mutations(user_id,request_id,request_digest,result_settings) VALUES($1,$2,$3,$4)',
        [user.userId, input.requestId, fingerprint, next],
      )
      return next
    })
  }
}
