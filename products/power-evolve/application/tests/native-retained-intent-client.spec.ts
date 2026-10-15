/** Host transport boundaries only; durable PG atomicity and cross-process recovery belong to store integration tests. */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import { expect, test } from 'vitest'
import { NativeRetainedIntentClient } from '../src/host/native-retained-intent-client.ts'
import { nativeRetainedIntentId, NATIVE_RETAINED_ROUTES, nativeRetainedPrepare,
  nativeRetainedExecute, nativeRetainedResolve, nativeRetainedExecutionResult,
  nativeRetainedReconcile, nativeRetainedReconcileScope, type NativeRetainedMutation } from '../src/native-retained-intent-contracts.ts'
import { nativeInputRecordDigest } from '../src/native-input-ledger-records.ts'

function publication(): Extract<NativeRetainedMutation, { family: 'publication' }> {
  return { family: 'publication', request: { version: 1, epoch: 1, publisherId: randomUUID(),
    batchId: randomUUID(), firstOrdinal: 1, items: [] } }
}
function acknowledgement(mutation: Extract<NativeRetainedMutation, { family: 'publication' }>) {
  return { family: 'publication' as const, result: { epoch: mutation.request.epoch,
    publisherId: mutation.request.publisherId, lastOrdinal: 0, eventCount: 0, revision: 0 } }
}

test('dispatch waits for the persisted original prepare ACK and leaves resolution to local synchronization', async () => {
  const workerId = randomUUID(), mutation = publication(), intentId = nativeRetainedIntentId.parse('1'.repeat(64))
  const order: string[] = []
  let acknowledgePrepare: (() => void) | undefined
  const prepared = new Promise<void>((resolve) => { acknowledgePrepare = resolve })
  const client = new NativeRetainedIntentClient(workerId, async (path, token, input) => {
    expect(token).toBe('original-operation-secret')
    order.push(path)
    if (path === NATIVE_RETAINED_ROUTES.prepare) {
      expect(nativeRetainedPrepare.parse(input)).toEqual({ version: 1, workerId, mutation })
      await prepared
      return { version: 1, intentId, family: mutation.family, state: 'prepared' }
    }
    expect(path).toBe(NATIVE_RETAINED_ROUTES.execute)
    expect(nativeRetainedExecute.parse(input)).toEqual({ version: 1, workerId, intentId })
    return acknowledgement(mutation)
  }, async (path, input) => {
    order.push(path)
    const request = nativeRetainedResolve.parse(input)
    expect(request).toEqual({ version: 1, workerId, intentId,
      receiptDigest: nativeInputRecordDigest(acknowledgement(mutation)) })
    return { version: 1, intentId, receiptDigest: request.receiptDigest, resolved: true }
  })
  const committing = client.commit('original-operation-secret', mutation)
  expect(order).toEqual([NATIVE_RETAINED_ROUTES.prepare])
  if (!acknowledgePrepare) throw new Error('Prepare acknowledgement was not initialized')
  acknowledgePrepare()
  const dispatch = await committing
  expect(dispatch).toEqual({ intentId, result: acknowledgement(mutation), receipt: acknowledgement(mutation) })
  expect(order).toEqual([NATIVE_RETAINED_ROUTES.prepare, NATIVE_RETAINED_ROUTES.execute])
  await client.resolve(dispatch.intentId, dispatch.receipt)
  expect(order).toEqual([NATIVE_RETAINED_ROUTES.prepare, NATIVE_RETAINED_ROUTES.execute, NATIVE_RETAINED_ROUTES.resolve])
})

test('a lost prepare reply sends no mutation and an explicit retry preserves the entire original request', async () => {
  const workerId = randomUUID(), mutation = publication(), bodies: unknown[] = [], paths: string[] = []
  const intentId = nativeRetainedIntentId.parse('2'.repeat(64))
  let lost = true
  const client = new NativeRetainedIntentClient(workerId, async (path, _token, input) => {
    paths.push(path)
    if (path === NATIVE_RETAINED_ROUTES.prepare) {
      bodies.push(structuredClone(input))
      if (lost) { lost = false; throw new Error('Controlled prepare reply loss') }
      return { version: 1, intentId, family: mutation.family, state: 'prepared' }
    }
    return acknowledgement(mutation)
  }, async () => { throw new Error('Resolution must be explicit') })
  await expect(client.commit('original-operation-secret', mutation)).rejects.toThrow('Controlled prepare reply loss')
  expect(paths).toEqual([NATIVE_RETAINED_ROUTES.prepare])
  await client.commit('original-operation-secret', mutation)
  expect(bodies).toEqual([{ version: 1, workerId, mutation }, { version: 1, workerId, mutation }])
  expect(paths).toEqual([NATIVE_RETAINED_ROUTES.prepare, NATIVE_RETAINED_ROUTES.prepare, NATIVE_RETAINED_ROUTES.execute])
})

test('an abandoned or mismatched prepare cannot dispatch the original native mutation', async () => {
  const mutation = publication(), intentId = nativeRetainedIntentId.parse('3'.repeat(64))
  for (const response of [
    { version: 1, intentId, family: 'publication', state: 'abandoned' },
    { version: 1, intentId, family: 'claim', state: 'prepared' },
  ]) {
    const paths: string[] = []
    const client = new NativeRetainedIntentClient(randomUUID(), async (path) => {
      paths.push(path)
      return response
    }, async () => { throw new Error('No resolution before a validated commit') })
    await expect(client.commit('original-operation-secret', mutation)).rejects.toThrow()
    expect(paths).toEqual([NATIVE_RETAINED_ROUTES.prepare])
  }
})

test('cold reconciliation and resolution reject unbounded or substituted acknowledgements', async () => {
  const workerId = randomUUID(), intentId = nativeRetainedIntentId.parse('4'.repeat(64)), mutation = publication()
  const item = { intentId, userId: randomUUID(), sessionId: randomUUID(), operationId: randomUUID(),
    operationEpoch: 1, workerId, outcome: { state: 'abandoned' } }
  let reply: unknown = { version: 1, items: [item, item], more: false }
  const client = new NativeRetainedIntentClient(workerId, async () => {
    throw new Error('Cold reconciliation cannot issue a mutation')
  }, async (path) => {
    if (path === NATIVE_RETAINED_ROUTES.resolve) {
      return { version: 1, intentId, receiptDigest: '5'.repeat(64), resolved: true }
    }
    return reply
  })
  await expect(client.reconcile(1)).rejects.toThrow('native_retained_reconciliation_receipt')
  await expect(client.reconcile(2)).rejects.toThrow('native_retained_reconciliation_receipt')
  reply = { version: 1, items: [], more: true }
  await expect(client.reconcile(1)).rejects.toThrow('native_retained_reconciliation_receipt')
  reply = { version: 1, items: [item], more: false }
  expect(await client.reconcile(1)).toEqual(reply)
  await expect(client.resolve(intentId, acknowledgement(mutation)))
    .rejects.toThrow('native_retained_resolution_receipt')
})

test('cleanup reconciliation carries one complete original scope and rejects another attempt in its reply', async () => {
  const workerId = randomUUID(), scope = nativeRetainedReconcileScope.parse({ sessionId: randomUUID(),
    operationId: randomUUID(), operationEpoch: 7 })
  const item = { intentId: 'a'.repeat(64), userId: randomUUID(), ...scope, workerId,
    outcome: { state: 'abandoned' } }
  let reply: unknown = { version: 1, items: [item], more: false }
  const client = new NativeRetainedIntentClient(workerId, async () => { throw new Error('Cleanup cannot dispatch') },
    async (path, input) => {
      expect(path).toBe(NATIVE_RETAINED_ROUTES.reconcile)
      expect(nativeRetainedReconcile.parse(input)).toEqual({ version: 1, workerId, limit: 32, scope })
      return reply
    })
  expect(await client.reconcile(32, undefined, scope)).toEqual(reply)
  for (const changed of [{ sessionId: randomUUID() }, { operationId: randomUUID() },
    { operationEpoch: 8 }, { workerId: randomUUID() }]) {
    reply = { version: 1, items: [{ ...item, ...changed }], more: false }
    await expect(client.reconcile(32, undefined, scope)).rejects.toThrow('native_retained_reconciliation_receipt')
  }
})

test('a valid HTTP execution reply of another family refuses acknowledgement and an unchanged retry keeps the original intent', async () => {
  const workerId = randomUUID(), mutation = publication(), intentId = nativeRetainedIntentId.parse('6'.repeat(64))
  const operationToken = randomBytes(32).toString('base64url')
  const wrongFamily = nativeRetainedExecutionResult.parse({ family: 'claim', result: { version: 1, kind: 'claim',
    input: { version: 1, commandId: randomUUID(), sessionId: randomUUID(),
      actor: { kind: 'writer', userId: randomUUID(), workerId, writerEpoch: 1 }, rpcNonce: randomUUID(),
      payloadDigest: '7'.repeat(64), kind: 'claim', eventCount: 0, committedSpliceSeqs: [],
      result: { kind: 'claimed', cohortId: randomUUID() } }, presentation: acknowledgement(mutation).result } })
  const requests: { path: string; token: string; input: unknown }[] = [], pending = new Set<Promise<void>>()
  let substitute = true, maintenanceCalls = 0
  // This carrier scripts wire replies only; it does not stand in for Platform authorization or PG commits.
  const server = createServer((request, response) => {
    const work = (async () => {
      try {
        const path = request.url ?? '', token = bearer(request), input = await readJson(request, 4096)
        requests.push({ path, token, input })
        if (path === NATIVE_RETAINED_ROUTES.prepare) {
          sendJson(response, { version: 1, intentId, family: mutation.family, state: 'prepared' })
        } else if (path === NATIVE_RETAINED_ROUTES.execute) {
          sendJson(response, substitute ? wrongFamily : acknowledgement(mutation))
        } else throw new Error('Unexpected retained HTTP route')
      } catch (error: unknown) { sendFailure(response, error) }
    })()
    pending.add(work)
    void work.finally(() => { pending.delete(work) })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned retained HTTP carrier')
    const client = new NativeRetainedIntentClient(workerId, async (path, token, input, signal) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }) })
      return response.json()
    }, async () => { maintenanceCalls++; throw new Error('No resolution before consumer acknowledgement') })
    await expect(client.commit(operationToken, mutation))
      .rejects.toMatchObject({ status: 502, code: 'native_retained_execution_receipt' })
    expect(requests.map(request => request.path)).toEqual([NATIVE_RETAINED_ROUTES.prepare, NATIVE_RETAINED_ROUTES.execute])
    expect(maintenanceCalls).toBe(0)
    substitute = false
    expect(await client.commit(operationToken, mutation))
      .toEqual({ intentId, result: acknowledgement(mutation), receipt: acknowledgement(mutation) })
    expect(requests).toEqual([
      { path: NATIVE_RETAINED_ROUTES.prepare, token: operationToken, input: { version: 1, workerId, mutation } },
      { path: NATIVE_RETAINED_ROUTES.execute, token: operationToken, input: { version: 1, workerId, intentId } },
      { path: NATIVE_RETAINED_ROUTES.prepare, token: operationToken, input: { version: 1, workerId, mutation } },
      { path: NATIVE_RETAINED_ROUTES.execute, token: operationToken, input: { version: 1, workerId, intentId } },
    ])
    expect(maintenanceCalls).toBe(0)
  } finally {
    await Promise.all(pending)
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
      server.closeIdleConnections()
    })
  }
})
