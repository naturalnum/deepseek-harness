/** Real Loader contribution lifecycle and native SRC inspection without invoking business work. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { type Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { AccountCapabilityInventories } from '../src/capability-inventory.ts'
import type { ExposureInventory } from '../src/types.ts'

class Capability extends TypertRemoteService {
  calls = 0
  constructor(ctx: Context) { super(ctx, 'cloudProbe') }
  @Remote
  read(request: { id: string }): string { this.calls++; return request.id }
}

const inventory = (): ExposureInventory => ({ recipeVersion: 'capability-fixture',
  rpcEndpoints: [{ endpoint: 'cloudProbe/read', handlerId: 'native:cloudProbe', guard: 'authenticated-account' }],
  streamEndpoints: [], exactFetchRoutes: [] })

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cloud-capability-')))
  const configPath = join(directory, 'cordis.yml')
  writeFileSync(configPath, JSON.stringify([
    { id: 'typert', name: 'cordis:fixture-typert' },
    { id: 'access', name: 'cordis:fixture-access' },
    { id: 'gateway', name: 'cordis:fixture-gateway' },
    { id: 'capability', name: 'cordis:fixture-capability' },
  ]))
  const invalidate = vi.fn(), contributions = new AccountCapabilityInventories('capability-fixture', 32, invalidate)
  let current = inventory(), dispose: (() => void) | undefined
  const ctx = await boot('capability-fixture', configPath, [], (scope) => {
    Object.assign(scope.loader.builtins, {
      'fixture-typert': TypertRegistry, 'fixture-access': RemoteAccess, 'fixture-gateway': Gateway,
      'fixture-capability': { inject: ['typertGateway'], apply(owner: Context) {
        new Capability(owner)
        dispose = contributions.register(owner, 'cloudProbe', () => current)
      } },
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { ctx, contributions, invalidate, set(value: ExposureInventory) { current = value },
    remove() { if (dispose === undefined) throw new Error('Contribution did not mount'); dispose() } }
}

it('audits a real Loader service, rechecks changed rows and withdraws the contribution on disposal', async () => {
  const f = await fixture(), value = inventory()
  expect(f.contributions.inspect(f.ctx)).toEqual(value)
  expect(f.invalidate).toHaveBeenCalledTimes(1)
  expect(f.ctx.get('cloudProbe')).toMatchObject({ calls: 0 })
  const row = value.rpcEndpoints[0]
  if (row === undefined) throw new Error('Missing test endpoint')
  expect(f.contributions.assertEndpoint(f.ctx, row, 'rpc')).toBe(true)
  expect(f.contributions.assertEndpoint(f.ctx, { endpoint: 'session/list', handlerId: 'native:sessionController',
    guard: 'authenticated-account' }, 'rpc')).toBe(false)
  f.set({ ...value, rpcEndpoints: [] })
  expect(() => { f.contributions.assertEndpoint(f.ctx, row, 'rpc') }).toThrow()
  f.remove()
  expect(f.contributions.inspect(f.ctx).rpcEndpoints).toEqual([])
  expect(f.invalidate).toHaveBeenCalledTimes(2)
})

it.each([
  { endpoint: 'cloudProbe/missing', handlerId: 'native:cloudProbe', guard: 'authenticated-account' as const },
  { endpoint: 'other/read', handlerId: 'native:other', guard: 'authenticated-account' as const },
  { endpoint: 'cloudProbe/read', handlerId: 'native:forged', guard: 'authenticated-account' as const },
  { endpoint: 'cloudProbe/read', handlerId: 'native:cloudProbe', guard: 'account-session' as const },
])('refuses an inventory row without its actual method, owner or declared Session resource: $endpoint $guard', async (row) => {
  const f = await fixture()
  f.set({ ...inventory(), rpcEndpoints: [row] })
  expect(() => f.contributions.inspect(f.ctx)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects duplicate registration and an unloaded service instead of trusting a retained inventory', async () => {
  const f = await fixture()
  expect(() => f.contributions.register(f.ctx, 'cloudProbe', inventory)).toThrow()
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'capability')
  if (entry?.fiber === undefined) throw new Error('Capability fixture did not load')
  await entry.fiber.dispose()
  expect(f.contributions.inspect(f.ctx).rpcEndpoints).toEqual([])
  expect(f.ctx.get('cloudProbe')).toBeUndefined()
})
