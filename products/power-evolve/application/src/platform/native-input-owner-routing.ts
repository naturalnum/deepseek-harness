/** Route browser queue commands to the current PG Writer's statically configured Host. */
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PlatformError, type UserId } from '../contracts.ts'
import type { InputCommandReceipt, NativeInputQueueCommand } from '../native-input-ledger-contracts.ts'
import { nativeInputRecordDigest, readInputReceipt } from '../native-input-ledger-records.ts'
import { nativeInputOwnerRoutingConfig, type NativeInputOwnerRoutingConfig } from '../native-input-owner-routing-config.ts'
import { requireBrowserAccount } from './account-authority.ts'
import { transaction } from './database.ts'

/** Must use the actual immutable ledger; null means no existing command in this browser/Session nonce scope. */
export type NativeInputQueueReplay = (credential: string, command: NativeInputQueueCommand) => Promise<InputCommandReceipt | null>

const ownerRow = z.object({ workerId: z.uuid(), writerEpoch: z.number().int().positive(),
  operationId: z.uuid(), operationEpoch: z.number().int().positive() }).strict()
const remoteFailure = z.object({ error: z.string().regex(/^[a-z][a-z0-9_]*$/u).max(200) }).strict()
const ownerColumns = `w.worker_id AS "workerId",w.epoch::double precision AS "writerEpoch",
  o.id AS "operationId",s.lease_epoch AS "operationEpoch"`
const currentOwner = `FROM pe_sessions s JOIN pe_native_writers w ON w.session_id=s.id
  JOIN pe_operations o ON o.session_id=s.id
  JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=s.lease_epoch
  WHERE s.id=$1 AND s.user_id=$2 AND s.lease_epoch>0 AND s.grant_digest IS NOT NULL
    AND s.lease_until>clock_timestamp() AND w.expires_at>clock_timestamp()
    AND o.state='running' AND o.error_code IS DISTINCT FROM 'cancel_requested'
    AND a.ended_at IS NULL AND a.worker_id=w.worker_id`

function receipt(value: unknown, command: NativeInputQueueCommand, userId: UserId): InputCommandReceipt {
  let result: InputCommandReceipt
  try { result = readInputReceipt(value) }
  catch (_invalidReceipt) { throw new PlatformError(502, 'native_input_owner_response_invalid') }
  const expectedKind = command.payload.action.kind === 'steer' ? 'retarget' : command.payload.action.kind
  if (result.sessionId !== command.payload.sessionId || result.rpcNonce !== command.rpcNonce
    || result.payloadDigest !== nativeInputRecordDigest(command) || result.actor.kind !== 'browser'
    || result.actor.userId !== userId || result.kind !== expectedKind) {
    throw new PlatformError(502, 'native_input_owner_response_mismatch')
  }
  return result
}

/** Browser credentials live only for this request; no grant, Writer token or phase enters the forwarded command. */
export class NativeInputOwnerRouting {
  private readonly config: NativeInputOwnerRoutingConfig

  /**
   * @param pool Actual Platform database owner; the router creates no leases or registry rows.
   * @param config Required operator allowlist and bounded HTTP response settings.
   * @param replay Actual ledger lookup, installed explicitly before enabling public routing.
   */
  constructor(private readonly pool: Pool, config: NativeInputOwnerRoutingConfig, private readonly replay: NativeInputQueueReplay) {
    const parsed = nativeInputOwnerRoutingConfig.parse(config)
    this.config = Object.freeze({ ...parsed, workerOrigins: Object.freeze(parsed.workerOrigins) })
  }

  /** Authenticate before replay, then forward once to the exact live Writer/current attempt owner.
   * @param credential Original browser bearer, never persisted or replaced by a service credential.
   * @param command Already validated native queue command retaining its original nonce and full payload.
   * @returns Strict tokenless receipt; missing owners, expiry, mismatched attempts and HTTP failures refuse.
   */
  async queue(credential: string, command: NativeInputQueueCommand): Promise<InputCommandReceipt> {
    const userId = await transaction(this.pool, client => this.browser(client, credential, command))
    const prior = await this.replay(credential, command)
    if (prior !== null) {
      await transaction(this.pool, client => this.browser(client, credential, command))
      return receipt(prior, command, userId)
    }
    const origin = await transaction(this.pool, async (client) => {
      const currentUser = await this.browser(client, credential, command)
      if (currentUser !== userId) throw new PlatformError(401, 'account_unauthorized')
      const found = await client.query<Record<string, unknown>>(`SELECT ${ownerColumns} ${currentOwner} FOR SHARE OF w,o,a`,
        [command.payload.sessionId, userId])
      if (found.rows.length !== 1) throw new PlatformError(409, 'native_input_owner_unavailable')
      const parsed = ownerRow.safeParse(found.rows[0])
      if (!parsed.success) throw new PlatformError(503, 'native_input_owner_corrupt')
      const owner = parsed.data
      // Clock predicates may have run before a row-lock wait; recheck after all occupancy locks are held.
      const live = await client.query(`SELECT s.id ${currentOwner}
        AND w.worker_id=$3 AND w.epoch=$4 AND o.id=$5 AND s.lease_epoch=$6`,
      [command.payload.sessionId, userId, owner.workerId, owner.writerEpoch, owner.operationId, owner.operationEpoch])
      if (live.rowCount !== 1) throw new PlatformError(409, 'native_input_owner_unavailable')
      await requireBrowserAccount(client, credential)
      const destination = this.config.workerOrigins[owner.workerId]
      if (destination === undefined || !Object.hasOwn(this.config.workerOrigins, owner.workerId)) {
        throw new PlatformError(503, 'native_input_owner_unmapped')
      }
      return destination
    })
    return this.forward(origin, credential, command, userId)
  }

  private async browser(client: PoolClient, credential: string, command: NativeInputQueueCommand): Promise<UserId> {
    const actor = await requireBrowserAccount(client, credential)
    const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR SHARE',
      [command.payload.sessionId, actor.userId])
    if (owned.rowCount !== 1) throw new PlatformError(404, 'session_not_found')
    return actor.userId
  }

  private async forward(origin: string, credential: string, command: NativeInputQueueCommand,
    userId: UserId): Promise<InputCommandReceipt> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.config.timeoutMs)
    try {
      const response = await fetch(new URL('/native/input/queue', origin), { method: 'POST', redirect: 'error',
        signal: controller.signal, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(command) })
      const value = await this.readResponse(response, controller)
      if (!response.ok) {
        const failure = remoteFailure.safeParse(value)
        if (response.status < 400 || response.status > 599 || !failure.success) {
          throw new PlatformError(502, 'native_input_owner_response_invalid')
        }
        throw new PlatformError(response.status, failure.data.error)
      }
      return receipt(value, command, userId)
    } catch (error) {
      if (error instanceof PlatformError) throw error
      if (controller.signal.aborted) throw new PlatformError(504, 'native_input_owner_timeout')
      throw new PlatformError(502, 'native_input_owner_unavailable')
    } finally { clearTimeout(timer); controller.abort() }
  }

  private async readResponse(response: Response, controller: AbortController): Promise<unknown> {
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) {
      throw new PlatformError(502, 'native_input_owner_response_invalid')
    }
    if (length !== null && Number(length) > this.config.maxResponseBytes) {
      throw new PlatformError(502, 'native_input_owner_response_budget')
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) {
      throw new PlatformError(502, 'native_input_owner_response_invalid')
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > this.config.maxResponseBytes) {
          controller.abort()
          throw new PlatformError(502, 'native_input_owner_response_budget')
        }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) }
    catch (_invalidJson) { throw new PlatformError(502, 'native_input_owner_response_invalid') }
  }
}
