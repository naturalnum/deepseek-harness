/** Actual Native Loader, Settings writer and account policy; this component is not production Factory readiness. */
import { AsyncResource } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ApprovedConfigurationCatalog, EndpointExposure } from '@deepseek-ai/dsh-pe-cloud-api'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { sourceSettingsManifest } from './fixtures/source-settings-manifest.ts'
import { AgentLoopCardController, type AgentLoopSettings } from '../../../client/ui-settings-agent-loop/src/client/agent-loop-card-controller.ts'
import type { SettingsFormPathOp, SettingsFormScopeSnapshot } from '../../../client/ui-primitives/src/settings-form/form-model.ts'

const bounds = { maxHomeBytes: 4096, maxCollectionItems: 512, maxFrameBytes: 262144,
  maxQueuedEvents: 128, maxQueuedBytes: 4194304 }
const version = (JSON.parse(readFileSync(new URL('../../../client/locale/package.json', import.meta.url), 'utf8')) as { version: string }).version
const catalog: ApprovedConfigurationCatalog = {
  recipeVersion: 'm8z', catalogVersion: 'agent-loop-settings-candidate', maxEntries: 512, maxStringBytes: 512, maxCatalogBytes: 8192,
  plugins: [{ id: 'locale', entryId: 'include:locale', moduleName: '@deepseek-ai/dsh-client-locale',
    packageName: '@deepseek-ai/dsh-client-locale', packageVersion: version, installable: false, toggleable: false }],
  skills: { mode: 'closed' }, credentials: { mode: 'read-only' },
  fields: [{ namespace: 'agent-loop', field: 'maxParallelToolCalls', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
}
const writer: EndpointExposure = { endpoint: 'settings/mutate', handlerId: 'native:settingsController', guard: 'authenticated-account' }

it('writes the bounded actual native loop, preserves policy and Session, reopens and restores the original', async () => {
  const f = policyFixture([writer], bounds, 'loop-setting-component', undefined, catalog,
    await sourceSettingsManifest(), undefined, undefined, [], true)
  const first = await f.start()
  await first.guards.assertBootstrapCurrent(first.lifetime.signal)
  expect(first.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  const initial = first.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (initial === undefined) throw new Error('The original AgentLoop settings namespace is absent')
  const loopEntry = [...first.ctx.loader.entries()].find(entry => entry.options.id === 'agent-loop')
  const presetEntry = [...first.ctx.loader.entries()].find(entry => entry.options.id === 'cloud-preset')
  if (loopEntry === undefined || presetEntry === undefined) throw new Error('The original policy entries are absent')
  const outside = new AsyncResource('outside-settings-write')
  onTestFinished(() => { outside.emitDestroy() })
  let reentered = false
  let outsideRejected = false
  first.ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== 'agent-loop' || first.ctx.agentLoop.config.maxParallelToolCalls.get() !== 2 || reentered) return
    reentered = true
    expect(first.guards.allowedModel('local-text', 'plain-text')).toBe(true)
    outside.runInAsyncScope(() => {
      expect(() => first.guards.allowedModel('local-text', 'plain-text'))
        .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      outsideRejected = true
    })
    expect(() => first.guards.beginSettingsUpdate('agent-loop',
      [{ op: 'set', path: ['maxParallelToolCalls'], value: 3 }], catalog.fields)).toThrow()
    const originalLoop: unknown = loopEntry.options.config, originalPreset: unknown = presetEntry.options.config
    const originalModule = loopEntry.moduleNamespace
    const runtime = loopEntry.fiber?.runtime, originalSchema: unknown = runtime?.Config
    const provider = loopEntry.fiber?.store?.agentLoop, originalProvider: unknown = provider?.value
    try {
      loopEntry.options.config = { ...(originalLoop as object), maxParallelToolCalls: 9 }
      expect(() => first.guards.allowedModel('local-text', 'plain-text')).toThrow()
      loopEntry.options.config = { ...(originalLoop as object), agents: [{ id: 'unapproved-agent' }] }
      expect(() => first.guards.allowedModel('local-text', 'plain-text')).toThrow()
      loopEntry.options.config = originalLoop
      presetEntry.options.config = { ...(originalPreset as object), id: 'unapproved-preset' }
      expect(() => first.guards.allowedModel('local-text', 'plain-text')).toThrow()
      presetEntry.options.config = originalPreset
      loopEntry.moduleNamespace = {}
      expect(() => first.guards.allowedModel('local-text', 'plain-text')).toThrow()
      loopEntry.moduleNamespace = originalModule
      if (runtime === undefined || runtime === null) throw new Error('Original AgentLoop runtime is absent')
      Reflect.set(runtime, 'Config', {})
      expect(() => first.guards.allowedModel('local-text', 'plain-text')).toThrow()
      Reflect.set(runtime, 'Config', originalSchema)
      if (provider === undefined) throw new Error('Original AgentLoop provider is absent')
      Reflect.set(provider, 'value', {})
      expect(() => first.guards.allowedModel('local-text', 'plain-text')).toThrow()
    } finally {
      loopEntry.options.config = originalLoop
      presetEntry.options.config = originalPreset
      loopEntry.moduleNamespace = originalModule
      if (runtime !== undefined && runtime !== null) Reflect.set(runtime, 'Config', originalSchema)
      if (provider !== undefined) Reflect.set(provider, 'value', originalProvider)
    }
  })
  await expect(first.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision))
    .resolves.toMatchObject({ ns: 'agent-loop', value: { maxParallelToolCalls: 2 } })
  expect(first.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  expect(reentered).toBe(true)
  expect(outsideRejected).toBe(true)
  outside.runInAsyncScope(() => { expect(first.guards.allowedModel('local-text', 'plain-text')).toBe(true) })
  await expect(first.guards.assertBootstrapCurrent(first.lifetime.signal)).resolves.toBeUndefined()
  const { sessionId } = await first.ctx.sessionController.create({})
  const finished = Promise.withResolvers<undefined>()
  first.ctx.on('session/event', (session, event) => {
    if (session.id === sessionId && event.type === 'turn/end') finished.resolve(undefined)
  })
  await expect(first.invoke('prompt', { sessionId, requestId: 'bounded-loop-turn', mode: 'followup',
    content: [{ type: 'text', text: 'check actual loop' }] })).resolves.toEqual({ accepted: true })
  await finished.promise
  expect(first.adapter.calls).toBe(1)
  const revision = first.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')?.revision
  for (const op of [{ op: 'set', path: ['maxParallelToolCalls'], value: 11 },
    { op: 'set', path: ['maxParallelToolCalls'], value: 0 },
    { op: 'unset', path: ['agents'] }] as const) {
    await expect(first.invokeSettings('agent-loop', [op], revision)).rejects.toMatchObject({ code: 'cloud/forbidden' })
  }
  expect(first.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  await first.close()
  const second = await f.start('2')
  expect(second.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  await expect(second.guards.assertBootstrapCurrent(second.lifetime.signal)).resolves.toBeUndefined()
  const stored = second.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (stored === undefined) throw new Error('Reopened AgentLoop settings namespace is absent')
  await expect(second.invokeSettings('agent-loop', [{ op: 'unset', path: ['maxParallelToolCalls'] }], stored.revision))
    .resolves.toMatchObject({ value: { maxParallelToolCalls: 10 } })
  expect(second.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  await expect(second.guards.assertBootstrapCurrent(second.lifetime.signal)).resolves.toBeUndefined()
  await second.close()
  const third = await f.start('3')
  expect(third.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  await expect(third.guards.assertBootstrapCurrent(third.lifetime.signal)).resolves.toBeUndefined()
})

it('refuses reset when the actual inherited native value is outside the approved range', async () => {
  const f = policyFixture([writer], bounds, 'loop-unsafe-reset', undefined, catalog,
    await sourceSettingsManifest(), undefined, undefined, [], true, 11)
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const original = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (original === undefined) throw new Error('The original AgentLoop settings namespace is absent')
  await expect(graph.invokeSettings('agent-loop', [{ op: 'unset', path: ['maxParallelToolCalls'] }], original.revision))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(11)
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('keeps the old global pin until the save owner has joined its outstanding child', async () => {
  const f = policyFixture([writer], bounds, 'loop-save-child', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (initial === undefined) throw new Error('The original AgentLoop settings namespace is absent')
  const outside = new AsyncResource('outside-settings-child')
  onTestFinished(() => { outside.emitDestroy() })
  const child = Promise.withResolvers<undefined>(), prepared = Promise.withResolvers<undefined>()
  const begin = graph.guards.beginSettingsUpdate
  vi.spyOn(graph.guards, 'beginSettingsUpdate').mockImplementation((...args) => {
    const transaction = begin(...args)
    return { ...transaction, finish() { transaction.finish(); prepared.resolve(undefined) } }
  })
  let enrolled = false
  graph.ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== 'agent-loop' || enrolled) return
    enrolled = true
    void graph.saveBarrier.admit('config-editor', () => child.promise)
  })
  const saving = graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision)
  const queued = graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 3 }], initial.revision + 1)
  await prepared.promise
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(enrolled).toBe(true)
  expect(graph.saveBarrier.snapshot().pending).toHaveLength(2)
  outside.runInAsyncScope(() => {
    expect(() => graph.guards.allowedModel('local-text', 'plain-text'))
      .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  })
  child.resolve(undefined)
  await expect(saving).resolves.toMatchObject({ value: { maxParallelToolCalls: 2 } })
  await expect(queued).resolves.toMatchObject({ value: { maxParallelToolCalls: 3 } })
  outside.runInAsyncScope(() => { expect(graph.guards.allowedModel('local-text', 'plain-text')).toBe(true) })
})

it('holds an independent session activity in the bounded event source until the settings save commits', async () => {
  const f = policyFixture([writer], bounds, 'loop-pending-session-event', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const { sessionId } = await graph.ctx.sessionController.create({})
  const sessionGuard = vi.spyOn(graph.guards, 'assertSessionRead')
  const abort = new AbortController()
  const peer: PeerScope = { id: brandString<PeerScope['id']>('loop-event-peer'), ctx: graph.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: abort.signal, dispose: async () => { abort.abort() } }
  const stream = await graph.ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function *() {})(), peer, abort.signal)
  const iterator = stream[Symbol.asyncIterator]()
  onTestFinished(async () => { abort.abort(); await iterator.return?.() })
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const outside = new AsyncResource('outside-session-event')
  onTestFinished(() => { outside.emitDestroy() })
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (initial === undefined) throw new Error('The original AgentLoop settings namespace is absent')
  const child = Promise.withResolvers<undefined>(), prepared = Promise.withResolvers<undefined>()
  const begin = graph.guards.beginSettingsUpdate
  vi.spyOn(graph.guards, 'beginSettingsUpdate').mockImplementation((...args) => {
    const transaction = begin(...args)
    return { ...transaction, finish() { transaction.finish(); prepared.resolve(undefined) } }
  })
  let enrolled = false
  graph.ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== 'agent-loop' || enrolled) return
    enrolled = true
    void graph.saveBarrier.admit('config-editor', () => child.promise)
  })
  const saving = graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision)
  await prepared.promise
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  sessionGuard.mockClear()
  const at = 42
  outside.runInAsyncScope(() => { graph.ctx.emit('api-session/activity', sessionId, at) })
  let delivered = false
  const activity = (async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) throw new Error('The account event stream ended before session activity')
      const args: unknown = next.value !== null && typeof next.value === 'object' ? Reflect.get(next.value, 'args') : undefined
      if (next.value !== null && typeof next.value === 'object' && Reflect.get(next.value, 'event') === 'api-session/activity'
        && Array.isArray(args) && args[0] === sessionId && args[1] === at) {
        delivered = true
        return next.value
      }
    }
  })()
  void activity.catch(() => {})
  try {
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(delivered).toBe(false)
    expect(sessionGuard).not.toHaveBeenCalled()
    expect(graph.saveBarrier.snapshot().pending).toHaveLength(1)
  } finally { child.resolve(undefined) }
  await expect(saving).resolves.toMatchObject({ value: { maxParallelToolCalls: 2 } })
  await expect(activity).resolves.toMatchObject({ type: 'emit', event: 'api-session/activity', args: [sessionId, at] })
  expect(sessionGuard).toHaveBeenCalledWith(sessionId)
  expect(graph.api.requireStream('$events').guard).toBe('authenticated-account')
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('withdraws the account event source while its original settings save remains pending', async () => {
  const f = policyFixture([writer], bounds, 'loop-withdraw-pending-event', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (initial === undefined || graph.events === undefined) throw new Error('Original settings or event source is absent')
  const child = Promise.withResolvers<undefined>(), prepared = Promise.withResolvers<undefined>()
  const begin = graph.guards.beginSettingsUpdate
  vi.spyOn(graph.guards, 'beginSettingsUpdate').mockImplementation((...args) => {
    const transaction = begin(...args)
    return { ...transaction, finish() { transaction.finish(); prepared.resolve(undefined) } }
  })
  let enrolled = false
  graph.ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== 'agent-loop' || enrolled) return
    enrolled = true
    void graph.saveBarrier.admit('config-editor', () => child.promise)
  })
  const saving = graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision)
  void saving.catch(() => {})
  await prepared.promise
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([graph.events.dispose().then(() => 'withdrawn'),
      new Promise<string>((resolve) => { timeout = setTimeout(() => { resolve('timed out') }, 1000) })])
    expect(outcome).toBe('withdrawn')
    expect(graph.saveBarrier.snapshot().pending).toHaveLength(1)
    graph.expectUnknownSave()
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    child.resolve(undefined)
  }
  await expect(saving).rejects.toMatchObject({ name: 'ConfigSaveOutcomeUnknown' })
  expect(graph.saveBarrier.snapshot()).toMatchObject({ pending: [], failures: [{ outcome: 'unknown' }] })
})

it('rejects a new question during a pending settings save while the original event source continues', async () => {
  const questionRpc: EndpointExposure[] = [writer,
    { endpoint: 'userQuestions/answer', handlerId: 'native:userQuestions', guard: 'account-session' },
    { endpoint: '$events/result', handlerId: 'native:typertGateway', guard: 'authenticated-account' }]
  const questionStreams: EndpointExposure[] = [
    { endpoint: 'userQuestions/attachWait', handlerId: 'native:userQuestions', guard: 'account-session' }]
  const f = policyFixture(questionRpc, bounds, 'loop-pending-question', undefined, catalog,
    await sourceSettingsManifest(), undefined, undefined, questionStreams)
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const { sessionId } = await graph.ctx.sessionController.create({})
  const agent = graph.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('The original Session Agent is absent')
  const abort = new AbortController()
  const peer: PeerScope = { id: brandString<PeerScope['id']>('loop-question-peer'), ctx: graph.ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: abort.signal, dispose: async () => { abort.abort() } }
  const stream = await graph.ctx.typertGateway.wireStream.open('$events', { args: {} }, (async function *() {})(), peer, abort.signal)
  const iterator = stream[Symbol.asyncIterator]()
  onTestFinished(async () => { abort.abort(); await iterator.return?.() })
  await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'ready' } })
  const outside = new AsyncResource('outside-pending-question')
  onTestFinished(() => { outside.emitDestroy() })
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (initial === undefined) throw new Error('The original AgentLoop settings namespace is absent')
  const child = Promise.withResolvers<undefined>(), prepared = Promise.withResolvers<undefined>()
  const begin = graph.guards.beginSettingsUpdate
  vi.spyOn(graph.guards, 'beginSettingsUpdate').mockImplementation((...args) => {
    const transaction = begin(...args)
    return { ...transaction, finish() { transaction.finish(); prepared.resolve(undefined) } }
  })
  let enrolled = false
  graph.ctx.on('settings/document-updated', (namespace) => {
    if (namespace !== 'agent-loop' || enrolled) return
    enrolled = true
    void graph.saveBarrier.admit('config-editor', () => child.promise)
  })
  const saving = graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision)
  await prepared.promise
  const questions = [{ id: 'review', question: 'Continue?' }]
  try {
    const rejected = outside.runInAsyncScope(() => graph.ctx.userQuestions.ask({ agent, questions }))
    await expect(rejected).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(graph.saveBarrier.snapshot().pending).toHaveLength(1)
  } finally { child.resolve(undefined) }
  await expect(saving).resolves.toMatchObject({ value: { maxParallelToolCalls: 2 } })
  expect(graph.events?.inspect()).toMatchObject({ endpoint: '$events', queuedEvents: 0 })
  const followupAbort = new AbortController()
  const followup = graph.ctx.userQuestions.ask({ agent, questions, signal: followupAbort.signal })
  void followup.catch(() => {})
  let frame: unknown
  for (let index = 0; index < bounds.maxQueuedEvents; index++) {
    const next = await iterator.next()
    if (next.done) throw new Error('The original event stream ended before the follow-up question')
    if (next.value !== null && typeof next.value === 'object' && Reflect.get(next.value, 'type') === 'waterfall') {
      frame = next.value
      break
    }
  }
  expect(frame).toMatchObject({ type: 'waterfall', event: 'user-questions/request', agentId: sessionId })
  followupAbort.abort()
  await expect(followup).rejects.toBeDefined()
})

it('retains an unknown save and denies other contexts when the final policy commit sees a changed fact', async () => {
  const f = policyFixture([writer], bounds, 'loop-commit-unknown', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === 'agent-loop')
  if (initial === undefined || entry === undefined) throw new Error('The original AgentLoop settings are absent')
  const outside = new AsyncResource('outside-unknown-settings')
  onTestFinished(() => { outside.emitDestroy() })
  let deniedBeforeSettlement = false
  const begin = graph.guards.beginSettingsUpdate
  vi.spyOn(graph.guards, 'beginSettingsUpdate').mockImplementation((...args) => {
    const transaction = begin(...args)
    return { ...transaction, publish(audit) {
      const original: unknown = entry.options.config
      try {
        entry.options.config = { ...(original as object), maxParallelToolCalls: 9 }
        transaction.publish(audit)
      } catch (error) {
        entry.options.config = original
        outside.runInAsyncScope(() => {
          expect(() => graph.guards.allowedModel('local-text', 'plain-text'))
            .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
        })
        deniedBeforeSettlement = true
        throw error
      } finally { entry.options.config = original }
    } }
  })
  graph.expectUnknownSave()
  await expect(graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision))
    .rejects.toMatchObject({ name: 'ConfigSaveOutcomeUnknown' })
  expect(graph.saveBarrier.snapshot()).toMatchObject({ pending: [], failures: [{ outcome: 'unknown' }] })
  expect(deniedBeforeSettlement).toBe(true)
  outside.runInAsyncScope(() => {
    expect(() => graph.guards.allowedModel('local-text', 'plain-text'))
      .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  })
})

it('refuses a reentrant independent Gateway write without aborting the original save', async () => {
  const f = policyFixture([writer], bounds, 'loop-independent-reentry', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  let nested: Promise<unknown> | undefined
  graph.ctx.on('settings/document-updated', (namespace, revision) => {
    if (namespace !== 'agent-loop' || graph.ctx.agentLoop.config.maxParallelToolCalls.get() !== 2 || nested !== undefined) return
    expect(graph.guards.allowedModel('local-text', 'plain-text')).toBe(true)
    nested = graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 3 }], revision)
    void nested.catch(() => {})
  })
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  await expect(graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial?.revision))
    .resolves.toMatchObject({ value: { maxParallelToolCalls: 2 } })
  if (nested === undefined) throw new Error('The independent reentrant request was not dispatched')
  await expect(nested).rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  expect(graph.saveBarrier.snapshot().failures).toEqual([])
})

it('refuses a reset to a value omitted from the exact approved finite set', async () => {
  const narrow: ApprovedConfigurationCatalog = { ...catalog,
    fields: [{ namespace: 'agent-loop', field: 'maxParallelToolCalls', values: [1, 2] }] }
  const f = policyFixture([writer], bounds, 'loop-unapproved-reset', undefined, narrow, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  if (initial === undefined) throw new Error('The original AgentLoop settings namespace is absent')
  await graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial.revision)
  const current = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  await expect(graph.invokeSettings('agent-loop', [{ op: 'unset', path: ['maxParallelToolCalls'] }], current?.revision))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2)
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('does not turn an unrestricted AgentLoop declaration into write authority', async () => {
  const unrestricted: ApprovedConfigurationCatalog = { ...catalog,
    fields: [{ namespace: 'agent-loop', field: 'maxParallelToolCalls' }] }
  const f = policyFixture([writer], bounds, 'loop-unrestricted', undefined, unrestricted, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
  await expect(graph.invokeSettings('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], initial?.revision))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('keeps finite-value resets closed for a different native settings namespace', async () => {
  const both: ApprovedConfigurationCatalog = { ...catalog, fields: [...catalog.fields,
    { namespace: 'locale', field: 'preference', values: ['zh', 'en'] }] }
  const f = policyFixture([writer], bounds, 'loop-other-reset', undefined, both, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const locale = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'locale')
  await expect(graph.invokeSettings('locale', [{ op: 'unset', path: ['preference'] }], locale?.revision))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('continues to write an approved native subagent field through the ordinary account policy transaction', async () => {
  const other: ApprovedConfigurationCatalog = { ...catalog,
    fields: [{ namespace: 'subagents', field: 'maxActiveSubagents', values: [1, 2, 3] }] }
  const f = policyFixture([writer], bounds, 'loop-other-subagents', undefined, other, await sourceSettingsManifest(),
    () => { throw new Error('This settings test does not create a child') })
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const initial = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'subagents')
  if (initial === undefined) throw new Error('The original subagent settings namespace is absent')
  await expect(graph.invokeSettings('subagents', [{ op: 'set', path: ['maxActiveSubagents'], value: 2 }], initial.revision))
    .resolves.toMatchObject({ ns: 'subagents', value: { maxActiveSubagents: 2 } })
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('does not allow an account settings transaction to be replayed after its operation settles', async () => {
  const f = policyFixture([writer], bounds, 'loop-transaction-once', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const begin = graph.guards.beginSettingsUpdate
  if (begin === undefined) throw new Error('Original account policy transaction is absent')
  const transaction = begin('agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], catalog.fields)
  await expect(transaction.run(async () => 'first')).resolves.toBe('first')
  await expect(transaction.run(async () => 'replayed')).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
})

it('rejects outside business while an active loop transaction has not yet changed native state', async () => {
  const f = policyFixture([writer], bounds, 'loop-pending-before-write', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const outside = new AsyncResource('outside-unmodified-loop')
  onTestFinished(() => { outside.emitDestroy() })
  const transaction = graph.guards.beginSettingsUpdate('agent-loop',
    [{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }], catalog.fields)
  const gate = Promise.withResolvers<undefined>()
  const running = transaction.run(async () => { await gate.promise })
  expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  outside.runInAsyncScope(() => {
    expect(() => graph.guards.allowedModel('local-text', 'plain-text'))
      .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  })
  gate.resolve(undefined)
  await running
  outside.runInAsyncScope(() => { expect(graph.guards.allowedModel('local-text', 'plain-text')).toBe(true) })
})

it('connects the unmodified native AgentLoop controller save and reset to the original Cloud settings writer', async () => {
  const f = policyFixture([writer], bounds, 'loop-native-card', undefined, catalog, await sourceSettingsManifest())
  const graph = await f.start()
  await graph.guards.assertBootstrapCurrent(graph.lifetime.signal)
  const listeners = new Set<() => void>()
  const read = (): SettingsFormScopeSnapshot<AgentLoopSettings> => {
    const view = graph.ctx.settingsController.describe().namespaces.find(row => row.ns === 'agent-loop')
    if (view === undefined) throw new Error('Original AgentLoop settings view is absent')
    return { status: 'ready', writable: true, value: view.value as AgentLoopSettings,
      base: view.base, user: view.user, revision: view.revision }
  }
  const mutate = vi.fn(async (ops: readonly SettingsFormPathOp[], revision?: number) => {
    await graph.invokeSettings('agent-loop', ops, revision)
    for (const listener of listeners) listener()
    return true
  })
  const controller = new AgentLoopCardController({ getSnapshot: read, mutate,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  const face = controller.inject()
  face.edit('maxParallelToolCalls', '2'); face.save()
  await vi.waitFor(() => { expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(2) })
  expect(mutate.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['maxParallelToolCalls'], value: 2 }])
  await vi.waitFor(() => { expect(face.hooks.agentLoopCard.getSnapshot().saving).toBe(false) })
  face.resetField('maxParallelToolCalls'); face.save()
  await vi.waitFor(() => { expect(graph.ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10) })
  expect(mutate.mock.calls[1]?.[0]).toEqual([{ op: 'unset', path: ['maxParallelToolCalls'] }])
  await expect(mutate.mock.results[1]?.value).resolves.toBe(true)
  await expect(graph.guards.assertBootstrapCurrent(graph.lifetime.signal)).resolves.toBeUndefined()
  controller.dispose()
})
