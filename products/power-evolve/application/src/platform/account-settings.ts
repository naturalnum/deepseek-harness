/** User-owned settings and platform-owned model grants. No provider credentials are stored here. */
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, settings, type Identity, type Settings, type SettingsUpdateRequest } from '../contracts.ts'
import { transaction } from './database.ts'

export const seedModel = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  label: z.string().trim().min(1).max(100),
  maxTokens: z.number().int().min(1).max(8192),
  enabled: z.boolean().default(true),
}).strict()
export type SeedModel = z.infer<typeof seedModel>

/** Existing seed files implicitly grant only the initial model. */
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

/** Never reseed grants or password for an existing username after a restart. */
export async function seedNewUser(pool: Pool, username: string, passwordHash: string,
  initial: Settings, requested?: readonly SeedModel[]): Promise<void> {
  await transaction(pool, async client => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)
       ON CONFLICT(username) DO NOTHING RETURNING id`,
      [randomUUID(), username, passwordHash, initial],
    )
    const id = inserted.rows[0]?.id
    if (!id) return
    const models = initialModels(initial, requested)
    for (const model of models) await client.query(
      `INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled) VALUES($1,$2,$3,$4,$5)`,
      [id, model.id, model.label, model.maxTokens, model.enabled],
    )
  })
}

/** Check the current grant even when the operation was accepted earlier. */
export async function requireModelGrant(client: Pick<PoolClient, 'query'>, userId: string,
  model: string, maxTokens: number): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM pe_user_models WHERE user_id=$1 AND model_id=$2 AND enabled=true AND max_tokens >= $3 FOR SHARE`,
    [userId, model, maxTokens],
  )
  if (!result.rowCount) throw new PlatformError(403, 'model_not_authorized')
}

/** Authenticated requests derive their owner from the credential, never from request JSON. */
export class AccountSettingsService {
  constructor(private readonly pool: Pool) {}

  async modelsList(user: Identity): Promise<{ models: { id: string; label: string; maxTokens: number }[] }> {
    const result = await this.pool.query<{ id: string; label: string; maxTokens: number }>(
      `SELECT model_id AS id,label,max_tokens AS "maxTokens" FROM pe_user_models
       WHERE user_id=$1 AND enabled=true ORDER BY model_id`, [user.userId],
    )
    return { models: result.rows }
  }

  async update(user: Identity, input: SettingsUpdateRequest): Promise<Settings> {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      input.expectedRevision, input.model, input.maxTokens,
    ])).digest('hex')
    return transaction(this.pool, async client => {
      const current = await client.query<{ settings: unknown }>(
        'SELECT settings FROM pe_users WHERE id=$1 FOR UPDATE', [user.userId],
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
      await requireModelGrant(client, user.userId, input.model, input.maxTokens)
      const next = settings.parse({ model: input.model, maxTokens: input.maxTokens, revision: previous.revision + 1 })
      await client.query('UPDATE pe_users SET settings=$2 WHERE id=$1', [user.userId, next])
      await client.query(
        `INSERT INTO pe_settings_mutations(user_id,request_id,request_digest,result_settings) VALUES($1,$2,$3,$4)`,
        [user.userId, input.requestId, fingerprint, next],
      )
      return next
    })
  }
}
