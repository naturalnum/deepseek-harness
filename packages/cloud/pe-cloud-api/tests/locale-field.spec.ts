/** Native Loader/Gateway locale writes with synthetic login admission and AccountUse. */
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { Config as SubagentConfig } from '@deepseek-ai/dsh-subagent'
import type { Config as LocaleHostConfig } from '@deepseek-ai/dsh-client-locale'
import { symbols } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { localeFixture } from './locale-field-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof fs>()
  return { ...native, rename: vi.fn(native.rename) }
})
beforeEach(async () => {
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename)
})
const edit = (value: string) => [{ op: 'set', path: ['preference'], value }]

it('persists zh and en through original Gateway, Controller, Settings and live ConfigEditor while retaining native owners', async () => {
  const a = await localeFixture(), b = await localeFixture('b')
  const root = a.ctx.root, editor = a.ctx.configEditor, settings = a.ctx.settings, credentials = a.ctx.credentials
  const skills = a.ctx.skills, api = a.ctx.peCloudApi
  const entry = [...a.ctx.loader.entries()].find(item => item.options.id === 'locale')!
  const fiber = entry.fiber
  const config: unknown = entry.fiber!.config
  const baseEntries = [...a.ctx.loader.entries()].filter(item => ['model-key-typert', 'model-key', 'skill-registry', 'account-skills', 'skill-tool'].includes(item.options.id))
  expect(baseEntries).toHaveLength(5)
  const baseFacts = baseEntries.map(item => ({ item, fiber: item.fiber, config: item.fiber!.config as object,
    options: JSON.stringify(item.options) }))
  const originalKey: unknown = Reflect.get(a.ctx.cloudModelKey, symbols.original)
  const originalSkills: unknown = Reflect.get(a.ctx.cloudSkills, symbols.original)
  const keyMetadata = a.ctx.cloudModelKey.inspect(), skillMetadata = a.ctx.cloudSkills.inspect()
  const rootBefore = readFileSync(a.configPath), otherBefore = readFileSync(b.profile.patchPath)
  const first = await a.call(edit('zh'), a.revision())
  expect(first).toMatchObject({ ns: 'locale', value: { preference: 'zh' } })
  expect(a.ctx.settingsController.describe()).toMatchObject({ writable: true, hasDocument: false })
  expect((entry.fiber!.config as LocaleHostConfig).preference.get()).toBe('zh')
  await a.call(edit('en'), a.revision())
  expect((entry.fiber!.config as LocaleHostConfig).preference.get()).toBe('en')
  for (const [current, before] of [[a.ctx.root, root], [a.ctx.configEditor, editor], [a.ctx.settings, settings],
    [a.ctx.credentials, credentials], [a.ctx.skills, skills], [a.ctx.peCloudApi, api]]) {
    expect((Reflect.get(current!, symbols.original) ?? current) === (Reflect.get(before!, symbols.original) ?? before)).toBe(true)
  }
  expect(entry.fiber).toBe(fiber); expect(entry.fiber!.config).toBe(config)
  for (const fact of baseFacts) {
    expect(fact.item.fiber === fact.fiber).toBe(true)
    expect(fact.item.fiber!.config === fact.config).toBe(true)
    expect(JSON.stringify(fact.item.options)).toBe(fact.options)
  }
  expect(Reflect.get(a.ctx.cloudModelKey, symbols.original) === originalKey).toBe(true)
  expect(Reflect.get(a.ctx.cloudSkills, symbols.original) === originalSkills).toBe(true)
  expect(a.ctx.cloudModelKey.inspect()).toEqual(keyMetadata)
  expect(a.ctx.cloudSkills.inspect()).toEqual(skillMetadata)
  expect(a.ctx.peAccount === a.binding).toBe(true)
  expect(a.ctx.profileContext).toEqual(a.profile)
  expect(readFileSync(a.configPath)).toEqual(rootBefore)
  expect(readFileSync(b.profile.patchPath)).toEqual(otherBefore)
  expect(b.ctx.settingsController.describe().namespaces[0]!.value).toEqual({ preference: 'en' })
  expect(readFileSync(a.credentialPath)).toEqual(a.keyBefore)
  expect(await a.keyState()).toEqual(a.keyStateBefore)
  expect((await a.ctx.credentials.resolve(a.ref))?.value).toBe('synthetic-fixture-key')
  expect(readFileSync(a.skillPointer)).toEqual(a.sourceBefore)
  expect(a.barrier.snapshot().failures).toHaveLength(0)
})

it.each([
  ['unsupported value', edit('fr'), 0, {}],
  ['unset', [{ op: 'unset', path: ['preference'] }], 0, {}],
  ['nested path', [{ op: 'set', path: ['preference', 'other'], value: 'zh' }], 0, {}],
  ['extra edit', [...edit('zh'), ...edit('en')], 0, {}],
  ['missing revision', edit('zh'), undefined, {}],
  ['fractional revision', edit('zh'), 0.5, {}],
  ['negative revision', edit('zh'), -1, {}],
  ['extra wire field', edit('zh'), 0, { extraArgs: { accountId: 'forged' } }],
  ['extra operation field', [{ op: 'set', path: ['preference'], value: 'zh', unauthorized: true }], 0, {}],
  ['foreign namespace', edit('zh'), 0, { ns: 'model' }],
  ['forged Peer object', edit('zh'), 0, { forgedPeer: true }],
] as const)('rejects %s before native persistence and keeps following saves available', async (_name, ops, revision, options) => {
  const f = await localeFixture(), before = readFileSync(f.profile.patchPath)
  await expect(f.call(ops, revision, options)).rejects.toBeDefined()
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toHaveLength(0)
  expect(f.contained()).toBe(false)
  await f.call(edit('zh'), f.revision())
})

it('rejects alternate native writers and a foreign original AccountUse without saving', async () => {
  const f = await localeFixture(), before = readFileSync(f.profile.patchPath)
  for (const method of ['update', 'replace']) await expect(f.call(edit('zh'), f.revision(), { method })).rejects.toBeDefined()
  f.wrongUse(true)
  await expect(f.call(edit('zh'), f.revision())).rejects.toBeDefined()
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toHaveLength(0)
  f.wrongUse(false)
  await f.call(edit('zh'), f.revision())
})

it('settles a stale revision as a zero-write conflict and accepts a fresh revision', async () => {
  const f = await localeFixture(), stale = f.revision()
  await f.call(edit('zh'), stale)
  const before = readFileSync(f.profile.patchPath)
  await expect(f.call(edit('en'), stale)).rejects.toMatchObject({ code: 'settings/conflict' })
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toHaveLength(0)
  expect(f.contained()).toBe(false)
  await f.call(edit('en'), f.revision())
})

it('rechecks the original Peer after the original account save queue and leaves a revoked edit unwritten', async () => {
  const f = await localeFixture(), before = readFileSync(f.profile.patchPath)
  const entered = Promise.withResolvers<undefined>(), released = Promise.withResolvers<undefined>()
  onTestFinished(() => { released.resolve(undefined) })
  const held = f.barrier.admit('settings', async () => { entered.resolve(undefined); await released.promise })
  await entered.promise
  const pending = f.call(edit('zh'), f.revision())
  const observed = Promise.allSettled([pending])
  await f.accepted()
  expect(f.saves.snapshot()).toMatchObject({ running: 1, queued: 1 })
  f.revoke(); released.resolve(undefined); await held
  expect((await observed)[0].status).toBe('rejected')
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toHaveLength(0)
  expect(f.contained()).toBe(false)
  f.restore(); await f.call(edit('zh'), f.revision())
})

it('retains an unknown post-replacement result and invokes the original containment without replay', async () => {
  const f = await localeFixture(), before = readFileSync(f.profile.patchPath)
  const native = await vi.importActual<typeof fs>('node:fs/promises')
  let attempts = 0
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await native.rename(from, to)
    if (to === f.profile.patchPath) { attempts++; throw new Error('injected after actual atomic rename') }
  })
  await expect(f.call(edit('zh'), f.revision())).rejects.toBeDefined()
  expect(attempts).toBe(1)
  expect(readFileSync(f.profile.patchPath)).not.toEqual(before)
  expect(f.barrier.snapshot().failures[0]?.outcome).toBe('unknown')
  expect(f.contained()).toBe(true)
  expect((await f.api.stopConfigSaves(Date.now() + 1_000)).status).toBe('unknown')
  await expect(f.call(edit('en'), 0)).rejects.toBeDefined()
  expect(attempts).toBe(1)
})

it('preserves readonly first-screen defaults when the locale field is not enabled', async () => {
  const f = await localeFixture('readonly', false), before = readFileSync(f.profile.patchPath)
  expect(f.ctx.settingsController.describe()).toMatchObject({ writable: false, hasDocument: false })
  await expect(f.call(edit('zh'), f.revision())).rejects.toBeDefined()
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toHaveLength(0)
})


const genericFields = [{ namespace: 'subagent', field: 'maxActiveSubagents' }, { namespace: 'subagent', field: 'maxDepth' }]
it('uses one approved native form for generic volatile fields and retains the original runtime and save owners', async () => {
  const f = await localeFixture('generic', true, genericFields)
  const runtime = f.ctx.subagents, root = f.ctx.root, editor = f.ctx.configEditor, settings = f.ctx.settings
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'subagent')!
  const fiber = entry.fiber, config = entry.fiber!.config as SubagentConfig
  const before = readFileSync(f.profile.patchPath), base = readFileSync(f.configPath)
  const described = f.ctx.settingsController.describe()
  expect(described.namespaces.map(row => row.ns)).toEqual(['subagent'])
  expect(described.namespaces[0]!.value).toEqual({ maxActiveSubagents: 8, maxDepth: 1 })
  const changed = await f.call([{ op: 'set', path: ['maxActiveSubagents'], value: 3 }, { op: 'set', path: ['maxDepth'], value: 0 }], f.revision('subagent'), { ns: 'subagent' })
  expect(changed).toMatchObject({ ns: 'subagent', value: { maxActiveSubagents: 3, maxDepth: 0 } })
  expect(config.maxActiveSubagents.get()).toBe(3); expect(config.maxDepth.get()).toBe(0)
  expect(runtime.resolveMaxDepth()).toBe(0)
  expect(runtime.resolveMaxDepth(2)).toBe(2)
  expect(runtime.resolveMaxDepth('provider-managed')).toBeUndefined()
  expect(entry.fiber === fiber).toBe(true); expect(entry.fiber!.config === config).toBe(true)
  for (const [actual, previous] of [
    [f.ctx.subagents, runtime], [f.ctx.root, root], [f.ctx.configEditor, editor], [f.ctx.settings, settings],
  ]) {
    expect((Reflect.get(actual!, symbols.original) ?? actual) === (Reflect.get(previous!, symbols.original) ?? previous)).toBe(true)
  }
  expect(readFileSync(f.profile.patchPath)).not.toEqual(before)
  expect(readFileSync(f.configPath)).toEqual(base)
  expect(f.barrier.snapshot().failures).toEqual([])
  await f.call([{ op: 'unset', path: ['maxDepth'] }], f.revision('subagent'), { ns: 'subagent' })
  expect(config.maxDepth.get()).toBe(1)
})

it('keeps unapproved native leaves out of describe and mutation replies while rejecting invalid native values without saving', async () => {
  const f = await localeFixture('generic-narrow', true, [{ namespace: 'subagent', field: 'maxDepth' }])
  const before = readFileSync(f.profile.patchPath), revision = f.revision('subagent')
  const view = f.ctx.settingsController.describe().namespaces[0]!
  expect(view.value).toEqual({ maxDepth: 1 })
  expect(JSON.stringify(view.schema)).not.toContain('maxActiveSubagents')
  for (const ops of [
    [{ op: 'set', path: ['maxActiveSubagents'], value: 3 }],
    [{ op: 'set', path: ['maxDepth'], value: -1 }],
    [{ op: 'set', path: ['maxDepth'], value: 0.5 }],
    [{ op: 'set', path: ['maxDepth'], value: { nested: 0 } }],
  ]) await expect(f.call(ops, revision, { ns: 'subagent' })).rejects.toBeDefined()
  expect(readFileSync(f.profile.patchPath)).toEqual(before)
  expect(f.barrier.snapshot().failures).toEqual([])
  const reply = await f.call([{ op: 'set', path: ['maxDepth'], value: 0 }], revision, { ns: 'subagent' })
  expect(reply).toMatchObject({ value: { maxDepth: 0 } })
  expect(JSON.stringify(reply)).not.toContain('maxActiveSubagents')
})


it('applies an eight-to-three Settings save to following native admissions without stopping existing children', async () => {
  const f = await localeFixture('generic-capacity', true, genericFields)
  const gates = Array.from({ length: 9 }, () => Promise.withResolvers<undefined>())
  let next = 0
  class HeldModel extends LlmAdapter {
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      const gate = gates[next++]
      if (gate === undefined) throw new Error('Owned native capacity model exhausted')
      await gate.promise
      yield* textResponse('done')
    }
  }
  await f.ctx.plugin(AgentLoop, { agents: [] })
  await f.ctx.plugin(SubagentSpawn, { providerName: 'settings-proof' })
  f.ctx.llm.registerAdapter(['settings-proof'], new HeldModel())
  const parent = await f.ctx.agentLoop.create(SessionId('settings-capacity-parent'), { provider: 'settings-proof', model: 'synthetic' })
  // Native child settlement wakes the parent; this test supplies child model responses only.
  f.ctx.on('agent/pre-step', async ({ agent }, following) => agent === parent ? { kind: 'reject' as const } : following())
  const ids: SessionId[] = [], signal = new AbortController().signal
  const start = () => f.ctx.subagents.startActivation({ provider: 'settings-proof', label: 'settings capacity proof',
    request: { parent, prompt: [{ type: 'text', text: 'hold until released' }] }, signal, delivery: 'parent' })
  const count = () => ids.filter(id => f.ctx.agents.get(id) !== undefined).length
  try {
    for (let i = 0; i < 8; i++) ids.push((await start()).childId)
    await vi.waitFor(() => { expect(next).toBe(8) })
    await f.call([{ op: 'set', path: ['maxActiveSubagents'], value: 3 }], f.revision('subagent'), { ns: 'subagent' })
    expect(count()).toBe(8)
    gates[0]!.resolve(undefined)
    await vi.waitFor(() => { expect(count()).toBe(7) })
    await expect(start()).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
    for (const gate of gates.slice(1, 5)) gate.resolve(undefined)
    await vi.waitFor(() => { expect(count()).toBe(3) })
    await expect(start()).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
    gates[5]!.resolve(undefined)
    await vi.waitFor(() => { expect(count()).toBe(2) })
    ids.push((await start()).childId)
    expect(count()).toBe(3)
    await expect(start()).rejects.toMatchObject({ code: 'ACTIVATION_LIMIT_REACHED' })
  } finally {
    for (const gate of gates) gate.resolve(undefined)
    await vi.waitFor(() => { expect(count()).toBe(0) })
  }
})
