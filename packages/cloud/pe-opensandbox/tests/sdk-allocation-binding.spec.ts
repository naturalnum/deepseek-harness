/** Receipt-aware readiness obtains exact live provider identity before publishing the allocation. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { PostgresAllocationBindingStorage } from '../src/allocation-binding-postgres.ts'
import type { AllocationCreateIntent, AllocationScope, SandboxAllocation } from '../src/allocation-types.ts'
import type { SdkLifecycleConfig } from '../src/lifecycle-types.ts'
import { readSdkAllocationBinding } from '../src/sdk-allocation-binding.ts'
import { BoundedLifecycleConnection } from '../src/sdk-transport.ts'

const scope: AllocationScope = {
  allocationId: 'allocation-1' as AllocationScope['allocationId'], accountId: 'account-1' as AllocationScope['accountId'],
  epoch: '1' as AllocationScope['epoch'], sessionId: 'session-1' as AllocationScope['sessionId'],
  workspaceId: 'workspace-1' as AllocationScope['workspaceId'],
}
const intent: AllocationCreateIntent = {
  ...scope, environmentVersion: 'image-1', provider: 'opensandbox', projectMountVersion: 'mount-1',
  requestedAt: '2026-11-18T00:00:00.000Z', createDeadlineAt: '2026-11-18T00:01:00.000Z',
}
const original = { sandboxId: '0a000000-0000-4000-8000-000000000001',
  providerGeneration: 'a'.repeat(64), policyDigest: 'b'.repeat(64) }
const binding = { ...scope, ...original, containerId: 'c'.repeat(64) }
const prepared = { sandboxId: binding.sandboxId, runtimeIdentity: 'runtime-1', protocolVersion: 'fixture/1',
  capabilities: ['argv-collect', 'control'] as const }
const predecessor: SandboxAllocation = { ...intent, state: 'creating', sandboxId: null,
  lastActivityAt: intent.requestedAt, lastCheckedAt: intent.requestedAt, runtimeIdentity: null,
  executionProtocolVersion: null, executionCapabilities: [], failureCode: null }
const config: SdkLifecycleConfig = {
  lifecycleBaseUrl: 'https://selected.example.invalid/v1', apiKey: 'fixture-control-key',
  deploymentIdentity: 'fixture', environmentVersion: intent.environmentVersion, provider: intent.provider,
  imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64), entrypoint: ['/fixture'],
  platform: 'arm64', cpuCores: 1, memoryMiB: 128, ttlSeconds: 120, requestTimeoutMs: 1000,
  stopBudgetMs: 2000, readyPollIntervalMs: 10, maxReadyPolls: 2, pageSize: 1, maxPages: 2, maxItems: 2,
  maxRecords: 4, maxInflightOperations: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxOperationBytes: 8192,
  maxFieldBytes: 256,
}

it('uses original authenticated creation scope and validates exact live binding before readiness', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(binding))
  const connection = new BoundedLifecycleConnection(config, { fetch, async close() {} })
  const assertCurrent = vi.fn()
  const selection = { intent, ...original, assertCurrent, budget: { deadlineAtMs: Date.now() + 2000, bytes: 0 } }
  await expect(readSdkAllocationBinding(connection, config, undefined)).rejects.toMatchObject({ code: 'sdk/ready-unconfirmed' })
  expect(fetch).not.toHaveBeenCalled()
  await expect(readSdkAllocationBinding(connection, config, selection)).resolves.toEqual(binding)
  const request = fetch.mock.calls[0]?.[0]
  if (!(request instanceof Request)) throw new TypeError('expected an original SDK request')
  expect(request.url).toBe(`${config.lifecycleBaseUrl}/sandboxes/${original.sandboxId}/deletion-receipt/binding`)
  expect(request.headers.get('OPEN-SANDBOX-API-KEY')).toBe(config.apiKey)
  expect(await request.json()).toEqual({ scope: ['allocation-1', 'account-1', '1', 'session-1', 'workspace-1',
    intent.environmentVersion, intent.provider, intent.projectMountVersion, intent.requestedAt, intent.createDeadlineAt],
  providerGeneration: original.providerGeneration, policyDigest: original.policyDigest })
  expect(assertCurrent).toHaveBeenCalledTimes(2)
  for (const response of [Response.json({ ...binding, providerGeneration: 'd'.repeat(64) }),
    Response.json({ ...binding, containerId: 'short-id' }), Response.json({ code: 'not-found' }, { status: 404 })]) {
    fetch.mockResolvedValueOnce(response)
    await expect(readSdkAllocationBinding(connection, config, selection)).rejects.toMatchObject({ code: 'sdk/ready-unconfirmed' })
  }
  await connection.closeTransport()
})

it('reconciles only the exact ready metadata and binding after an unknown commit response', async () => {
  const retained = { state: 'ready', runtimeIdentity: prepared.runtimeIdentity, protocolVersion: prepared.protocolVersion,
    capabilities: prepared.capabilities, binding }
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(new Error('lost write response'))
    .mockResolvedValueOnce({ rows: [{ retained }] })
  const storage = new PostgresAllocationBindingStorage({ query })
  await storage.migrate()
  await expect(storage.commitReady(predecessor, prepared, binding)).resolves.toEqual(retained)
  expect(query).toHaveBeenCalledTimes(3)
  expect(query.mock.calls[1]?.[0]).toContain("a.state='creating'")
  expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO public.pe_sandbox_allocation_bindings_v1')
  expect(query.mock.calls[2]?.[1]).toEqual(['allocation-1', 'account-1', 'session-1', 'workspace-1', '1'])
})

it('cannot publish ready from a stale stopping observation or attach a missing original identity', async () => {
  const retained = { state: 'stopping', runtimeIdentity: prepared.runtimeIdentity,
    protocolVersion: prepared.protocolVersion, capabilities: prepared.capabilities, binding }
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ retained }] })
  const storage = new PostgresAllocationBindingStorage({ query })
  await storage.migrate()
  await expect(storage.commitReady(predecessor, prepared, { ...binding, containerId: '' }))
    .rejects.toMatchObject({ code: 'invalid-evidence' })
  await expect(storage.commitStopping(predecessor, binding)).rejects.toMatchObject({ code: 'invalid-evidence' })
  await expect(storage.commitReady(predecessor, prepared, binding)).rejects.toMatchObject({ code: 'conflict' })
  expect(query).toHaveBeenCalledTimes(3)
})

const wheel = process.env['DSH_S08_ACK_SERVER_WHEEL']
it.runIf(wheel !== undefined)('uses the actual private SDK HTTP carrier and Root SDK connection for live identity', () => {
  const script = fileURLToPath(new URL('./fixtures/sdk-allocation-binding-loopback.py', import.meta.url))
  execFileSync('python3', ['-I', '-B', script, '--wheel', wheel ?? '', '--node', process.execPath], { timeout: 20000, stdio: 'pipe' })
}, 25000)
