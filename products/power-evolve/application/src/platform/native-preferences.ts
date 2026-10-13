/** Tenant-owned native browser settings and Session model intent; shared Profile configuration stays separate. */
import type { Pool } from 'pg'
import { z } from 'zod'
import { PlatformError, type Identity } from '../contracts.ts'
import { transaction } from './database.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { requireModelGrant } from './account-settings.ts'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { EventLimits } from './events.ts'
import { appendOwnedEvents } from './native-owned-append.ts'
import { nativeModelSelect } from '../native-session-contracts.ts'
export { nativeModelSelect } from '../native-session-contracts.ts'

/** Only native presentation preferences can be written through the Settings page. */
export const nativePreferenceNamespace = z.enum(['ui-settings', 'ui-settings-general'])
const developer = z.object({ enabled: z.boolean().optional() }).strict()
const welcome = z.object({ welcomeNoticeVersion: z.string().max(256).optional() }).strict()
const record = z.record(z.string(), z.json())
const edit = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.tuple([z.string()]), value: z.json() }).strict(),
  z.object({ op: z.literal('unset'), path: z.tuple([z.string()]) }).strict(),
])
/** Native settings writes retain the upstream expected-revision semantics. */
export const nativePreferenceWrite = z.object({ ns: nativePreferenceNamespace,
  mode: z.enum(['update', 'replace', 'mutate']), value: z.union([record, z.array(edit).max(32)]),
  expectedRevision: z.number().int().positive().optional() }).strict()

interface Row { value: unknown; revision: number }
function parse(ns: z.infer<typeof nativePreferenceNamespace>, value: unknown): Record<string, unknown> {
  return ns === 'ui-settings' ? developer.parse(value) : welcome.parse(value)
}

/** PG owns per-user preferences across browser generations and replicas. */
export class NativePreferences {
  constructor(private readonly pool: Pool, private readonly limits: EventLimits) {}

  /** Read one owned preference; an absent record has revision one.
   * @param user Authenticated owner.
   * @param ns Native presentation namespace.
   * @returns Validated personal values and the current write revision.
   */
  async read(user: Identity, ns: z.infer<typeof nativePreferenceNamespace>): Promise<{ value: Record<string, unknown>; revision: number }> {
    const result = await this.pool.query<Row>('SELECT value,revision FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2', [user.userId, ns])
    const row = result.rows[0]
    return { value: parse(ns, row?.value ?? {}), revision: row?.revision ?? 1 }
  }

  /** Mutate only the caller's native preferences under the account lock.
   * @param user Authenticated owner.
   * @param token Original browser credential rechecked before the write.
   * @param request Parsed native Settings operation.
   * @returns Persisted values; stale revisions and unknown fields reject without a write.
   */
  async write(user: Identity, token: string, request: z.infer<typeof nativePreferenceWrite>): Promise<{
    value: Record<string, unknown>
    revision: number
  }> {
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, token, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const result = await client.query<Row>('SELECT value,revision FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2 FOR UPDATE', [user.userId, request.ns])
      const row = result.rows[0], revision = row?.revision ?? 1
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) throw new PlatformError(409, 'native_settings_conflict')
      const prior = parse(request.ns, row?.value ?? {})
      let value: unknown
      if (request.mode === 'mutate') {
        const edits = z.array(edit).max(32).parse(request.value)
        const next = { ...prior }
        for (const operation of edits) {
          const key = operation.path[0]
          if (!['enabled', 'welcomeNoticeVersion'].includes(key)) throw new PlatformError(400, 'native_settings_rejected')
          if (operation.op === 'unset') {
            if (key === 'enabled') delete next.enabled
            else delete next.welcomeNoticeVersion
          }
          else next[key] = operation.value
        }
        value = next
      } else {
        const fields = record.parse(request.value)
        value = request.mode === 'replace' ? fields : { ...prior, ...fields }
      }
      const parsed = parse(request.ns, value)
      await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,revision=EXCLUDED.revision,updated_at=clock_timestamp()`,
      [user.userId, request.ns, parsed, revision + 1])
      return { value: parsed, revision: revision + 1 }
    })
  }

  /** Persist the next model for one owned Session after checking current grants.
   * @param user Authenticated owner.
   * @param token Current browser credential.
   * @param request Native model selection, with cloud placement fixed by Platform.
   * @returns The exact authorized selection; other Sessions retain their own intent.
   */
  async selectModel(user: Identity, token: string, request: z.infer<typeof nativeModelSelect>): Promise<{ selected: { provider: string; model: string; reasoningEffort: 'off' } }> {
    return transaction(this.pool, async (client) => {
      const actor = await requireBrowserAccount(client, token, { lock: 'update' })
      if (actor.userId !== user.userId) throw new PlatformError(401, 'unauthorized')
      const session = await client.query<{ header: unknown; event_count: number; event_bytes: string; leased: boolean }>(
        `SELECT header,event_count,event_bytes,COALESCE(lease_until>clock_timestamp(),false) AS leased
         FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [request.sessionId, user.userId])
      const row = session.rows[0]
      if (!row) throw new PlatformError(404, 'session_not_found')
      // A live writer owns the append sequence. User intent may only append while no lease exists.
      if (row.leased) throw new PlatformError(409, 'native_session_busy')
      await requireModelGrant(client, user.userId, request.model, 1)
      const selected = { provider: request.provider, model: request.model, reasoningEffort: 'off' as const }
      const event: SessionEvent = { seq: SessionSeq(row.event_count), time: Date.now(), type: 'model/selection', data: selected }
      await appendOwnedEvents(client, user.userId, { ...row, id: request.sessionId }, [event], this.limits)
      await client.query(`INSERT INTO pe_native_preferences(user_id,namespace,value,revision) VALUES($1,$2,$3,1)
        ON CONFLICT(user_id,namespace) DO UPDATE SET value=EXCLUDED.value,revision=pe_native_preferences.revision+1,updated_at=clock_timestamp()`,
      [user.userId, `session-model:${request.sessionId}`, selected])
      return { selected }
    })
  }
}
