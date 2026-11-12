/** Original source-generated Typert and actual Remote/private-store owner; no Root publication or SSH execution is asserted. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest'
import { inventoryMethodMatches } from '../src/inventory-method.ts'
import { descriptors, managementAccount } from '../../pe-cloud-access/tests/fixtures/remote-servers/account.ts'
import { remoteManagedFixture } from '../../pe-opensandbox/tests/remote-managed-fixture.ts'

function observePhase(phase: string, state: 'begin' | 'end', startedAt: number): void {
  try {
    console.warn('Cloud inventory fixture phase: %j', { phase, state, elapsedMs: performance.now() - startedAt })
  } catch (_diagnosticFailure) { /* Phase observation cannot change the original test outcome. */ }
}

// Source analysis produces immutable codecs; each case still owns its Loader and account.
let descriptorHome: string | undefined
beforeAll(() => {
  descriptorHome = mkdtempSync(join(tmpdir(), 'cloud-inventory-codecs-'))
  const startedAt = performance.now()
  observePhase('source-descriptors', 'begin', startedAt)
  descriptors(descriptorHome)
  observePhase('source-descriptors', 'end', startedAt)
})
afterAll(() => { if (descriptorHome !== undefined) rmSync(descriptorHome, { recursive: true, force: true }) })

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cloud-inventory-method-'))
  const lifetime = new AbortController(), managedAt = performance.now()
  observePhase('managed-start', 'begin', managedAt)
  const managed = await remoteManagedFixture()
  observePhase('managed-start', 'end', managedAt)
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('inventory-remote'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'inventory-remote', lifetime: lifetime.signal }
  const retained: { account?: Awaited<ReturnType<typeof managementAccount>> } = {}
  onTestFinished(async () => {
    const closeAt = performance.now()
    observePhase('fixture-close', 'begin', closeAt)
    vi.restoreAllMocks()
    try { await retained.account?.close(); await managed.close() }
    finally { lifetime.abort(); rmSync(home, { recursive: true, force: true }) }
    observePhase('fixture-close', 'end', closeAt)
  })
  const descriptorsAt = performance.now()
  observePhase('descriptor-install', 'begin', descriptorsAt)
  if (descriptorHome === undefined) throw new Error('Source-generated descriptors were not prepared')
  cpSync(join(descriptorHome, 'node_modules'), join(home, 'node_modules'), { recursive: true })
  observePhase('descriptor-install', 'end', descriptorsAt)
  const accountAt = performance.now()
  observePhase('management-account', 'begin', accountAt)
  const account = await managementAccount(home, binding, managed, {
    withModelKeyPeerUse() { throw new Error('Inventory inspection cannot borrow a business Peer') },
  })
  observePhase('management-account', 'end', accountAt)
  retained.account = account
  const inspectAt = performance.now()
  observePhase('remote-inventory-tuple', 'begin', inspectAt)
  const service = account.ctx.cloudRemoteServers, row = service.inspect().rpcEndpoints[0]
  const descriptor = account.ctx.typert.local.get('cloudRemoteServers/action')
  if (row === undefined || descriptor === undefined) throw new Error('Original Remote/Typert tuple absent')
  observePhase('remote-inventory-tuple', 'end', inspectAt)
  return { ...account, service, row, descriptor }
}

it('accepts only the exact original Cloud remote-management identity and preserves the Native tuple comparison', async () => {
  const f = await fixture()
  expect(f.row).toEqual({ endpoint: 'cloudRemoteServers/action', handlerId: 'cloud:remote-servers', guard: 'authenticated-account' })
  expect(f.descriptor).toMatchObject({ service: 'cloudRemoteServers', namespace: 'cloudRemoteServers', method: 'action' })
  console.info(JSON.stringify({ evidence: 'actual-remote-inventory-tuple', inventory: f.row,
    descriptor: { service: f.descriptor.service, namespace: f.descriptor.namespace, method: f.descriptor.method,
      implementation: f.descriptor.implementation ?? f.descriptor.method, mode: f.descriptor.mode ?? 'rpc',
      invocation: f.descriptor.invocation.kind, parameterCodec: f.descriptor.parameters[0]?.codec.mode,
      resultCodec: f.descriptor.result.mode, cancellation: f.descriptor.cancellation?.parameter },
  }))
  expect(f.row.handlerId.slice('native:'.length)).toBe('emote-servers')
  expect(inventoryMethodMatches(f.row, 'rpc', f.descriptor)).toBe(true)
  expect(inventoryMethodMatches({ ...f.row, handlerId: 'native:cloudRemoteServers' }, 'rpc', f.descriptor)).toBe(true)
  expect(inventoryMethodMatches({ ...f.row, handlerId: 'native:other' }, 'rpc', f.descriptor)).toBe(false)
  for (const row of [
    { ...f.row, handlerId: 'cloud:other' }, { ...f.row, handlerId: 'unknown:remote-servers' },
    { ...f.row, endpoint: 'other/action' }, { ...f.row, endpoint: 'cloudRemoteServers/other' },
    { ...f.row, guard: 'account-session' as const },
  ]) expect(inventoryMethodMatches(row, 'rpc', f.descriptor)).toBe(false)
  expect(inventoryMethodMatches(f.row, 'stream', f.descriptor)).toBe(false)
  for (const descriptor of [
    { ...f.descriptor, service: 'other' }, { ...f.descriptor, namespace: 'other' },
    { ...f.descriptor, method: 'other' }, { ...f.descriptor, implementation: 'other' },
    { ...f.descriptor, mode: 'stream' as const },
  ]) expect(inventoryMethodMatches(f.row, 'rpc', descriptor)).toBe(false)
})

it('keeps the actual Remote provider strict validation before the shared inventory comparison', async () => {
  const f = await fixture(), view = f.ctx.typert.local
  const original = (endpoint: string) => view.get(endpoint)
  for (const descriptor of [
    { ...f.descriptor, service: 'other' }, { ...f.descriptor, namespace: 'other' },
    { ...f.descriptor, method: 'other' }, { ...f.descriptor, implementation: 'other' },
    { ...f.descriptor, mode: 'stream' as const },
  ]) {
    const changed = vi.spyOn(Typert.prototype, 'local', 'get').mockReturnValue({ ...view, get: endpoint =>
      endpoint === 'cloudRemoteServers/action' ? descriptor : original(endpoint) })
    try { expect(() => f.service.inspect()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' })) }
    finally { changed.mockRestore() }
  }
})
