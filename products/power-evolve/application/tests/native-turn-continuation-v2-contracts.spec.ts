/** Strict v2 intents and tokenless receipts retain complete origins independently of step entry. */
import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { nativeTurnReceiptV2, nativeTurnTransitionV2 } from '../src/native-turn-continuation-v2-contracts.ts'

function fixture() {
  const sessionId = randomUUID(), operationId = randomUUID(), originInputId = randomUUID()
  const token = () => randomBytes(32).toString('base64url')
  const request = nativeTurnTransitionV2.parse({ version: 2, kind: 'advance', transitionId: randomUUID(), candidateToken: token(),
    writer: { sessionId, workerId: randomUUID(), token: token(), epoch: 1 }, expectedEventCount: 4, expectedQueueRevision: 2,
    expectedNext: null, from: { frame: { sessionId, operationId, operationEpoch: 1, writerEpoch: 1,
      frozenSnapshotDigest: 'a'.repeat(64) }, operationToken: token(), turn: 1, turnStartSeq: 1, turnEndSeq: 3,
    cohortIds: [randomUUID()], claimedOriginInputIds: [originInputId] },
    seal: { publisherId: randomUUID(), lastOrdinal: 4, revision: 0, eventCount: 4 } })
  const { operationToken: _bearer, ...from } = request.from
  const receipt = nativeTurnReceiptV2.parse({ version: 2, sessionId, writerEpoch: 1, transitionId: request.transitionId,
    eventCount: 4, queueRevision: 2, from, settled: [{ originInputId, operationId, outcome: 'failed', errorCode: 'turn_blocked' }],
    result: { kind: 'parked', reason: 'empty' } })
  return { request, receipt }
}

test('a v1 single-input source and extra authority fields cannot enter the v2 DTO', () => {
  const { request } = fixture()
  expect(nativeTurnTransitionV2.safeParse({ ...request, version: 1 }).success).toBe(false)
  expect(nativeTurnTransitionV2.safeParse({ ...request, kind: 'park' }).success).toBe(false)
  expect(nativeTurnTransitionV2.safeParse({ ...request, grant: {} }).success).toBe(false)
  expect(nativeTurnTransitionV2.safeParse({ ...request, from: { ...request.from, claimedMessageIds: [randomUUID()] } }).success).toBe(false)
})

test('receipt JSON refuses bearer fields and incomplete consumed-origin settlement', () => {
  const { request, receipt } = fixture()
  expect(nativeTurnReceiptV2.safeParse({ ...receipt, candidateToken: request.candidateToken }).success).toBe(false)
  expect(nativeTurnReceiptV2.safeParse({ ...receipt, from: { ...receipt.from,
    operationToken: request.from.operationToken } }).success).toBe(false)
  expect(nativeTurnReceiptV2.safeParse({ ...receipt, settled: [] }).success).toBe(false)
  expect(nativeTurnReceiptV2.safeParse({ ...receipt, from: { ...receipt.from,
    claimedOriginInputIds: [randomUUID()] } }).success).toBe(false)
})
