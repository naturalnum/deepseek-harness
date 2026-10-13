/** Actual provider construction and complete PG fact inventory for retained intent tests. */
import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { TaskStore } from '../src/platform/tasks.ts'
import type { NativeSessionWriter } from '../src/platform/native-session-writer.ts'
import type { NativeAssistantStore } from '../src/platform/native-assistant-store.ts'
import type { NativeInputLedger } from '../src/platform/native-input-ledger.ts'
import type { NativeExecutionFrames } from '../src/platform/native-execution-frames.ts'
import type { NativeInputCommit, NativeInputCommitConfig } from '../src/platform/native-input-commit.ts'
import type { NativeTurnContinuationV2 } from '../src/platform/native-turn-continuation-v2.ts'
import { NativePreparedCancel } from '../src/platform/native-prepared-cancel.ts'
import { NativeArchiveInputCancel } from '../src/platform/native-archive-input.ts'
import { NativeRetainedIntentStore } from '../src/platform/native-retained-intent-store.ts'

/** Build real purpose-specific providers while retaining one dedicated key across store instances.
 * @param native Existing actual fixture providers, never substituted authority or receipt providers.
 * @param config Explicit input and presentation budgets used by this fixture.
 * @param turn Actual continuation service with its original frame verifier.
 * @returns A factory recreating only the journal service over the same private PG records.
 */
export function retainedTestStore(native: {
  tasks: TaskStore
  writers: NativeSessionWriter
  publisher: NativeAssistantStore
  ledger: NativeInputLedger
  frames: NativeExecutionFrames
  bridge: NativeInputCommit
}, config: NativeInputCommitConfig, turn: NativeTurnContinuationV2): () => NativeRetainedIntentStore {
  const key = randomBytes(32).toString('base64url')
  const preparedCancel = new NativePreparedCancel(native.tasks, native.ledger, native.frames, native.publisher, native.writers, config)
  const archiveCancel = new NativeArchiveInputCancel(native.tasks, native.ledger, native.frames, native.publisher, native.writers, config)
  return () => new NativeRetainedIntentStore(native.tasks, native.writers, { publication: native.publisher, input: native.bridge,
    preparedCancel, archiveCancel, turn }, key, { maxRequestBytes: 8_388_608, maxPendingPerSession: 16,
    maxRecordsPerSession: 32, maxRetainedBytesPerSession: 33_554_432 })
}

/** Read full actual rows for every native mutation surface relevant to the atomic acknowledgement.
 * @param pool Isolated fixture database owner; no SQL or credentials leave the process.
 * @returns Exact typed row inventory for zero-write and rollback comparisons.
 */
export async function retainedNativeFacts(pool: Pool): Promise<Record<string, Array<Record<string, unknown>>>> {
  const tables = ['pe_sessions', 'pe_operations', 'pe_attempts', 'pe_events', 'pe_native_writers',
    'pe_native_presentations', 'pe_native_presentation_entries', 'pe_native_turn_frames',
    'pe_native_input_origins', 'pe_native_input_commands', 'pe_native_input_cohorts', 'pe_native_input_claims',
    'pe_native_input_revisions', 'pe_native_turn_transitions_v2', 'pe_native_preferences'] as const
  const result: Record<string, Array<Record<string, unknown>>> = {}
  for (const table of tables) result[table] = (await pool.query<Record<string, unknown>>(
    `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows
  return result
}
