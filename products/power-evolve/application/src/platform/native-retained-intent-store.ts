/** Platform-authoritative private original requests, atomic native acknowledgements and cold reconciliation. */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { operationId, sessionId, userId, PlatformError } from '../contracts.ts'
import { nativeRetainedExecute, nativeRetainedFamily, nativeRetainedIntentId, nativeRetainedPrepare,
  nativeRetainedPrepared, nativeRetainedReceipt, nativeRetainedReconcile, nativeRetainedReconciled,
  nativeRetainedExecutionResult, type NativeRetainedExecutionResult, type NativeRetainedReceipt, type NativeRetainedMutation } from '../native-retained-intent-contracts.ts'
import { nativeRetainedResolve, nativeRetainedResolved } from '../native-retained-intent-contracts.ts'
import { nativeWriterEpoch, nativeWriterWorkerId } from '../native-writer-contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { headerSchema, parseEvents } from '../session-records.ts'
import { requireActiveAccount, requireBrowserAccount, lockAccountAuthorities } from './account-authority.ts'
import { transaction } from './database.ts'
import { digest } from './identity.ts'
import { NativeRetainedIntentCipher } from './native-retained-intent-cipher.ts'
import type { NativeAssistantStore } from './native-assistant-store.ts'
import type { NativeInputCommit } from './native-input-commit.ts'
import type { NativePreparedCancel } from './native-prepared-cancel.ts'
import type { NativeArchiveInputCancel } from './native-archive-input.ts'
import type { NativeTurnContinuationV2 } from './native-turn-continuation-v2.ts'
import type { NativeWriterIdentity } from '../native-writer-contracts.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'
import type { TaskStore } from './tasks.ts'

/** Explicit deployment limits apply under the actual Session lock, including all retained terminal records. */
export interface NativeRetainedIntentLimits {
  readonly maxRequestBytes: number
  readonly maxPendingPerSession: number
  readonly maxRecordsPerSession: number
  readonly maxRetainedBytesPerSession: number
}
/** Actual purpose-specific providers; each retains all original authority and final-clock proofs. */
export interface NativeRetainedIntentServices {
  readonly publication: NativeAssistantStore
  readonly input: NativeInputCommit
  readonly preparedCancel: NativePreparedCancel
  readonly archiveCancel: NativeArchiveInputCancel
  readonly turn: NativeTurnContinuationV2
}
const positive = z.number().int().positive().max(2_147_483_647)
const limitsCodec = z.object({ maxRequestBytes: positive, maxPendingPerSession: positive,
  maxRecordsPerSession: positive, maxRetainedBytesPerSession: positive }).strict()
const rowCodec = z.object({ intentId: nativeRetainedIntentId, mutationKey: nativeRetainedIntentId,
  family: nativeRetainedFamily, fenceKind: z.enum(['operation', 'operation-and-writer']), userId, sessionId, operationId, operationEpoch: positive,
  operationDigest: nativeRetainedIntentId, workerId: nativeWriterWorkerId, writerEpoch: nativeWriterEpoch.nullable(),
  writerDigest: nativeRetainedIntentId.nullable(), preparedEventCount: z.number().int().nonnegative(),
  sealed: z.instanceof(Buffer).nullable(), requestBytes: z.number().int().nonnegative(),
  state: z.enum(['prepared', 'committed', 'abandoned']), receipt: z.unknown() }).strict()
type Row = z.infer<typeof rowCodec>
const hintCodec = rowCodec.pick({ intentId: true, family: true, fenceKind: true, userId: true, sessionId: true,
  operationId: true, operationEpoch: true, operationDigest: true, workerId: true, writerEpoch: true, writerDigest: true })
type Hint = z.infer<typeof hintCodec>
const hintColumns = `intent_id AS "intentId",family,fence_kind AS "fenceKind",user_id AS "userId",session_id AS "sessionId",
  operation_id AS "operationId",operation_epoch AS "operationEpoch",operation_digest AS "operationDigest",
  worker_id AS "workerId",writer_epoch::double precision AS "writerEpoch",writer_digest AS "writerDigest"`
class NativeRetainedResponseFull extends Error {}
type Prepared = z.infer<typeof nativeRetainedPrepared>
type Reconciled = z.infer<typeof nativeRetainedReconciled>
const columns = `intent_id AS "intentId",mutation_key AS "mutationKey",family,fence_kind AS "fenceKind",user_id AS "userId",
  session_id AS "sessionId",operation_id AS "operationId",operation_epoch AS "operationEpoch",
  operation_digest AS "operationDigest",worker_id AS "workerId",writer_epoch::double precision AS "writerEpoch",
  writer_digest AS "writerDigest",prepared_event_count AS "preparedEventCount",request_sealed AS sealed,
  request_bytes AS "requestBytes",state,receipt_json AS receipt`
const sealedRequest = z.object({ operationToken: z.string().min(1), prepare: nativeRetainedPrepare }).strict()
function refuse(code: string): never { throw new PlatformError(409, code) }
function corrupt(): never { throw new PlatformError(503, 'native_intent_corrupt') }
function assertNever(_value: never): never { return corrupt() }
function aad(row: Row) {
  return { version: 1, intentId: row.intentId, mutationKey: row.mutationKey, family: row.family,
    fenceKind: row.fenceKind, userId: row.userId, sessionId: row.sessionId,
    operationId: row.operationId, operationEpoch: row.operationEpoch,
    operationDigest: row.operationDigest, workerId: row.workerId,
    writerEpoch: row.writerEpoch, writerDigest: row.writerDigest }
}

/** A prepared row grants no authority; execute always invokes the original provider and final fence. */
export class NativeRetainedIntentStore {
  private readonly limits: NativeRetainedIntentLimits
  private readonly cipher: NativeRetainedIntentCipher

  /**
   * @param tasks Actual account, Session, operation and database owner.
   * @param writers Actual independent Writer provider, used by Writer-bearing families.
   * @param services Existing purpose-specific providers; no Host-supplied acknowledgement is accepted.
   * @param encodedKey Dedicated canonical 32-byte base64url deployment key from nativeIntentKeyFile.
   * @param limits Required bounded request, pending, retained record and retained byte limits.
   */
  constructor(private readonly tasks: TaskStore, private readonly writers: NativeSessionWriter,
    private readonly services: NativeRetainedIntentServices, encodedKey: string, limits: NativeRetainedIntentLimits) {
    this.limits = limitsCodec.parse(limits)
    this.cipher = new NativeRetainedIntentCipher(encodedKey)
  }

  /** Seal one complete original request before any native mutation is dispatched.
   * @param operationToken Original real operation bearer; nested credentials remain inside ciphertext.
   * @param input Strict version-one worker and original mutation body.
   * @returns Tokenless keyed identity and unchanged durable state for an exact whole-input retry.
   */
  async prepare(operationToken: string, input: unknown): Promise<Prepared> {
    const parsed = nativeRetainedPrepare.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    const request = parsed.data
    this.bytes({ operationToken, prepare: request })
    this.validate(request.mutation)
    if (request.mutation.family === 'turn-transition' && request.mutation.request.from.operationToken !== operationToken) {
      refuse('native_intent_scope')
    }
    const intentId = nativeRetainedIntentId.parse(this.cipher.identity('request', { operationToken, prepare: request }))
    return transaction(this.tasks.pool, async (client) => {
      const existing = await this.hint(client, intentId)
      if (existing) {
        await this.owner(client, existing)
        const original = await this.read(client, intentId)
        this.authenticate(original, operationToken, request.workerId)
        return this.prepared(original)
      }
      if (request.mutation.family === 'queue') {
        const account = await requireBrowserAccount(client, request.mutation.request.credential, { lock: 'update' })
        await this.tasks.owned(client, { userId: account.userId, username: account.username },
          request.mutation.request.request.command.payload.sessionId)
      }
      const session = await this.tasks.authorized(client, operationToken)
      const writer = this.writer(request.mutation)
      if (writer) {
        if (writer.workerId !== request.workerId || writer.sessionId !== session.id) refuse('native_intent_scope')
        const current = await this.writers.requireInTransaction(client, writer)
        if (current.userId !== session.user_id) refuse('native_intent_scope')
      }
      if (request.mutation.family === 'publication' && request.mutation.request.epoch !== session.lease_epoch) refuse('native_intent_scope')
      const attempt = await client.query<{ workerId: string }>(`SELECT worker_id AS "workerId" FROM pe_attempts
        WHERE operation_id=$1 AND epoch=$2 AND ended_at IS NULL FOR UPDATE`, [session.operation_id, session.lease_epoch])
      if (attempt.rowCount !== 1 || attempt.rows[0]?.workerId !== request.workerId) refuse('native_intent_scope')
      this.validate(request.mutation, session.header)
      const rawEvents = this.events(request.mutation)
      const decoded = parseEvents(headerSchema.parse(session.header), rawEvents)
      if (nativeInputRecordDigest(decoded) !== nativeInputRecordDigest(rawEvents)) refuse('native_intent_event_conflict')
      const mutationKey = nativeRetainedIntentId.parse(this.cipher.identity('mutation',
        { family: request.mutation.family, sessionId: session.id, identity: this.logical(request.mutation) }))
      const conflicting = await client.query<{ intentId: string }>(`SELECT intent_id AS "intentId" FROM pe_native_retained_intents
        WHERE session_id=$1 AND family=$2 AND mutation_key=$3`, [session.id, request.mutation.family, mutationKey])
      if (conflicting.rowCount) {
        if (conflicting.rows[0]?.intentId !== intentId) refuse('native_intent_conflict')
        return this.prepared(await this.read(client, intentId))
      }
      const row: Row = { intentId, mutationKey, family: request.mutation.family,
        fenceKind: writer ? 'operation-and-writer' : 'operation', userId: userId.parse(session.user_id),
        sessionId: sessionId.parse(session.id), operationId: operationId.parse(session.operation_id),
        operationEpoch: session.lease_epoch, operationDigest: nativeRetainedIntentId.parse(digest(operationToken)),
        workerId: request.workerId, writerEpoch: writer?.epoch ?? null,
        writerDigest: writer ? nativeRetainedIntentId.parse(digest(writer.token)) : null, preparedEventCount: session.event_count,
        sealed: null, requestBytes: 0, state: 'prepared', receipt: null }
      const sealed = this.cipher.seal(aad(row), { operationToken, prepare: request })
      await this.capacity(client, row.sessionId, sealed.length)
      await client.query(`INSERT INTO pe_native_retained_intents(intent_id,mutation_key,family,user_id,session_id,
        operation_id,operation_epoch,operation_digest,worker_id,writer_epoch,writer_digest,prepared_event_count,
        request_sealed,request_bytes,fence_kind,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'prepared')`,
      [row.intentId, row.mutationKey, row.family, row.userId, row.sessionId, row.operationId, row.operationEpoch,
        row.operationDigest, row.workerId, row.writerEpoch, row.writerDigest, row.preparedEventCount, sealed, sealed.length, row.fenceKind])
      if (writer) await this.writers.assertLiveInTransaction(client, writer)
      await this.tasks.authorized(client, operationToken)
      return this.prepared(row)
    })
  }

  /** Execute only the sealed original request and save its strict ACK in the same native transaction.
   * @param operationToken Exact original operation bearer, including for historical committed result reads.
   * @param input Strict worker and keyed intent identity; no replacement body or ack is accepted.
   * @returns Original tokenless result; v2 live authority remains the original provider's responsibility.
   */
  async execute(operationToken: string, input: unknown): Promise<NativeRetainedExecutionResult> {
    const parsed = nativeRetainedExecute.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    return transaction(this.tasks.pool, async (client) => {
      const row = await this.ownedIntent(client, parsed.data.intentId)
      this.authenticate(row, operationToken, parsed.data.workerId)
      if (row.state === 'abandoned') refuse('native_intent_abandoned')
      if (row.state === 'committed' && row.family !== 'turn-transition') {
        return nativeRetainedExecutionResult.parse(this.receipt(row))
      }
      if (row.state === 'committed' && row.sealed === null) {
        const receipt = this.receipt(row)
        if (receipt.family !== 'turn-transition') corrupt()
        return nativeRetainedExecutionResult.parse({ family: 'turn-transition',
          result: { receipt: receipt.result, replayed: true, current: { kind: 'expired' } } })
      }
      const original = this.original(row)
      let acknowledged: NativeRetainedReceipt | undefined
      const acknowledge = async (receipt: NativeRetainedReceipt) => {
        if (row.state === 'committed') {
          if (nativeInputRecordDigest(receipt) !== nativeInputRecordDigest(this.receipt(row))) corrupt()
        } else await this.acknowledge(client, row, receipt)
        acknowledged = receipt
      }
      const response = await this.dispatch(client, original, acknowledge)
      if (!acknowledged) corrupt()
      const tokenless = response.family === 'turn-transition'
        ? { family: 'turn-transition' as const, result: response.result.receipt } : response
      if (nativeInputRecordDigest(tokenless) !== nativeInputRecordDigest(acknowledged)) corrupt()
      return response
    })
  }

  /** Reconcile bounded original requests under actual account, Session and journal locks.
   * @param input Caller worker, bounded scan size and optional original attempt; scoped scans require its stored owner and worker.
   * @returns Tokenless immutable acknowledgements or blocked/abandoned records; nothing grants execution.
   */
  async reconcile(input: unknown, owner?: string): Promise<Reconciled> {
    const parsed = nativeRetainedReconcile.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    if (parsed.data.limit > this.limits.maxRecordsPerSession) throw new PlatformError(413, 'native_intent_scan_budget')
    const scope = parsed.data.scope
    if (scope) {
      const original = await this.tasks.pool.query(`SELECT s.id FROM pe_sessions s
        JOIN pe_operations o ON o.session_id=s.id JOIN pe_attempts a ON a.operation_id=o.id
        WHERE s.id=$1 AND o.id=$2 AND a.epoch=$3 AND a.worker_id=$4
          AND ($5::uuid IS NULL OR s.user_id=$5)`,
      [scope.sessionId, scope.operationId, scope.operationEpoch, parsed.data.workerId, owner ?? null])
      if (original.rowCount !== 1) refuse('native_intent_scope')
    }
    const hints = await this.tasks.pool.query<{ intentId: string }>(`SELECT j.intent_id AS "intentId"
      FROM pe_native_retained_intents j JOIN pe_users u ON u.id=j.user_id
      WHERE u.enabled AND u.deleted_at IS NULL AND j.resolved_at IS NULL AND j.state<>'abandoned'
      AND ($2::uuid IS NULL OR j.user_id=$2)
      AND ($3::uuid IS NULL OR (j.session_id=$3 AND j.operation_id=$4 AND j.operation_epoch=$5 AND j.worker_id=$6))
      ORDER BY (j.state='prepared') DESC,j.created_at,j.intent_id LIMIT $1`,
    [parsed.data.limit + 1, owner ?? null, scope?.sessionId ?? null, scope?.operationId ?? null,
      scope?.operationEpoch ?? null, scope ? parsed.data.workerId : null])
    const items: Reconciled['items'] = []
    let more = hints.rows.length > parsed.data.limit
    for (const hint of hints.rows) {
      if (items.length === parsed.data.limit) { more = true; break }
      try {
        const item = await transaction(this.tasks.pool, async (client) => {
          const original = await this.hint(client, nativeRetainedIntentId.parse(hint.intentId))
          if (!original) corrupt()
          if (owner !== undefined && original.userId !== owner) throw new PlatformError(401, 'unauthorized_runtime')
          if (!await this.scanOwner(client, original)) return undefined
          const row = await this.read(client, original.intentId)
          const identity = { intentId: row.intentId, userId: row.userId, sessionId: row.sessionId,
            operationId: row.operationId, operationEpoch: row.operationEpoch, workerId: row.workerId }
          const publish = (item: Reconciled['items'][number]) => {
            const bytes = Buffer.byteLength(JSON.stringify({ version: 1, items: [...items, item], more: true }))
            if (bytes > this.limits.maxRequestBytes) {
              if (!items.length) throw new PlatformError(413, 'native_intent_response_budget')
              throw new NativeRetainedResponseFull()
            }
            return item
          }
          if (row.state === 'committed') return publish({ ...identity, outcome: { state: 'committed',
            receipt: this.receipt(row), retired: await this.retired(client, row) } })
          if (row.state === 'abandoned') return publish({ ...identity, outcome: { state: 'abandoned' } })
          this.original(row)
          if (!await this.nonrevivable(client, row) || await this.materialized(client, row)) {
            return publish({ ...identity, outcome: { state: 'blocked' } })
          }
          const changed = await client.query(`UPDATE pe_native_retained_intents SET state='abandoned',updated_at=clock_timestamp()
            WHERE intent_id=$1 AND state='prepared' AND receipt_json IS NULL`, [row.intentId])
          if (changed.rowCount !== 1) corrupt()
          return publish({ ...identity, outcome: { state: 'abandoned' } })
        })
        if (item) items.push(item)
      } catch (error) {
        if (!(error instanceof NativeRetainedResponseFull)) throw error
        more = true
        break
      }
    }
    return nativeRetainedReconciled.parse({ version: 1, items, more: more && items.length > 0 })
  }

  /** Inspect the journal barrier inside real claim/dispatch transactions holding the Session lock.
   * @param client Actual caller transaction; this query neither renews nor installs authority.
   * @param id Actual owned Session identity.
   * @returns Whether any original request remains unresolved and therefore blocks independent dispatch.
   */
  async hasPendingInTransaction(client: PoolClient, id: string): Promise<boolean> {
    return !!(await client.query("SELECT 1 FROM pe_native_retained_intents WHERE session_id=$1 AND state='prepared' LIMIT 1", [id])).rowCount
  }

  /** Clear only sealed credentials after the caller confirms its validated original acknowledgement.
   * @param input Authenticated caller worker, original intent and canonical ACK digest; other workers require retired authority.
   * @returns The permanent identity and matching digest; native facts and the immutable ACK remain intact.
   */
  async resolve(input: unknown, owner?: string): Promise<z.infer<typeof nativeRetainedResolved>> {
    const parsed = nativeRetainedResolve.safeParse(input)
    if (!parsed.success) throw new PlatformError(400, 'invalid_request')
    return transaction(this.tasks.pool, async (client) => {
      const row = await this.ownedIntent(client, parsed.data.intentId)
      if (owner !== undefined && row.userId !== owner) throw new PlatformError(401, 'unauthorized_runtime')
      if (nativeInputRecordDigest(this.receipt(row)) !== parsed.data.receiptDigest) refuse('native_intent_receipt_conflict')
      if (row.workerId !== parsed.data.workerId && !await this.retired(client, row)) refuse('native_intent_not_retired')
      if (row.sealed !== null) {
        const cleared = await client.query(`UPDATE pe_native_retained_intents SET request_sealed=NULL,request_bytes=0,
          resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE intent_id=$1 AND state='committed'
          AND request_sealed IS NOT NULL`, [row.intentId])
        if (cleared.rowCount !== 1) corrupt()
      }
      return nativeRetainedResolved.parse({ version: 1, intentId: row.intentId,
        receiptDigest: parsed.data.receiptDigest, resolved: true })
    })
  }

  private bytes(value: unknown): void {
    if (Buffer.byteLength(JSON.stringify(value)) > this.limits.maxRequestBytes) throw new PlatformError(413, 'native_intent_request_budget')
  }
  private prepared(row: Row): Prepared {
    return nativeRetainedPrepared.parse({ version: 1, intentId: row.intentId, family: row.family, state: row.state })
  }
  private async ownedIntent(client: PoolClient, id: string): Promise<Row> {
    const hint = await this.hint(client, id)
    if (!hint) refuse('native_intent_not_found')
    await this.owner(client, hint)
    return this.read(client, hint.intentId)
  }
  private async hint(client: PoolClient, id: string): Promise<Hint | undefined> {
    const found = await client.query<Record<string, unknown>>(`SELECT ${hintColumns} FROM pe_native_retained_intents WHERE intent_id=$1`, [id])
    return found.rows[0] ? hintCodec.parse(found.rows[0]) : undefined
  }
  private async read(client: PoolClient, id: string): Promise<Row> {
    const sizes = await client.query<{ requestBytes: number | null; receiptBytes: number | null }>(`SELECT
      octet_length(request_sealed) AS "requestBytes",octet_length(receipt_json::text) AS "receiptBytes"
      FROM pe_native_retained_intents WHERE intent_id=$1 FOR UPDATE`, [id])
    const size = sizes.rows[0]
    if (!size || sizes.rowCount !== 1) corrupt()
    if ((size.requestBytes ?? 0) > this.limits.maxRequestBytes + 28
      || (size.receiptBytes ?? 0) > this.limits.maxRequestBytes) throw new PlatformError(413, 'native_intent_read_budget')
    const found = await client.query<Record<string, unknown>>(`SELECT ${columns} FROM pe_native_retained_intents WHERE intent_id=$1`, [id])
    if (found.rowCount !== 1) corrupt()
    return rowCodec.parse(found.rows[0])
  }
  private async owner(client: PoolClient, row: Hint): Promise<void> {
    await requireActiveAccount(client, row.userId, 'update')
    await this.ownedScope(client, row)
  }
  private async scanOwner(client: PoolClient, row: Hint): Promise<boolean> {
    const accounts = await lockAccountAuthorities(client, [row.userId], 'update')
    const account = accounts[0]
    if (!account) corrupt()
    if (!account.enabled || account.deletedAt !== null) return false
    await this.ownedScope(client, row)
    return true
  }
  private async ownedScope(client: PoolClient, row: Hint): Promise<void> {
    const owned = await client.query('SELECT id FROM pe_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.sessionId, row.userId])
    if (owned.rowCount !== 1) refuse('native_intent_scope')
    const operation = await client.query(`SELECT 1 FROM pe_operations o JOIN pe_attempts a ON a.operation_id=o.id
      WHERE o.id=$1 AND o.session_id=$2 AND a.epoch=$3 AND a.worker_id=$4`,
    [row.operationId, row.sessionId, row.operationEpoch, row.workerId])
    if (operation.rowCount !== 1) corrupt()
  }
  private authenticate(row: Row, operationToken: string, workerId: string): void {
    if (row.operationDigest !== digest(operationToken) || row.workerId !== workerId) refuse('native_intent_scope')
  }
  private original(row: Row): z.infer<typeof sealedRequest> {
    if (!row.sealed || row.requestBytes !== row.sealed.length) corrupt()
    const parsed = sealedRequest.safeParse(this.cipher.open(aad(row), row.sealed))
    if (!parsed.success) corrupt()
    this.bytes(parsed.data)
    if (this.cipher.identity('request', parsed.data) !== row.intentId || parsed.data.prepare.workerId !== row.workerId
      || parsed.data.prepare.mutation.family !== row.family || digest(parsed.data.operationToken) !== row.operationDigest) corrupt()
    return parsed.data
  }
  private receipt(row: Row): NativeRetainedReceipt {
    const parsed = nativeRetainedReceipt.safeParse(row.receipt)
    if (row.state !== 'committed' || !parsed.success || parsed.data.family !== row.family
      || nativeInputRecordDigest(row.receipt) !== nativeInputRecordDigest(parsed.data)) corrupt()
    this.bytes(parsed.data)
    return parsed.data
  }
  private async acknowledge(client: PoolClient, row: Row, result: NativeRetainedReceipt): Promise<void> {
    const receipt = nativeRetainedReceipt.parse(result)
    if (receipt.family !== row.family) corrupt()
    this.bytes(receipt)
    const budget = await client.query<{ retained: number; acknowledgement: number }>(`SELECT
      coalesce(sum(coalesce(octet_length(request_sealed),0)+coalesce(octet_length(receipt_json::text),0)),0)::double precision AS retained,
      octet_length($2::jsonb::text) AS acknowledgement FROM pe_native_retained_intents WHERE session_id=$1`,
    [row.sessionId, JSON.stringify(receipt)])
    const total = budget.rows[0]
    if (!total || total.acknowledgement > this.limits.maxRequestBytes
      || total.retained + total.acknowledgement > this.limits.maxRetainedBytesPerSession) {
      throw new PlatformError(413, 'native_intent_retention_budget')
    }
    const saved = await client.query(`UPDATE pe_native_retained_intents SET state='committed',receipt_json=$2,
      updated_at=clock_timestamp() WHERE intent_id=$1 AND state='prepared' AND receipt_json IS NULL`,
    [row.intentId, JSON.stringify(receipt)])
    if (saved.rowCount !== 1) corrupt()
  }
  private async capacity(client: PoolClient, id: string, bytes: number): Promise<void> {
    const totals = await client.query<{ records: number; pending: number; bytes: number }>(`SELECT count(*)::integer AS records,
      count(*) FILTER(WHERE state='prepared')::integer AS pending,
      coalesce(sum(coalesce(octet_length(request_sealed),0)+coalesce(octet_length(receipt_json::text),0)),0)::double precision AS bytes
      FROM pe_native_retained_intents WHERE session_id=$1`, [id])
    const total = totals.rows[0]
    if (!total) corrupt()
    if (total.pending >= this.limits.maxPendingPerSession || total.records >= this.limits.maxRecordsPerSession
      || total.bytes + bytes > this.limits.maxRetainedBytesPerSession) throw new PlatformError(413, 'native_intent_retention_budget')
  }
  private async operationNonrevivable(client: PoolClient, row: Row): Promise<boolean> {
    const actual = await client.query<Record<string, unknown>>(`SELECT s.lease_epoch AS epoch,s.grant_digest AS digest,
      s.lease_until>clock_timestamp() AS clock,o.state,a.worker_id AS worker,a.ended_at IS NULL AS attempt
      FROM pe_sessions s JOIN pe_operations o ON o.id=$2 AND o.session_id=s.id
      JOIN pe_attempts a ON a.operation_id=o.id AND a.epoch=$3 WHERE s.id=$1 AND s.user_id=$4`,
    [row.sessionId, row.operationId, row.operationEpoch, row.userId])
    const parsed = z.object({ epoch: positive, digest: nativeRetainedIntentId.nullable(), clock: z.boolean().nullable(),
      state: z.enum(['queued', 'running', 'completed', 'failed']), worker: nativeWriterWorkerId, attempt: z.boolean() }).strict()
      .safeParse(actual.rows[0])
    if (actual.rowCount !== 1 || !parsed.success || parsed.data.worker !== row.workerId
      || parsed.data.epoch < row.operationEpoch) corrupt()
    const operation = parsed.data
    const ended = operation.state === 'completed' || operation.state === 'failed' || !operation.attempt
    const replaced = operation.epoch > row.operationEpoch
    const expired = operation.epoch === row.operationEpoch && operation.digest === row.operationDigest && operation.clock === false
    const cleared = ended && operation.digest === null && operation.clock === null
    if (!ended && !replaced && !expired && (operation.digest !== row.operationDigest || operation.clock === null)) corrupt()
    // Task renew requires its old live clock and every new claim strictly increments S epoch.
    return ended || replaced || expired || cleared
  }
  private async retired(client: PoolClient, row: Row): Promise<boolean> {
    if (!await this.operationNonrevivable(client, row)) return false
    return !(await client.query(`SELECT session_id FROM pe_native_writers
      WHERE session_id=$1 AND expires_at>clock_timestamp()`, [row.sessionId])).rowCount
  }
  private async nonrevivable(client: PoolClient, row: Row): Promise<boolean> {
    const operationLost = await this.operationNonrevivable(client, row)
    if (row.fenceKind === 'operation') {
      if (row.family !== 'publication' || row.writerEpoch !== null || row.writerDigest !== null) corrupt()
      return operationLost
    }
    if (row.family === 'publication' || row.writerEpoch === null || row.writerDigest === null) corrupt()
    const writers = await client.query<Record<string, unknown>>(`SELECT epoch::double precision AS epoch,worker_id AS worker,
      token_digest AS digest,expires_at>clock_timestamp() AS clock FROM pe_native_writers WHERE session_id=$1 FOR UPDATE`, [row.sessionId])
    const writer = z.object({ epoch: nativeWriterEpoch, worker: nativeWriterWorkerId, digest: nativeRetainedIntentId,
      clock: z.boolean().nullable() }).strict().safeParse(writers.rows[0])
    if (writers.rowCount !== 1 || !writer.success || writer.data.epoch < row.writerEpoch) corrupt()
    if (writer.data.epoch === row.writerEpoch
      && (writer.data.worker !== row.workerId || writer.data.digest !== row.writerDigest)) corrupt()
    // Release preserves the old identity; acquire rejects its token and a replacement strictly increases W epoch.
    const writerLost = writer.data.epoch > row.writerEpoch || writer.data.clock === false || writer.data.clock === null
    return operationLost || writerLost
  }
  private async materialized(client: PoolClient, row: Row): Promise<boolean> {
    const mutation = this.original(row).prepare.mutation
    switch (mutation.family) {
      case 'publication': {
        const batch = mutation.request
        const events = batch.items.flatMap(item => item.type === 'event' ? [item.event] : [])
        if (events.length) {
          const canonical = await client.query<{ event: unknown }>(`SELECT event FROM pe_events
            WHERE session_id=$1 AND seq=ANY($2::integer[]) ORDER BY seq`, [row.sessionId, events.map(event => event.seq)])
          if (canonical.rowCount === events.length
            && nativeInputRecordDigest(canonical.rows.map(record => record.event)) === nativeInputRecordDigest(events)) return true
        }
        return !!(await client.query(`SELECT 1 FROM pe_native_presentations WHERE session_id=$1
          AND epoch=$2 AND publisher_id=$3 AND last_batch_id=$4`, [row.sessionId, batch.epoch, batch.publisherId, batch.batchId])).rowCount
      }
      case 'step':
        return !!(await client.query(`SELECT 1 FROM pe_native_input_cohorts WHERE session_id=$1
          AND cohort_id=$2 AND step_start_seq IS NOT NULL`, [row.sessionId, mutation.request.command.cohortId])).rowCount
      case 'turn-transition':
        return !!(await client.query(`SELECT 1 FROM pe_native_turn_transitions_v2 WHERE session_id=$1
          AND writer_epoch=$2 AND transition_id=$3`, [row.sessionId, mutation.request.from.frame.writerEpoch,
          mutation.request.transitionId])).rowCount
      case 'admission': case 'claim': case 'prepared-cancel': case 'archive-cancel':
        return !!(await client.query(`SELECT 1 FROM pe_native_input_commands WHERE session_id=$1 AND actor_kind='writer'
          AND actor_id=$2 AND writer_epoch=$3 AND transport_nonce=$4`, [row.sessionId, row.workerId,
          row.writerEpoch, mutation.request.command.rpcNonce])).rowCount
      case 'queue':
        return !!(await client.query(`SELECT 1 FROM pe_native_input_commands WHERE session_id=$1 AND actor_kind='browser'
          AND actor_id=$2 AND transport_nonce=$3`, [row.sessionId, row.userId, mutation.request.request.command.rpcNonce])).rowCount
    }
    return assertNever(mutation)
  }

  private writer(mutation: NativeRetainedMutation): NativeWriterIdentity | undefined {
    switch (mutation.family) {
      case 'publication': return undefined
      case 'queue': return mutation.request.request.writer
      case 'admission': case 'claim': case 'step': case 'prepared-cancel': case 'archive-cancel': case 'turn-transition':
        return mutation.request.writer
    }
    return assertNever(mutation)
  }
  private events(mutation: NativeRetainedMutation) {
    switch (mutation.family) {
      case 'publication': return mutation.request.items.flatMap(item => item.type === 'event' ? [item.event] : [])
      case 'queue': return mutation.request.request.events
      case 'admission': case 'claim': case 'prepared-cancel': case 'archive-cancel': return mutation.request.events
      case 'step': case 'turn-transition': return []
    }
    return assertNever(mutation)
  }
  private logical(mutation: NativeRetainedMutation): unknown {
    switch (mutation.family) {
      case 'publication': return { epoch: mutation.request.epoch, publisherId: mutation.request.publisherId,
        batchId: mutation.request.batchId }
      case 'queue': return { nonce: mutation.request.request.command.rpcNonce }
      case 'admission': case 'claim': case 'prepared-cancel': case 'archive-cancel':
        return { writerEpoch: mutation.request.writer.epoch, nonce: mutation.request.command.rpcNonce }
      case 'step': return mutation.request.command
      case 'turn-transition': return { writerEpoch: mutation.request.from.frame.writerEpoch, transitionId: mutation.request.transitionId }
    }
    return assertNever(mutation)
  }
  private validate(mutation: NativeRetainedMutation, header?: unknown): void {
    switch (mutation.family) {
      case 'publication': this.services.publication.validateRetainedRequest(mutation.request); return
      case 'step': this.services.input.validateRetainedRequest(mutation.family, mutation.request, header); return
      case 'turn-transition': this.services.turn.validateRetainedRequest(mutation.request); return
      case 'queue': this.services.input.validateRetainedRequest(mutation.family, mutation.request.request, header); break
      case 'admission': case 'claim': this.services.input.validateRetainedRequest(mutation.family, mutation.request, header); break
      case 'prepared-cancel': this.services.preparedCancel.validateRetainedRequest(mutation.request, header); break
      case 'archive-cancel': this.services.archiveCancel.validateRetainedRequest(mutation.request, header); break
      default: return assertNever(mutation)
    }
    const request = mutation.family === 'queue' ? mutation.request.request : mutation.request
    this.services.publication.validateRetainedRequest({ version: 1, ...request.presentation,
      items: request.events.map(event => ({ type: 'event', event })) })
  }
  private async dispatch(client: PoolClient, original: z.infer<typeof sealedRequest>,
    acknowledge: (receipt: NativeRetainedReceipt) => Promise<void>): Promise<NativeRetainedExecutionResult> {
    const mutation = original.prepare.mutation, token = original.operationToken
    switch (mutation.family) {
      case 'publication': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.publication.apply(token, mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'publication', result }) }) })
      case 'admission': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.input.commitAccepted(token, mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'admission', result }) }) })
      case 'claim': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.input.commitClaim(token, mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'claim', result }) }) })
      case 'queue': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.input.commitQueue(mutation.request.credential, token, mutation.request.request,
          { client, acknowledge: result => acknowledge({ family: 'queue', result }) }) })
      case 'step': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.input.bindStep(token, mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'step', result }) }) })
      case 'prepared-cancel': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.preparedCancel.commit(token, mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'prepared-cancel', result }) }) })
      case 'archive-cancel': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.archiveCancel.commit(token, mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'archive-cancel', result }) }) })
      case 'turn-transition': return nativeRetainedExecutionResult.parse({ family: mutation.family,
        result: await this.services.turn.transition(mutation.request,
          { client, acknowledge: result => acknowledge({ family: 'turn-transition', result }) }) })
    }
    return assertNever(mutation)
  }
}
