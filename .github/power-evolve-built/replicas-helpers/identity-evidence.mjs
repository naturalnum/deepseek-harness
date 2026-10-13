/** Compare actual captured requests and PG rows without recording bearer values. */
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

const frameKeys = ['version', 'sessionId', 'operationId', 'operationEpoch', 'writerEpoch',
  'requestId', 'messageId', 'candidateOriginInputId', 'frozenSnapshotDigest', 'preparedEventCount', 'owner']

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function pick(value, keys) {
  if (!object(value)) return undefined
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}

function frameIdentity(value) {
  const result = pick(value, frameKeys)
  if (result && Object.hasOwn(result, 'owner')) result.owner = pick(value.owner, ['originInputId', 'inputRevision',
    'inputDigest', 'cohortId', 'claimSpliceSeq', 'spliceItemOrdinal', 'turnStartSeq', 'turn', 'target'])
  return result
}

/** Return selected non-secret identity fields from the actual wire JSON.
 * @param value Parsed request or response captured at the real transport.
 * @returns Original identities; missing fields remain absent instead of receiving synthetic defaults.
 */
export function retainedIdentity(value) {
  if (!object(value)) return undefined
  return {
    ...pick(value, ['version', 'kind', 'transitionId', 'intentId', 'workerId', 'family', 'state', 'receiptDigest',
      'userId', 'sessionId', 'operationId', 'operationEpoch', 'more',
      'storageOperationEpoch', 'expectedEventCount',
      'expectedQueueRevision']),
    items: Array.isArray(value.items) ? value.items.map(item => ({
      ...pick(item, ['intentId', 'userId', 'sessionId', 'operationId', 'operationEpoch', 'workerId']),
      outcome: object(item.outcome) ? { ...pick(item.outcome, ['state', 'retired']),
        receipt: retainedIdentity(item.outcome.receipt) } : undefined,
    })) : undefined,
    receipt: object(value.receipt) ? retainedIdentity(value.receipt) : undefined,
    result: object(value.result) ? retainedIdentity(value.result) : undefined,
    mutation: object(value.mutation) ? { family: value.mutation.family,
      request: retainedIdentity(value.mutation.request) } : undefined,
    request: object(value.request) ? retainedIdentity(value.request) : undefined,
    command: pick(value.command, ['version', 'rpcNonce']),
    frame: frameIdentity(value.frame),
    eventCount: Array.isArray(value.events) ? value.events.length : undefined,
    expectedNext: value.expectedNext === null ? null : pick(value.expectedNext, ['originInputId', 'operationId',
      'messageId', 'inputRevision', 'inputDigest', 'target']),
    writer: pick(value.writer, ['sessionId', 'workerId', 'epoch']),
    seal: pick(value.seal, ['publisherId', 'lastOrdinal', 'revision', 'eventCount']),
    from: object(value.from) ? {
      ...pick(value.from, ['turn', 'turnStartSeq', 'turnEndSeq', 'cohortIds', 'claimedOriginInputIds']),
      frame: frameIdentity(value.from.frame),
    } : undefined,
  }
}

/** Compare complete private request bytes and parsed JSON, including tokens, in memory only.
 * @param original First actual request Buffer.
 * @param retry Later actual request Buffer for the same observed path.
 * @returns Boolean comparisons and tokenless identities; callers decide which refusal or replay is expected.
 */
export function compareRetainedRequest(original, retry) {
  assert(Buffer.isBuffer(original) && Buffer.isBuffer(retry))
  const first = JSON.parse(original.toString('utf8')), next = JSON.parse(retry.toString('utf8'))
  assert(object(first) && object(next), 'Observed retained requests must be JSON objects')
  const fields = ['version', 'workerId', 'intentId', 'mutation', 'kind', 'transitionId', 'candidateToken', 'writer', 'seal', 'from',
    'storageOperationEpoch', 'expectedEventCount', 'expectedQueueRevision', 'expectedNext']
  return {
    wireBytesEqual: original.equals(retry), jsonEqual: isDeepStrictEqual(first, next),
    fields: Object.fromEntries(fields.filter(key => Object.hasOwn(first, key) || Object.hasOwn(next, key))
      .map(key => [key, isDeepStrictEqual(first[key], next[key])])),
    originalIdentity: retainedIdentity(first), retryIdentity: retainedIdentity(next),
  }
}

/** Compare every original immutable PG row by its declared actual key, allowing unrelated later rows.
 * @param before Rows selected before the fault.
 * @param after Rows selected after recovery.
 * @param keyFields Actual unique-key column names; order is significant.
 * @returns Exact original-row equality, missing keys and observed row counts.
 */
export function compareOriginalRows(before, after, keyFields) {
  assert(Array.isArray(before) && before.length > 0 && Array.isArray(after)
    && Array.isArray(keyFields) && keyFields.length > 0, 'An observed original PG row is required')
  const key = (row) => {
    assert(object(row) && keyFields.every(field => Object.hasOwn(row, field)), 'Actual PG key columns are required')
    return JSON.stringify(keyFields.map(field => row[field]))
  }
  const original = new Map(before.map(row => [key(row), row])), current = new Map(after.map(row => [key(row), row]))
  assert.equal(original.size, before.length, 'Original PG rows must have unique keys')
  assert.equal(current.size, after.length, 'Current PG rows must have unique keys')
  const missingKeys = [], changedKeys = []
  for (const [id, row] of original) {
    if (!current.has(id)) missingKeys.push(id)
    else if (!isDeepStrictEqual(row, current.get(id))) changedKeys.push(id)
  }
  return { beforeCount: before.length, afterCount: after.length,
    missingKeys, changedKeys, originalRowsEqual: missingKeys.length === 0 && changedKeys.length === 0 }
}

/** Compare historical frame identity and permanent owner while settlement phase may change.
 * @param before Original actual frame JSON.
 * @param after Same historical frame read after recovery, never the new storage authority frame.
 * @returns Equality and original non-secret frame identities.
 */
export function compareFrameIdentity(before, after) {
  assert(object(before) && object(after) && frameKeys.slice(0, -1).every(key => Object.hasOwn(before, key)))
  const original = frameIdentity(before), current = frameIdentity(after)
  return { identityEqual: isDeepStrictEqual(original, current), original, current,
    originalPhase: before.phase, currentPhase: after.phase }
}

/** Read only tokenless journal identity, state and sealed-request presence from an actual schema-six database. */
export const retainedJournalSnapshotSql = `SELECT intent_id,mutation_key,family,fence_kind,user_id,session_id,
  operation_id,operation_epoch,operation_digest,worker_id,writer_epoch,writer_digest,prepared_event_count,
  request_bytes,state,receipt_json,created_at,updated_at,resolved_at,
  request_sealed IS NOT NULL AS has_sealed_request
  FROM pe_native_retained_intents WHERE session_id=$1 ORDER BY created_at,intent_id LIMIT $2`

/** Compare the original actual journal identity while commit and sealed-request disposal remain separate facts.
 * @param before Original row from retainedJournalSnapshotSql before the fault.
 * @param after The same intent_id row after independent worker reconciliation.
 * @returns Identity and terminal receipt comparisons, with actual state and cleanup facts.
 */
export function compareJournalIdentity(before, after) {
  const keys = ['intent_id', 'mutation_key', 'family', 'fence_kind', 'user_id', 'session_id', 'operation_id',
    'operation_epoch', 'operation_digest', 'worker_id', 'writer_epoch', 'writer_digest', 'prepared_event_count', 'created_at']
  assert(object(before) && object(after) && keys.every(key => Object.hasOwn(before, key) && Object.hasOwn(after, key)))
  const original = pick(before, keys), current = pick(after, keys)
  const wasCommitted = before.state === 'committed'
  return { identityEqual: isDeepStrictEqual(original, current), original, current,
    originalState: before.state, currentState: after.state,
    terminalReceiptUnchanged: wasCommitted ? isDeepStrictEqual(before.receipt_json, after.receipt_json) : undefined,
    terminalStateUnchanged: before.state === 'committed' || before.state === 'abandoned' ? before.state === after.state : undefined,
    originalHasSealedRequest: before.has_sealed_request, currentHasSealedRequest: after.has_sealed_request,
    originalRequestBytes: before.request_bytes, currentRequestBytes: after.request_bytes,
    sealedCleanupValid: after.has_sealed_request === false
      ? after.state === 'committed' && after.request_bytes === 0 && after.resolved_at !== null
      : after.has_sealed_request === true && after.request_bytes > 0 && after.resolved_at === null }
}
