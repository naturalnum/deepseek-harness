/** The exact lifecycle selection, byte limits and actual close remain in force for ACK. */
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { AllocationDeletionReceipt } from '../src/allocation-receipt-outbox.ts'
import type { AllocationCreateIntent, AllocationScope } from '../src/allocation-types.ts'
import type { SdkLifecycleConfig } from '../src/lifecycle-types.ts'
import { createSdkReceiptTransport, type SdkReceiptOperationOwner } from '../src/sdk-receipt-transport.ts'
import { BoundedLifecycleConnection } from '../src/sdk-transport.ts'

const config: SdkLifecycleConfig = {
  lifecycleBaseUrl: 'https://selected.example.invalid/v1', apiKey: 'synthetic-root-key',
  deploymentIdentity: 'fixture-selected-generation', environmentVersion: 'image-1', provider: 'opensandbox',
  imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64), entrypoint: ['/fixture'],
  platform: 'arm64', cpuCores: 1, memoryMiB: 128, ttlSeconds: 120, requestTimeoutMs: 1000,
  stopBudgetMs: 2000, readyPollIntervalMs: 10, maxReadyPolls: 2, pageSize: 1, maxPages: 2, maxItems: 2,
  maxRecords: 4, maxInflightOperations: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxOperationBytes: 8192,
  maxFieldBytes: 256,
}
const original = {
  allocationId: 'allocation-1' as AllocationScope['allocationId'], accountId: 'account-1' as AllocationScope['accountId'],
  sessionId: 'session-1' as AllocationScope['sessionId'], workspaceId: 'workspace-1' as AllocationScope['workspaceId'],
  epoch: '1' as AllocationScope['epoch'],
}
const receipt: AllocationDeletionReceipt = {
  ...original, sandboxId: '0a000000-0000-4000-8000-000000000001', containerId: 'a'.repeat(64),
  providerGeneration: 'b'.repeat(64), policyDigest: 'c'.repeat(64), receiptDigest: 'd'.repeat(64),
}
const intent: AllocationCreateIntent = {
  ...original, environmentVersion: 'image-1', provider: 'opensandbox', projectMountVersion: 'mount-1',
  requestedAt: '2026-11-18T00:00:00.000Z', createDeadlineAt: '2026-11-18T00:01:00.000Z',
}

function fixture(options: { retained?: AllocationDeletionReceipt; allocated?: AllocationCreateIntent; requestBytes?: number } = {}) {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(receipt))
  const close = vi.fn().mockResolvedValue(undefined)
  const connection = new BoundedLifecycleConnection(config, { fetch: send, close })
  const budget = { deadlineAtMs: Date.now() + config.stopBudgetMs, bytes: 0 }
  const assertCurrent = vi.fn()
  const selected = { intent: options.allocated ?? intent, receipt: options.retained ?? receipt, budget, assertCurrent }
  const owner: SdkReceiptOperationOwner = {
    async withOriginalReceipt(scope, run) {
      expect(scope).toEqual(original)
      return run(selected)
    },
  }
  const ack = createSdkReceiptTransport(connection, { ...config, maxRequestBytes: options.requestBytes ?? config.maxRequestBytes }, owner)
  return { ack, close, connection, send, budget, assertCurrent }
}

it('uses the selected bounded SDK connection for one original-scope POST', async () => {
  const f = fixture()
  await expect(f.ack.acknowledge(receipt)).resolves.toEqual(receipt)
  expect(f.send).toHaveBeenCalledOnce()
  const request = f.send.mock.calls[0]?.[0]
  expect(request).toBeInstanceOf(Request)
  if (!(request instanceof Request)) throw new TypeError('expected a Request')
  expect(request.url).toBe(`${config.lifecycleBaseUrl}/sandboxes/${receipt.sandboxId}/deletion-receipt/ack`)
  expect(request.method).toBe('POST')
  expect(request.headers.get('OPEN-SANDBOX-API-KEY')).toBe(config.apiKey)
  const body = await request.text()
  expect(request.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
  expect(JSON.parse(body)).toEqual({ scope: ['allocation-1', 'account-1', '1', 'session-1', 'workspace-1',
    intent.environmentVersion, intent.provider, intent.projectMountVersion, intent.requestedAt, intent.createDeadlineAt], receipt })
  expect(f.budget.bytes).toBeGreaterThan(0)
  expect(f.assertCurrent).toHaveBeenCalledTimes(2)
  await f.connection.closeTransport()
})

it('refuses bad exact bindings, expired budgets and oversized requests before sending', async () => {
  const changedOwner = fixture({ retained: { ...receipt, providerGeneration: 'e'.repeat(64) } })
  await expect(changedOwner.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/selection' })
  const changedIntent = fixture({ allocated: { ...intent, epoch: '2' as AllocationScope['epoch'] } })
  await expect(changedIntent.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/selection' })
  const small = fixture({ requestBytes: 500 })
  await expect(small.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/bounds' })
  const expired = fixture()
  expired.budget.deadlineAtMs = Date.now()
  await expect(expired.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/closed' })
  for (const f of [changedOwner, changedIntent, small, expired]) {
    expect(f.send).not.toHaveBeenCalled()
    await f.connection.closeTransport()
  }
})

it('keeps 204, ordinary 404, malformed replies and wrong receipts unconfirmed without transport retries', async () => {
  const f = fixture()
  for (const response of [new Response(null, { status: 204 }), Response.json({ code: 'missing' }, { status: 404 }),
    new Response('{"incomplete":', { headers: { 'Content-Type': 'application/json' } }),
    Response.json({ ...receipt, containerId: 'e'.repeat(64) }), Response.json({ ...receipt, extra: 'extra' })]) {
    f.send.mockResolvedValueOnce(response)
    await expect(f.ack.acknowledge(receipt)).rejects.toBeInstanceOf(Error)
  }
  expect(f.send).toHaveBeenCalledTimes(5)
  await f.connection.closeTransport()
})

it('charges ACK bytes to the same finite response and operation budgets', async () => {
  const f = fixture()
  f.budget.bytes = config.maxOperationBytes - 1
  await expect(f.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/bounds' })
  f.budget.bytes = 0
  f.send.mockResolvedValueOnce(new Response('x'.repeat(config.maxResponseBytes + 1),
    { status: 200, headers: { 'Content-Type': 'application/json' } }))
  await expect(f.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/bounds' })
  expect(f.send).toHaveBeenCalledTimes(2)
  await f.connection.closeTransport()
})

it('joins actual ACK wire work when the shared connection closes and rechecks the original selection', async () => {
  const f = fixture()
  const entered = Promise.withResolvers<undefined>(), response = Promise.withResolvers<Response>()
  f.send.mockImplementationOnce(() => {
    entered.resolve(undefined)
    return response.promise
  })
  const actual = f.ack.acknowledge(receipt)
  await entered.promise
  const closed = f.connection.closeTransport()
  await expect(f.ack.acknowledge(receipt)).rejects.toMatchObject({ code: 'sdk/closed' })
  expect(f.close).not.toHaveBeenCalled()
  f.assertCurrent.mockImplementation(() => { throw new Error('original selection retired') })
  response.resolve(Response.json(receipt))
  await expect(actual).rejects.toThrow('original selection retired')
  await closed
  expect(f.close).toHaveBeenCalledOnce()
})

const wheel = process.env['DSH_S08_ACK_SERVER_WHEEL']
it.runIf(wheel !== undefined)('restarts the actual application process after dropping a committed ACK response', () => {
  const script = fileURLToPath(new URL('./fixtures/sdk-receipt-transport-loopback.py', import.meta.url))
  execFileSync('python3', ['-I', '-B', script, '--wheel', wheel ?? '', '--node', process.execPath], { timeout: 20000, stdio: 'pipe' })
}, 25000)
