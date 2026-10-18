/** Real Cordis graph ownership with explicit simulated inventories; no native UI/readiness evidence. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountBinding, AccountId, OwnerEpoch } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { createAccountExposure } from '../src/account-exposure.ts'
import { CloudApiError } from '../src/errors.ts'
import { ExposurePolicy } from '../src/exposure.ts'
import ExposureService from '../src/root.ts'
import type { ExposureInventory, ExposureManifest } from '../src/types.ts'

function manifest(): ExposureManifest {
  return {
    recipeVersion: 'd09-exposure-component',
    rpcEndpoints: [
      { endpoint: 'session/page', handlerId: 'native/session.page', guard: 'account-session' },
      { endpoint: 'session/prompt', handlerId: 'native/session.prompt', guard: 'account-session' },
    ],
    streamEndpoints: [{ endpoint: 'session/follow', handlerId: 'native/session.follow', guard: 'account-session' }],
    exactFetchRoutes: [{ method: 'POST', path: '/api/session/uploadFileBinary', handlerId: 'native/file-upload', guard: 'account-session' }],
    allowedSettings: [{ namespace: 'subagent', fields: ['maxDepth', 'maxActiveSubagents'] }],
  }
}

function simulatedInventory(input: ExposureManifest): ExposureInventory {
  return {
    recipeVersion: input.recipeVersion, rpcEndpoints: input.rpcEndpoints,
    streamEndpoints: input.streamEndpoints, exactFetchRoutes: input.exactFetchRoutes,
  }
}

function fixture() {
  const rootContext = new Context()
  const root = new ExposureService(rootContext, manifest()).policy
  const graphs: Context[] = []
  onTestFinished(async () => {
    for (const graph of graphs) await graph.fiber.dispose()
    await rootContext.fiber.dispose()
  })
  const account = async (name: string, selected = manifest(), recipeVersion = root.manifest.recipeVersion) => {
    const ctx = new Context()
    graphs.push(ctx)
    const lifetime = new AbortController()
    const binding: AccountBinding = Object.freeze({
      accountId: brandString<AccountId>(name), epoch: brandString<OwnerEpoch>('1'),
      recipeVersion, lifetime: lifetime.signal,
    })
    ctx.provide('peAccount', binding)
    const unavailable = new CloudApiError('cloud/account-unavailable', 'Fixture runtime admission is closed.')
    let draining = false
    const assertCurrent = vi.fn((actual: AccountBinding): void => {
      expect(actual).toBe(binding)
      if (draining) throw unavailable
    })
    let view: ExposurePolicy | undefined
    const owner = await ctx.plugin({
      inject: ['peAccount'],
      apply(scope) { view = createAccountExposure(scope, binding, assertCurrent, root, selected) },
    })
    if (view === undefined) throw new Error('Fixture exposure did not mount.')
    return { ctx, binding, lifetime, view, owner, assertCurrent, unavailable, setDraining: (value: boolean) => { draining = value } }
  }
  return { root, account }
}

function requireAll(policy: ExposurePolicy): void {
  expect(policy.requireRpc('session/page').guard).toBe('account-session')
  expect(policy.requireStream('session/follow').handlerId).toBe('native/session.follow')
  expect(policy.requireFetch('POST', '/api/session/uploadFileBinary').handlerId).toBe('native/file-upload')
  policy.assertSettingsFields('subagent', ['maxDepth'])
}

it('owns independent audits for A, B and root, including failed audit and local invalidation', async () => {
  const f = fixture()
  const a = await f.account('A')
  const b = await f.account('B')
  const inventory = simulatedInventory(manifest())
  a.view.audit(inventory)
  requireAll(a.view)
  expect(() => b.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => f.root.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  b.view.audit(inventory)
  f.root.audit(inventory)
  a.view.invalidate()
  expect(() => a.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  requireAll(b.view)
  requireAll(f.root)
  a.view.audit(inventory)
  expect(() => { a.view.audit({ ...inventory, rpcEndpoints: [] }) }).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
  expect(() => a.view.requireStream('session/follow')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  requireAll(b.view)
  requireAll(f.root)
  a.view.audit(inventory)
  requireAll(a.view)
})

it('uses the root immutable ceiling without borrowing its mutable audit state', async () => {
  const f = fixture()
  f.root.audit(simulatedInventory(manifest()))
  const a = await f.account('A')
  expect(() => a.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  a.view.audit(simulatedInventory(manifest()))
  f.root.invalidate()
  requireAll(a.view)
  expect(() => f.root.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('permits exact narrower selections while mounted extras and unselected fields remain denied', async () => {
  const f = fixture()
  const input = manifest()
  const a = await f.account('A', {
    ...input, rpcEndpoints: [input.rpcEndpoints[0]!], exactFetchRoutes: [],
    allowedSettings: [{ namespace: 'subagent', fields: ['maxDepth'] }],
  })
  a.view.audit({ ...simulatedInventory(input), rpcEndpoints: [...input.rpcEndpoints, {
    endpoint: 'session/newNativeMethod', handlerId: 'native/new', guard: 'account-session',
  }] })
  expect(a.view.requireRpc('session/page').endpoint).toBe('session/page')
  expect(a.view.requireStream('session/follow').endpoint).toBe('session/follow')
  a.view.assertSettingsFields('subagent', ['maxDepth'])
  for (const endpoint of ['session/prompt', 'session/newNativeMethod']) expect(() => a.view.requireRpc(endpoint)).toThrow()
  expect(() => a.view.requireFetch('POST', '/api/session/uploadFileBinary')).toThrow()
  expect(() => { a.view.assertSettingsFields('subagent', ['maxActiveSubagents']) }).toThrow()
  expect(() => { a.view.assertSettingsFields('subagent', ['maxDepth.child']) }).toThrow()
})

const expansions: Array<[string, (input: ExposureManifest) => ExposureManifest]> = [
  ['recipe', input => ({ ...input, recipeVersion: 'other' })],
  ['RPC endpoint', input => ({ ...input, rpcEndpoints: [{ ...input.rpcEndpoints[0]!, endpoint: 'session/new' }] })],
  ['RPC handler', input => ({ ...input, rpcEndpoints: [{ ...input.rpcEndpoints[0]!, handlerId: 'native/other' }] })],
  ['RPC guard', input => ({ ...input, rpcEndpoints: [{ ...input.rpcEndpoints[0]!, guard: 'authenticated-account' }] })],
  ['stream handler', input => ({ ...input, streamEndpoints: [{ ...input.streamEndpoints[0]!, handlerId: 'native/other' }] })],
  ['stream guard', input => ({ ...input, streamEndpoints: [{ ...input.streamEndpoints[0]!, guard: 'account-project' }] })],
  ['transport category', input => ({ ...input, rpcEndpoints: input.streamEndpoints, streamEndpoints: [] })],
  ['Fetch method', input => ({ ...input, exactFetchRoutes: [{ ...input.exactFetchRoutes[0]!, method: 'GET' }] })],
  ['Fetch path', input => ({ ...input, exactFetchRoutes: [{ ...input.exactFetchRoutes[0]!, path: '/api/other' }] })],
  ['Fetch handler', input => ({ ...input, exactFetchRoutes: [{ ...input.exactFetchRoutes[0]!, handlerId: 'native/other' }] })],
  ['Fetch guard', input => ({ ...input, exactFetchRoutes: [{ ...input.exactFetchRoutes[0]!, guard: 'account-attachment' }] })],
  ['settings namespace', input => ({ ...input, allowedSettings: [{ namespace: 'other', fields: [] }] })],
  ['settings field', input => ({ ...input, allowedSettings: [{ namespace: 'subagent', fields: ['unreviewed'] }] })],
  ['settings prefix', input => ({ ...input, allowedSettings: [{ namespace: 'subagent', fields: ['maxDepth.child'] }] })],
]

it.each(expansions)('rejects account %s expansion without changing root or B', async (_name, expand) => {
  const f = fixture()
  const b = await f.account('B')
  const inventory = simulatedInventory(manifest())
  b.view.audit(inventory)
  f.root.audit(inventory)
  await expect(f.account('A', expand(manifest()))).rejects.toMatchObject({ code: 'cloud/invalid-config' })
  requireAll(b.view)
  requireAll(f.root)
})

it('requires the account binding recipe to match root and selected manifest', async () => {
  const f = fixture()
  await expect(f.account('A', manifest(), 'other-binding-recipe')).rejects.toMatchObject({ code: 'cloud/invalid-config' })
})

it.each(['recipe', 'missing RPC', 'RPC guard', 'stream handler', 'Fetch guard'] as const)(
  'reuses actual inventory comparison and revokes only the local view on %s mismatch', async (changed) => {
    const f = fixture()
    const a = await f.account('A')
    const b = await f.account('B')
    const input = manifest()
    const inventory = simulatedInventory(input)
    a.view.audit(inventory)
    b.view.audit(inventory)
    const bad: ExposureInventory = changed === 'recipe' ? { ...inventory, recipeVersion: 'other' }
      : changed === 'missing RPC' ? { ...inventory, rpcEndpoints: [] }
        : changed === 'RPC guard' ? {
          ...inventory, rpcEndpoints: input.rpcEndpoints.map((row, index) => index === 0 ? { ...row, guard: 'account-project' } : row),
        }
          : changed === 'stream handler' ? { ...inventory, streamEndpoints: [{ ...input.streamEndpoints[0]!, handlerId: 'native/other' }] }
            : { ...inventory, exactFetchRoutes: [{ ...input.exactFetchRoutes[0]!, guard: 'account-attachment' }] }
    expect(() => { a.view.audit(bad) }).toThrow(expect.objectContaining({ code: 'cloud/invalid-config' }))
    expect(() => a.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    requireAll(b.view)
  },
)

it('checks trusted runtime admission for audit and every operation while another graph remains current', async () => {
  const f = fixture()
  const a = await f.account('A')
  const b = await f.account('B')
  const inventory = simulatedInventory(manifest())
  a.view.audit(inventory)
  b.view.audit(inventory)
  a.setDraining(true)
  const work = [
    () => a.view.requireRpc('session/page'), () => a.view.requireStream('session/follow'),
    () => a.view.requireFetch('POST', '/api/session/uploadFileBinary'),
    () => { a.view.assertSettingsFields('subagent', ['maxDepth']) }, () => { a.view.audit(inventory) },
  ]
  for (const operation of work) expect(operation).toThrow(a.unavailable)
  requireAll(b.view)
  a.setDraining(false)
  expect(() => a.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  a.view.audit(inventory)
  requireAll(a.view)
})

it.each(['lifetime', 'same-value replacement', 'new epoch'] as const)('rejects stale %s even with the old audit', async (cause) => {
  const f = fixture()
  const a = await f.account('A')
  const b = await f.account('B')
  const inventory = simulatedInventory(manifest())
  a.view.audit(inventory)
  b.view.audit(inventory)
  if (cause === 'lifetime') a.lifetime.abort()
  else a.ctx.set('peAccount', { ...a.binding, ...cause === 'new epoch' ? { epoch: brandString<OwnerEpoch>('2') } : {} })
  expect(() => a.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(() => { a.view.audit(inventory) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  requireAll(b.view)
})

it('rechecks exact binding after the current callback and revokes a failed post-audit recheck', async () => {
  const f = fixture()
  const a = await f.account('A')
  const inventory = simulatedInventory(manifest())
  a.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
    a.ctx.set('peAccount', { ...a.binding, epoch: brandString<OwnerEpoch>('2') })
  })
  expect(() => { a.view.audit(inventory) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  a.ctx.set('peAccount', a.binding)
  expect(() => a.view.requireRpc('session/page')).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('detaches the selected grants from later mutable input and freezes the returned view manifest', async () => {
  const f = fixture()
  const input = manifest()
  const selected = {
    ...input, rpcEndpoints: [input.rpcEndpoints[0]!],
    allowedSettings: [{ namespace: 'subagent', fields: ['maxDepth'] }],
  }
  const a = await f.account('A', selected)
  selected.rpcEndpoints.push(input.rpcEndpoints[1]!)
  selected.allowedSettings[0]!.fields.push('maxActiveSubagents')
  a.view.audit(simulatedInventory(input))
  expect(() => a.view.requireRpc('session/prompt')).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(() => { a.view.assertSettingsFields('subagent', ['maxActiveSubagents']) }).toThrow()
  expect(Object.isFrozen(a.view.manifest)).toBe(true)
  expect(Object.isFrozen(a.view.manifest.allowedSettings[0]!.fields)).toBe(true)
  expect(Object.isFrozen(a.view.requireRpc('session/page'))).toBe(true)
})

it('disposes only the owning view without invalidating root or another live graph', async () => {
  const f = fixture()
  const a = await f.account('A')
  const b = await f.account('B')
  const inventory = simulatedInventory(manifest())
  f.root.audit(inventory)
  a.view.audit(inventory)
  b.view.audit(inventory)
  const rootInvalidated = vi.spyOn(f.root, 'invalidate')
  const aInvalidated = vi.spyOn(a.view, 'invalidate')
  await a.owner.dispose()
  expect(aInvalidated).toHaveBeenCalledOnce()
  expect(rootInvalidated).not.toHaveBeenCalled()
  expect(() => a.view.requireRpc('session/page')).toThrow()
  requireAll(b.view)
  requireAll(f.root)
})
