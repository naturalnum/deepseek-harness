/** Pure account-core tests; no claim of deployed account or managed execution qualification. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountRemoteServers, type RemoteServer } from '../src/account.ts'
import { decide } from '../src/gate.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const input = { alias: 'fixture', host: '127.0.0.1', port: 22, user: 'fixture', description: '', tags: [], alwaysAsk: false }
function fixture(name: string) {
  const ctx = new Context(), lifetime = new AbortController()
  contexts.push(ctx)
  const binding: AccountBinding = Object.freeze({ accountId: brandString<AccountBinding['accountId']>(name),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'remote-core-fixture', lifetime: lifetime.signal })
  ctx.provide('peAccount', binding)
  let rows: readonly RemoteServer[] = []
  const removeSecret = vi.fn(async () => {})
  const servers = new AccountRemoteServers(ctx, binding, { maxServers: 4, maxCommandBytes: 256,
    policy: { alwaysAsk: false, readOnlyAllowlist: ['hostname'] }, assertCurrent: () => { lifetime.signal.throwIfAborted() },
    read: () => rows, write: async (next) => { rows = structuredClone(next) }, deleteCredential: removeSecret })
  return { servers, lifetime, ctx, binding, removeSecret }
}

it('isolates lists, forged ids and references across two trusted account graphs', async () => {
  const a = fixture('A'), b = fixture('B')
  const entry = await a.servers.add(input), ref = a.servers.list()[0]!.reference
  expect(b.servers.list()).toEqual([])
  await expect(b.servers.update(entry.id, input)).rejects.toThrow('forbidden')
  await expect(b.servers.remove(entry.id)).rejects.toThrow('forbidden')
  await expect(b.servers.reorder([entry.id])).rejects.toThrow('forbidden')
  const run = vi.fn()
  await expect(b.servers.execute(ref, 'hostname', undefined, new AbortController().signal, run)).rejects.toThrow('forbidden')
  expect(run).not.toHaveBeenCalled()
})

it('rejects paths, passwords, unknown ownership selectors and option injection before storage', async () => {
  const { servers } = fixture('A')
  for (const extra of [{ password: 'not-stored' }, { identityFile: '/Users/fixture/.ssh/key' }, { accountId: 'B' }, { key: 'not-stored' }]) {
    expect(() => servers.add({ ...input, ...extra })).toThrow()
  }
  for (const extra of [{ host: '-oProxyCommand=bad' }, { user: 'user@other' }, { alias: 'two words' }, { port: 0 }]) {
    expect(() => servers.add({ ...input, ...extra })).toThrow()
  }
  expect(servers.list()).toEqual([])
})

it('supports ordered CRUD and deletes only the selected account credential before its record', async () => {
  const { servers, removeSecret } = fixture('A')
  const a = await servers.add(input), b = await servers.add({ ...input, alias: 'second' })
  await servers.reorder([b.id, a.id])
  expect(servers.list().map(row => row.entry.id)).toEqual([b.id, a.id])
  const updated = await servers.update(a.id, { ...input, description: 'updated' })
  expect(updated.description).toBe('updated')
  await servers.remove(a.id)
  expect(removeSecret).toHaveBeenCalledExactlyOnceWith(a.id)
  expect(servers.list().map(row => row.entry.id)).toEqual([b.id])
})

it('rejects expired generation and copied bindings before listing or running', async () => {
  const f = fixture('A')
  await f.servers.add(input)
  const reference = f.servers.list()[0]!.reference
  f.lifetime.abort()
  expect(() => f.servers.list()).toThrow()
  await expect(f.servers.execute(reference, 'hostname', undefined, new AbortController().signal, vi.fn())).rejects.toThrow()
  const other = new Context(); contexts.push(other)
  other.provide('peAccount', Object.freeze({ ...f.binding, lifetime: new AbortController().signal }))
  expect(() => new AccountRemoteServers(other, f.binding, { maxServers: 1, maxCommandBytes: 1,
    policy: { alwaysAsk: true, readOnlyAllowlist: [] }, assertCurrent() {}, read: () => [], write: async () => {}, deleteCredential: async () => {} })).toThrow('forbidden')
})

it('rechecks target and cancellation after an approval await before invoking the original executor', async () => {
  for (const action of ['edit', 'cancel', 'expire'] as const) {
    const f = fixture(action), controller = new AbortController()
    const entry = await f.servers.add({ ...input, alwaysAsk: true }), reference = f.servers.list()[0]!.reference
    const run = vi.fn()
    await expect(f.servers.execute(reference, 'hostname', { ask: async () => {
      if (action === 'edit') await f.servers.update(entry.id, { ...input, host: '192.0.2.1' })
      if (action === 'cancel') controller.abort()
      if (action === 'expire') f.lifetime.abort()
      return true
    } }, controller.signal, run)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  }
})

it('never invokes the executor when approval is declined or unavailable', async () => {
  const f = fixture('A'); await f.servers.add({ ...input, alwaysAsk: true })
  const reference = f.servers.list()[0]!.reference, run = vi.fn()
  for (const approval of [undefined, { ask: async () => false }]) {
    const result = await f.servers.execute(reference, 'hostname', approval, new AbortController().signal, run)
    expect(result.decision.kind).toBe('denied')
  }
  expect(run).not.toHaveBeenCalled()
})

it('keeps mandatory and deterministic high-risk approval ahead of allowlisting without a full-access escape', async () => {
  for (const config of [{ alwaysAsk: true, readOnlyAllowlist: ['hostname'] }, { alwaysAsk: false, readOnlyAllowlist: ['rm'] }]) {
    const command = config.alwaysAsk ? 'hostname' : 'rm -rf /tmp/fixture'
    const result = await decide({ command, alias: 'fixture', isRegistered: true, config,
      // Legacy callers may still carry this extra input; it no longer grants authority.
      ...{ fullAccess: true }, approval: { ask: async () => false } })
    expect(result.kind).toBe('denied')
    expect(result.path).toBe(config.alwaysAsk ? 'always-ask' : 'ruleset')
  }
})
