/** Exact prebound terminal evidence and the original SDK control budgets. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { AllocationCreateIntent, AllocationScope } from '../src/allocation-types.ts'
import type { SdkLifecycleConfig } from '../src/lifecycle-types.ts'
import { readSdkTerminalReceipt } from '../src/sdk-terminal-receipt.ts'
import { BoundedLifecycleConnection } from '../src/sdk-transport.ts'

const config: SdkLifecycleConfig = {
  lifecycleBaseUrl: 'https://selected.example.invalid/v1', apiKey: 'fixture-private-control-key',
  deploymentIdentity: 'fixture', environmentVersion: 'image-1', provider: 'opensandbox',
  imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64), entrypoint: ['/fixture'],
  platform: 'arm64', cpuCores: 1, memoryMiB: 128, ttlSeconds: 120, requestTimeoutMs: 1000,
  stopBudgetMs: 2000, readyPollIntervalMs: 10, maxReadyPolls: 2, pageSize: 1, maxPages: 2, maxItems: 2,
  maxRecords: 4, maxInflightOperations: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxOperationBytes: 8192,
  maxFieldBytes: 256,
}
const scope: AllocationScope = {
  allocationId: 'allocation-1' as AllocationScope['allocationId'], accountId: 'account-1' as AllocationScope['accountId'],
  epoch: '1' as AllocationScope['epoch'], sessionId: 'session-1' as AllocationScope['sessionId'],
  workspaceId: 'workspace-1' as AllocationScope['workspaceId'],
}
const intent: AllocationCreateIntent = {
  ...scope, environmentVersion: 'image-1', provider: 'opensandbox', projectMountVersion: 'mount-1',
  requestedAt: '2026-11-18T00:00:00.000Z', createDeadlineAt: '2026-11-18T00:01:00.000Z',
}
const bound = {
  sandboxId: '0a000000-0000-4000-8000-000000000001', containerId: 'a'.repeat(64),
  providerGeneration: 'b'.repeat(64), policyDigest: 'c'.repeat(64),
}
const receipt = { ...scope, ...bound, receiptDigest: 'd'.repeat(64) }

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(receipt))
  const connection = new BoundedLifecycleConnection(config, { fetch, async close() {} })
  const assertCurrent = vi.fn()
  const selected = { intent, binding: { ...scope, ...bound }, budget: { deadlineAtMs: Date.now() + 2000, bytes: 0 }, assertCurrent }
  return { fetch, connection, selected, assertCurrent }
}

it('reads only the selected original via the fixed control route and verifies exact terminal fields', async () => {
  const f = fixture()
  await expect(readSdkTerminalReceipt(f.connection, config, f.selected)).resolves.toEqual(receipt)
  const request = f.fetch.mock.calls[0]?.[0]
  if (!(request instanceof Request)) throw new TypeError('expected a Request')
  expect(request.url).toBe(`${config.lifecycleBaseUrl}/sandboxes/${bound.sandboxId}/deletion-receipt`)
  expect(request.method).toBe('POST')
  expect(request.headers.get('OPEN-SANDBOX-API-KEY')).toBe(config.apiKey)
  expect(await request.json()).toEqual({
    scope: ['allocation-1', 'account-1', '1', 'session-1', 'workspace-1', intent.environmentVersion, intent.provider,
      intent.projectMountVersion, intent.requestedAt, intent.createDeadlineAt],
    expected: bound,
  })
  expect(f.assertCurrent).toHaveBeenCalledTimes(2)
  await f.connection.closeTransport()
})

it('keeps a missing protected binding or mismatched Root scope closed before HTTP', async () => {
  const f = fixture()
  await expect(readSdkTerminalReceipt(f.connection, config, undefined)).rejects.toMatchObject({ code: 'sdk/stop-unknown' })
  await expect(readSdkTerminalReceipt(f.connection, config, {
    ...f.selected, binding: { ...f.selected.binding, epoch: '2' as AllocationScope['epoch'] },
  })).rejects.toMatchObject({ code: 'sdk/selection' })
  expect(f.fetch).not.toHaveBeenCalled()
  await f.connection.closeTransport()
})

it('rejects old unsupported paths, absence, malformed evidence and incorrect CID, generation or pinned digest', async () => {
  const f = fixture()
  for (const result of [new Response(null, { status: 204 }), Response.json({ code: 'not-found' }, { status: 404 }),
    Response.json({ code: 'receipt-unconfirmed' }, { status: 409 }), Response.json({ completed: true }),
    Response.json({ ...receipt, containerId: 'e'.repeat(64) }), Response.json({ ...receipt, providerGeneration: 'f'.repeat(64) }),
    Response.json({ ...receipt, receiptDigest: 'e'.repeat(64) })]) {
    f.fetch.mockResolvedValueOnce(result)
    await expect(readSdkTerminalReceipt(f.connection, config, { ...f.selected, receiptDigest: receipt.receiptDigest }))
      .rejects.toBeInstanceOf(Error)
  }
  await expect(readSdkTerminalReceipt(f.connection, config, { ...f.selected, receiptDigest: receipt.receiptDigest }))
    .resolves.toEqual(receipt)
  await f.connection.closeTransport()
})

const wheel = process.env['DSH_S08_ACK_SERVER_WHEEL']
it.runIf(wheel !== undefined)('reads a real persisted terminal response before sending and replaying the ACK', () => {
  const script = fileURLToPath(new URL('./fixtures/sdk-terminal-receipt-loopback.py', import.meta.url))
  execFileSync('python3', ['-I', '-B', script, '--wheel', wheel ?? '', '--node', process.execPath], { timeout: 20000, stdio: 'pipe' })
}, 25000)
