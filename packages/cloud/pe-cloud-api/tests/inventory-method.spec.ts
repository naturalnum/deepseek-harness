/** Original source-generated Typert and actual Remote/private-store owner; no Root publication or SSH execution is asserted. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { inventoryMethodMatches } from '../src/inventory-method.ts'
import { descriptors, managementAccount } from '../../pe-cloud-access/tests/fixtures/remote-servers/account.ts'
import { remoteManagedFixture } from '../../pe-opensandbox/tests/remote-managed-fixture.ts'

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cloud-inventory-method-'))
  const lifetime = new AbortController(), managed = await remoteManagedFixture()
  const binding: AccountBinding = { accountId: brandString<AccountBinding['accountId']>('inventory-remote'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'inventory-remote', lifetime: lifetime.signal }
  const retained: { account?: Awaited<ReturnType<typeof managementAccount>> } = {}
  onTestFinished(async () => {
    vi.restoreAllMocks()
    try { await retained.account?.close(); await managed.close() }
    finally { lifetime.abort(); rmSync(home, { recursive: true, force: true }) }
  })
  descriptors(home)
  const account = await managementAccount(home, binding, managed, {
    withModelKeyPeerUse() { throw new Error('Inventory inspection cannot borrow a business Peer') },
  })
  retained.account = account
  const service = account.ctx.cloudRemoteServers, row = service.inspect().rpcEndpoints[0]
  const descriptor = account.ctx.typert.local.get('cloudRemoteServers/action')
  if (row === undefined || descriptor === undefined) throw new Error('Original Remote/Typert tuple absent')
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
