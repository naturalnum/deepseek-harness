/** Native cold-Session writes share event budgets and transactional projection checkpoints. */
import type { PoolClient } from 'pg'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PlatformError } from '../contracts.ts'
import { headerSchema } from '../session-records.ts'
import { checkpointNativeProjections } from './native-projections.ts'
import type { EventLimits } from './events.ts'

/** Event watermark read while the caller holds the owned Session update lock. */
export interface OwnedAppendState {
  id: string
  header: unknown
  event_count: number
  event_bytes: string
}

/** Append a contiguous native batch under the already acquired account and Session locks.
 * @param client Authorized transaction client; its caller commits.
 * @param userId Verified Session owner.
 * @param row Locked native header and event watermark.
 * @param events Constructed native events beginning at the locked watermark.
 * @param limits Configured event and history budgets.
 * @returns Completion after both log and checkpoint writes; failures roll back with the transaction.
 */
export async function appendOwnedEvents(client: PoolClient, userId: string, row: OwnedAppendState,
  events: readonly SessionEvent[], limits: EventLimits): Promise<void> {
  let count = row.event_count, bytes = Number(row.event_bytes)
  for (const event of events) {
    if (event.seq !== count) throw new PlatformError(503, 'native_event_gap')
    const length = Buffer.byteLength(JSON.stringify(event))
    if (length > limits.maxEventBytes || bytes + length > limits.maxHistoryBytes || count >= limits.maxHistoryEvents) {
      throw new PlatformError(413, 'history_limit')
    }
    await client.query('INSERT INTO pe_events(session_id,seq,event) VALUES($1,$2,$3)', [row.id, count, event])
    count++; bytes += length
  }
  await checkpointNativeProjections(client, userId, headerSchema.parse(row.header), row.event_count, events)
  await client.query('UPDATE pe_sessions SET event_count=$2,event_bytes=$3,updated_at=clock_timestamp() WHERE id=$1', [row.id, count, bytes])
}
