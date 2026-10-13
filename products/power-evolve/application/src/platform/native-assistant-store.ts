/** Temporary ordered presentation and canonical events published in one fenced PostgreSQL transaction. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PlatformError } from '../contracts.ts'
import { createNativeAssistantState, foldNativeAssistantItem, nativeAssistantBytes, parseNativeAssistantBatch,
  readNativeAssistantState, validateNativeAssistantLimits, type NativeAssistantLimits,
  type NativeAssistantState, type NativeAssistantEntry, type NativeAssistantBatch } from '../native-assistant-records.ts'
import { assertNativeRetainedBarrier, nativeRetainedTransaction,
  type NativeRetainedTransaction } from './native-retained-intent-transaction.ts'
import { digest } from './identity.ts'
import type { EventStore } from './events.ts'
import type { TaskStore } from './tasks.ts'

interface PresentationRow {
  epoch: number
  publisher_id: string
  last_ordinal: string
  state_json: string
  last_batch_id: string | null
  last_batch_json: string | null
  expires_at: string
}

/** Commit receipt for the exact ordered batch; the epoch always comes from grant authorization. */
export interface NativeAssistantReceipt {
  readonly publisherId: string
  readonly epoch: number
  readonly lastOrdinal: number
  readonly eventCount: number
  readonly revision: number
}

/** Owns disposable presentation JSON text and event references; EventStore owns native history. */
export class NativeAssistantStore {
  private readonly limits: NativeAssistantLimits

  constructor(private readonly tasks: TaskStore, private readonly events: EventStore, limits: NativeAssistantLimits) {
    this.limits = validateNativeAssistantLimits(limits)
  }

  /** Validate the original publication wire body and deployment budgets before durable preparation.
   * @param input Complete original batch, including its original counters and item order.
   * @returns Strict bounded batch without any native fact or presentation write.
   */
  validateRetainedRequest(input: unknown): NativeAssistantBatch { return parseNativeAssistantBatch(input, this.limits) }

  /** Apply or replay one bounded batch under its original execution grant.
   * @param token Original execution grant captured with the publisher's queued records.
   * @param input Private version-one publication body; a declared epoch never grants authority.
   * @param context Caller-owned retained transaction; its strict ACK precedes the original final clock proof.
   * @returns Receipt only after events, projections, presentation and the final live-grant check commit.
   */
  async apply(token: string, input: unknown, context?: NativeRetainedTransaction<NativeAssistantReceipt>): Promise<NativeAssistantReceipt> {
    const batch = parseNativeAssistantBatch(input, this.limits)
    return nativeRetainedTransaction(this.tasks.pool, context, async (client) => {
      const row = await this.tasks.authorized(client, token)
      await assertNativeRetainedBarrier(client, row.id, context !== undefined)
      if (row.lease_epoch !== batch.epoch) throw new PlatformError(409, 'native_assistant_epoch')
      const existing = (await client.query<PresentationRow>(`SELECT epoch,publisher_id,last_ordinal,state_json,
        last_batch_id,last_batch_json,expires_at::text FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE`, [row.id])).rows[0]
      const continuing = existing !== undefined && existing.epoch === row.lease_epoch
      let state: NativeAssistantState
      if (continuing) {
        if (existing.publisher_id !== batch.publisherId) throw new PlatformError(409, 'native_assistant_publisher')
        await this.requireUnexpired(client, row.id, existing.expires_at)
        state = readNativeAssistantState(existing.state_json, this.limits)
        if (state.epoch !== existing.epoch || state.publisherId !== existing.publisher_id
          || String(state.lastOrdinal) !== existing.last_ordinal || state.cursor !== row.event_count - 1) {
          throw new PlatformError(503, 'native_assistant_state')
        }
        const previous = existing.last_batch_json === null ? undefined : parseNativeAssistantBatch(
          z.json().parse(JSON.parse(existing.last_batch_json)), this.limits)
        if (previous !== undefined && (previous.batchId !== existing.last_batch_id || previous.epoch !== state.epoch
          || previous.publisherId !== state.publisherId || previous.firstOrdinal + previous.items.length - 1 !== state.lastOrdinal)) {
          throw new PlatformError(503, 'native_assistant_receipt')
        }
        if (previous !== undefined && previous.batchId === batch.batchId) {
          if (!isDeepStrictEqual(previous, batch)) throw new PlatformError(409, 'native_assistant_batch_conflict')
          const receipt = this.receipt(state, row.event_count)
          await context?.acknowledge(receipt)
          await this.fence(client, row, token, existing.expires_at)
          return receipt
        }
      } else {
        if (existing !== undefined && existing.epoch > row.lease_epoch) throw new PlatformError(503, 'native_assistant_epoch')
        state = createNativeAssistantState(row.lease_epoch, batch.publisherId, row.event_count - 1)
        if (existing !== undefined) await client.query('DELETE FROM pe_native_presentation_entries WHERE session_id=$1', [row.id])
      }
      if (batch.firstOrdinal !== state.lastOrdinal + 1) throw new PlatformError(409, 'native_assistant_ordinal')
      const entries = []
      for (const item of batch.items) {
        const folded = foldNativeAssistantItem(state, item, state.lastOrdinal + 1, this.limits)
        if (item.type === 'event') await this.events.appendInTransaction(client, row, [item.event])
        state = folded.state
        entries.push(folded.entry)
      }
      await this.save(client, row.id, state, entries, batch)
      const receipt = this.receipt(state, row.event_count)
      await context?.acknowledge(receipt)
      await this.fence(client, row, token, continuing ? existing.expires_at : undefined)
      return receipt
    })
  }

  /** Publish a complete canonical input suffix already staged by the caller's atomic ledger transaction.
   * @param client Caller transaction; canonical history, ledger and presentation share its commit.
   * @param token Exact original operation bearer captured by the current publisher.
   * @param expectedEventCount Native prefix immediately before this complete input batch.
   * @param batch Complete bounded event-only ordered publication, with its retained batch identity.
   * @returns Ordered receipt after validating the actual PG suffix and updating the existing presentation owner.
   */
  async commitInputInTransaction(client: PoolClient, token: string, expectedEventCount: number,
    batch: NativeAssistantBatch): Promise<NativeAssistantReceipt> {
    const bounded = parseNativeAssistantBatch(batch, this.limits)
    const row = await this.tasks.authorized(client, token)
    if (bounded.epoch !== row.lease_epoch
      || row.event_count !== expectedEventCount + bounded.items.length
      || bounded.items.some(item => item.type !== 'event')) throw new PlatformError(409, 'native_assistant_input_prefix')
    const existing = (await client.query<PresentationRow>(`SELECT epoch,publisher_id,last_ordinal,state_json,
      last_batch_id,last_batch_json,expires_at::text FROM pe_native_presentations WHERE session_id=$1 FOR UPDATE`, [row.id])).rows[0]
    if (!existing || existing.epoch !== bounded.epoch || existing.publisher_id !== bounded.publisherId) {
      throw new PlatformError(409, 'native_assistant_publisher')
    }
    await this.requireUnexpired(client, row.id, existing.expires_at)
    let state = readNativeAssistantState(existing.state_json, this.limits)
    if (state.epoch !== existing.epoch || state.publisherId !== existing.publisher_id
      || String(state.lastOrdinal) !== existing.last_ordinal) throw new PlatformError(503, 'native_assistant_state')
    const stored = await client.query<{ event: SessionEvent }>(`SELECT event FROM pe_events
      WHERE session_id=$1 AND seq>=$2 AND seq<$3 ORDER BY seq`, [row.id, expectedEventCount, row.event_count])
    const canonical = bounded.items.flatMap(item => item.type === 'event' ? [item.event] : [])
    if (!isDeepStrictEqual(stored.rows.map(record => record.event), canonical)) {
      throw new PlatformError(409, 'native_assistant_input_suffix')
    }
    if (existing.last_batch_id === bounded.batchId) {
      const previous = existing.last_batch_json === null ? undefined
        : parseNativeAssistantBatch(z.json().parse(JSON.parse(existing.last_batch_json)), this.limits)
      if (!isDeepStrictEqual(previous, bounded)) throw new PlatformError(409, 'native_assistant_batch_conflict')
      if (state.cursor !== row.event_count - 1 || state.lastOrdinal !== bounded.firstOrdinal + bounded.items.length - 1) {
        throw new PlatformError(503, 'native_assistant_receipt')
      }
      await this.fence(client, row, token, existing.expires_at)
      return this.receipt(state, row.event_count)
    }
    if (state.cursor !== expectedEventCount - 1 || bounded.firstOrdinal !== state.lastOrdinal + 1) {
      throw new PlatformError(409, 'native_assistant_input_prefix')
    }
    const entries: NativeAssistantEntry[] = []
    for (const item of bounded.items) {
      const folded = foldNativeAssistantItem(state, item, state.lastOrdinal + 1, this.limits)
      state = folded.state
      entries.push(folded.entry)
    }
    await this.save(client, row.id, state, entries, bounded)
    await this.fence(client, row, token, existing.expires_at)
    return this.receipt(state, row.event_count)
  }

  private async save(client: PoolClient, sessionId: string, state: NativeAssistantState,
    entries: readonly NativeAssistantEntry[], batch: NativeAssistantBatch): Promise<void> {
    await client.query(`INSERT INTO pe_native_presentations
      (session_id,epoch,publisher_id,last_ordinal,state_json,last_batch_id,last_batch_json,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT(session_id) DO UPDATE SET
      epoch=EXCLUDED.epoch,publisher_id=EXCLUDED.publisher_id,last_ordinal=EXCLUDED.last_ordinal,
      state_json=EXCLUDED.state_json,last_batch_id=EXCLUDED.last_batch_id,last_batch_json=EXCLUDED.last_batch_json`,
    [sessionId, state.epoch, state.publisherId, state.lastOrdinal, JSON.stringify(state), batch.batchId, JSON.stringify(batch)])
    for (const entry of entries) {
      await client.query('INSERT INTO pe_native_presentation_entries(session_id,ordinal,item_json,item_bytes) VALUES($1,$2,$3,$4)',
        [sessionId, entry.ordinal, JSON.stringify(entry), nativeAssistantBytes(entry)])
    }
    await client.query(`DELETE FROM pe_native_presentation_entries WHERE session_id=$1 AND ordinal IN (
      SELECT ordinal FROM (SELECT ordinal,row_number() OVER (ORDER BY ordinal DESC) AS position,
        sum(item_bytes) OVER (ORDER BY ordinal DESC) AS bytes FROM pe_native_presentation_entries WHERE session_id=$1) retained
        WHERE position>$2 OR bytes>$3)`, [sessionId, this.limits.maxRingItems, this.limits.maxRingBytes])
  }

  private receipt(state: NativeAssistantState, eventCount: number): NativeAssistantReceipt {
    return { publisherId: state.publisherId, epoch: state.epoch, lastOrdinal: state.lastOrdinal, eventCount, revision: state.revision }
  }

  private async requireUnexpired(client: PoolClient, sessionId: string, expiresAt: string): Promise<void> {
    const live = await client.query('SELECT $2::timestamptz>clock_timestamp() AS live FROM pe_native_presentations WHERE session_id=$1',
      [sessionId, expiresAt])
    if (!z.object({ live: z.literal(true) }).safeParse(live.rows[0]).success) {
      throw new PlatformError(409, 'native_assistant_expired')
    }
  }

  private async fence(client: PoolClient, row: Awaited<ReturnType<TaskStore['authorized']>>,
    token: string, priorExpiry: string | undefined): Promise<void> {
    const result = await client.query(`UPDATE pe_native_presentations p SET
      expires_at=LEAST(s.lease_until,clock_timestamp()+$5::double precision*interval '1 millisecond'),updated_at=clock_timestamp()
      FROM pe_sessions s JOIN pe_operations o ON o.session_id=s.id WHERE p.session_id=s.id AND s.id=$1
      AND s.grant_digest=$2 AND s.lease_epoch=$3 AND o.id=$4 AND o.state='running'
      AND s.lease_until>clock_timestamp() AND ($6::timestamptz IS NULL OR $6::timestamptz>clock_timestamp())`,
    [row.id, digest(token), row.lease_epoch, row.operation_id, this.limits.ttlMs, priorExpiry ?? null])
    if (!result.rowCount) {
      if (priorExpiry !== undefined) await this.requireUnexpired(client, row.id, priorExpiry)
      throw new PlatformError(409, 'lease_lost')
    }
  }
}
