/** Actual Native ClientRemote and generated Cloud contribution; only Connection wire replies are scripted. */
import { Context } from '@deepseek-ai/cordis'
import * as Registry from '@deepseek-ai/dsh-typert-registry/client'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import contribution from '@deepseek-ai/dsh-pe-cloud-api/remote'
import { brandString } from '@deepseek-ai/dsh-brand'
import { openConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/src/client/socket.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installCloudRemoteMethodCompatibility } from '../src/client/remote-method-compatibility.ts'

type InstallRequest = Parameters<TypertClientRemote['cloudSkills']['install']>[0]
const request: InstallRequest = {
  version: { epoch: brandString<InstallRequest['version']['epoch']>('component-epoch'),
    editToken: brandString<InstallRequest['version']['editToken']>('component-edit') },
  bundle: { kind: 'files', files: [{ relativePath: 'SKILL.md', dataBase64: 'Y29tcG9uZW50' }] },
}
async function fixture() {
  const ctx = new Context(), call = vi.fn<ConnectionHandle['rpc']['call']>()
    .mockResolvedValue({ ok: true, value: { persisted: 'unknown', applied: false } })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Registry).await()
  const stop = vi.fn()
  ctx.provide('connection', {
    interactions: 'answer', openWebSocket: openConnectionWebSocket, isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} }, reconnect: () => {},
    rpc: { call, open: () => { throw new Error('This naming fixture does not open a logical stream') } },
    registerGenerationSource: () => () => {}, start: () => ({ stop }),
  } satisfies ConnectionHandle)
  await ctx.plugin(Gateway).await()
  return { ctx, call }
}
function installDescriptor() {
  const value = contribution.descriptors.find(row => row.namespace === 'cloudSkills' && row.method === 'install')
  if (value === undefined) throw new Error('Original generated Cloud install descriptor absent')
  return value
}

it('keeps the generated Cloud install name reserved in a Native root without the embedding value', async () => {
  const f = await fixture()
  await expect(f.ctx.remote.$mount(contribution)).rejects.toThrow('method "cloudSkills/install" conflicts with its namespace service')
  expect(f.ctx.get('remote.cloudSkills')).toBeUndefined(); expect(f.ctx.typert.remotes.list()).toEqual([])
  expect(f.call).not.toHaveBeenCalled()
})

it('calls the original generated install endpoint only in its opted-in Root and withdraws it with the original contribution owner', async () => {
  const f = await fixture(), other = await fixture()
  const mounting: { scope?: Context } = {}
  const owner = f.ctx.plugin({ inject: ['remote'], apply: (scope) => {
    installCloudRemoteMethodCompatibility(scope)
    mounting.scope = scope
  } })
  await owner.await()
  // Native get() publishes provided values only after the original provider becomes ACTIVE.
  if (mounting.scope === undefined) throw new Error('Original contribution owner absent')
  expect(f.ctx.get('remoteMethodCompatibility')).toBeDefined()
  await mounting.scope.remote.$mount(contribution)
  await expect(other.ctx.remote.$mount(contribution)).rejects.toThrow('method "cloudSkills/install" conflicts with its namespace service')
  expect(other.ctx.get('remoteMethodCompatibility')).toBeUndefined(); expect(other.call).not.toHaveBeenCalled()
  const captured = f.ctx.remote.cloudSkills.install
  await expect(f.ctx.remote.cloudSkills.install(request)).resolves.toEqual({ ok: true, value: { persisted: 'unknown', applied: false } })
  expect(f.call).toHaveBeenCalledExactlyOnceWith('/api', 'cloudSkills/install', { args: { request } }, expect.any(AbortSignal))
  await owner.dispose()
  expect(f.ctx.get('remoteMethodCompatibility')).toBeUndefined(); expect(f.ctx.get('remote.cloudSkills')).toBeUndefined()
  expect(f.ctx.typert.remotes.list()).toEqual([])
  await expect(captured(request)).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  expect(f.call).toHaveBeenCalledTimes(1)
  await expect(f.ctx.remote.$mount(contribution)).rejects.toThrow('method "cloudSkills/install" conflicts with its namespace service')
})

it('retains the Native name guard for another namespace while Cloud is opted in', async () => {
  const f = await fixture()
  await f.ctx.plugin((scope) => { installCloudRemoteMethodCompatibility(scope) }).await()
  const descriptor = installDescriptor()
  await expect(f.ctx.remote.$mount({ package: '@fixture/other-install', descriptors: [{ ...descriptor,
    id: '@fixture/other-install#other/install', service: 'other', namespace: 'other' }] })).rejects.toThrow(
    'method "other/install" conflicts with its namespace service')
  expect(f.ctx.get('remote.other')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled()
})

it.each(['constructor', 'installDirect'])('retains the original namespace service collision check for %s', async (method) => {
  const f = await fixture()
  await f.ctx.plugin((scope) => { installCloudRemoteMethodCompatibility(scope) }).await()
  const descriptor = installDescriptor()
  await expect(f.ctx.remote.$mount({ package: '@fixture/retained-reserved', descriptors: [{ ...descriptor,
    id: '@fixture/retained-reserved#cloudSkills/' + method, method }] })).rejects.toThrow(
    'method "cloudSkills/' + method + '" conflicts with its namespace service')
  expect(f.ctx.get('remote.cloudSkills')).toBeUndefined(); expect(f.call).not.toHaveBeenCalled()
})
