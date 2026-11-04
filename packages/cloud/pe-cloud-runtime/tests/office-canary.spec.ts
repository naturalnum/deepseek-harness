/** Actual Native Loader/providers/tool and model dispatch; no image or production AccountFactory qualification. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import * as Office from '@deepseek-ai/dsh-skill-office'
import * as Reports from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AccountId } from '../src/types.ts'
import { accountPresetConfigDigest } from '../src/account-policy.ts'
import { selectOfficeProfile } from '../src/office-profile.ts'
import { rootConfig } from './root-control-fixture.ts'
import { policyFixture } from './account-policy-fixture.ts'
import NativeAccountProbe from './fixtures/native-probe.ts'

const assets = fileURLToPath(new URL('../../../skill/skill-office/assets/', import.meta.url))
const ordinaryOffice = { assetRoot: assets, packagedBundles: true, cli: false,
  invocation: { modelInvocable: false, userInvocable: false } }
const ordinaryReports = { providerName: 'dsh-reports', includeDefaultRoots: false, watch: false,
  bundledSkillDir: assets + 'reports', packagedBundles: true,
  bundledInvocation: { modelInvocable: false, userInvocable: false }, bundledInstructions: 'Not qualified.' }
const { cli: _cli, ...retainedOffice } = ordinaryOffice
const office = { ...retainedOffice, invocation: { modelInvocable: true, userInvocable: true },
  executionRoot: '/opt/dsh/skills/office', systemTools: {
    soffice: '/usr/bin/soffice', pdftoppm: '/usr/bin/pdftoppm', wordRefresh: '/opt/dsh/bin/word-refresh' } }
const reports = { ...ordinaryReports, bundledInvocation: { modelInvocable: true, userInvocable: true },
  bundledExecutionRoot: '/opt/dsh/skills/reports', bundledInstructions: 'Run only installed Linux Guest tools.' }
function deployment() {
  const config = rootConfig('/root-only-fixture')
  return { ...config, native: { ...config.native, maxEntries: 512 }, accountPolicy: { ...config.accountPolicy, maxPresetConfigBytes: 8192 },
    officeCanary: { accountId: brandString<AccountId>('office-canary'),
      office: { baselineConfigSha256: accountPresetConfigDigest(ordinaryOffice, 8192), configJson: JSON.stringify(office) },
      reports: { baselineConfigSha256: accountPresetConfigDigest(ordinaryReports, 8192), configJson: JSON.stringify(reports) } } }
}
function fixture(accountId = 'office-canary', mutate?: (rows: { id: string; name: string; config: object }[]) => void) {
  const config = deployment(), selected = selectOfficeProfile(config, brandString<AccountId>(accountId))
  const base = [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: ordinaryOffice },
    { id: 'bundled-report-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: ordinaryReports }]
  mutate?.(base)
  const owner = policyFixture([], { maxHomeBytes: 4096, maxCollectionItems: 64, maxFrameBytes: 131072,
    maxQueuedEvents: 16, maxQueuedBytes: 262144 }, accountId, undefined, undefined, undefined, undefined, undefined, [], true, undefined, {
    defaultId: 'cloud-chat', declarations: [{ entryId: 'cloud-preset', config: { id: 'cloud-chat', plugins: [] }, selectable: true }],
    ...selected === undefined ? {} : { office: selected }, baseEntries: base,
    sourceModules: { '@deepseek-ai/dsh-skill': SkillRegistry, '@deepseek-ai/dsh-skill-office': Office,
      '@deepseek-ai/dsh-skill-filesystem': Reports, '@deepseek-ai/dsh-tool-skill': SkillTool, 'office:probe': { default: NativeAccountProbe } },
    extraEntries: [{ id: 'skills', name: '@deepseek-ai/dsh-skill' }, { id: 'skill-tool', name: '@deepseek-ai/dsh-tool-skill' },
      { id: 'office-probe', name: 'office:probe', config: { ordinary: 'original', count: 1 } }],
  })
  return { owner, selected, config }
}
async function session(graph: Awaited<ReturnType<ReturnType<typeof policyFixture>['start']>>) {
  const created = await graph.ctx.sessionController.create({})
  const agent = graph.ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('Original Native Agent missing')
  return agent
}
async function model(graph: Awaited<ReturnType<ReturnType<typeof policyFixture>['start']>>) {
  for await (const _ of graph.ctx.llm.stream({ provider: 'local-text', model: 'plain-text', messages: [] })) { /* Drain original stream. */ }
}
it('keeps absent selection unchanged and privately detaches the two canary configs', () => {
  const config = deployment(), { officeCanary: _omitted, ...ordinary } = config
  expect(selectOfficeProfile(ordinary, brandString<AccountId>('office-canary'))).toBeUndefined()
  const selected = selectOfficeProfile(config, brandString<AccountId>('office-canary'))
  config.officeCanary.office.configJson = '{}'
  expect(selected?.overlays).toHaveLength(2)
  expect(Object.isFrozen(selected?.overlays[0]?.config)).toBe(true)
  expect(selectOfficeProfile(deployment(), brandString<AccountId>('ordinary'))?.overlays).toEqual([])
})
it.each(['config-bytes', 'expression', 'relative-tool', 'cli-false', 'missing-refresh'] as const)('refuses Root %s before making a recipe', (bad) => {
  const config = deployment()
  const next = structuredClone(office) as Record<string, unknown>
  if (bad === 'config-bytes') config.accountPolicy.maxPresetConfigBytes = 1
  if (bad === 'expression') next.assetRoot = { __jsExpr: 'process.env.HOME' }
  if (bad === 'relative-tool') next.systemTools = { ...office.systemTools, soffice: 'soffice' }
  if (bad === 'cli-false') next.cli = false
  if (bad === 'missing-refresh') next.systemTools = { soffice: '/usr/bin/soffice', pdftoppm: '/usr/bin/pdftoppm' }
  config.officeCanary.office.configJson = JSON.stringify(next)
  expect(() => selectOfficeProfile(config, brandString<AccountId>('office-canary'))).toThrow()
})
it('uses the actual base file with two real providers, original skill tool and two independent account graphs', async () => {
  const a = fixture(), b = fixture('ordinary-office-account'), canary = await a.owner.start(), ordinary = await b.owner.start()
  const agent = await session(canary), other = await session(ordinary)
  expect((await canary.ctx.skills.list()).filter(row => row.invocation?.modelInvocable)).toHaveLength(13)
  expect((await ordinary.ctx.skills.list()).filter(row => row.invocation?.modelInvocable)).toHaveLength(0)
  const versions = async (graph: typeof canary) => (await graph.ctx.skills.inspect()).candidates
    .map(({ candidate }) => ({ name: candidate.name, version: candidate.package?.version }))
  expect(await versions(canary)).toEqual(await versions(ordinary))
  const call = (graph: typeof canary, scope: typeof agent) => graph.ctx.tools.execute({ agent: scope,
    signal: graph.lifetime.signal, callId: ToolCallId('real-native-skill'), name: 'skill', arguments: { name: 'office-docx' } })
  expect(await call(canary, agent)).toMatchObject({ isError: false, value: { provider: 'dsh-office', name: 'office-docx' } })
  expect(await call(ordinary, other)).toMatchObject({ isError: true })
  expect(await call(canary, other)).toMatchObject({ isError: true })
  await model(canary); expect(canary.adapter.calls).toBe(1)
})
it.each(['baseline-version', 'asset-change', 'module-change', 'duplicate', 'ordinary-enable'] as const)('refuses actual base+patch %s before a new Session is admitted', (bad) => {
  const f = fixture('office-canary', (rows) => {
    if (bad === 'baseline-version') rows[0]!.config = { ...ordinaryOffice, packagedBundles: false }
    if (bad === 'asset-change') rows[0]!.config = { ...ordinaryOffice, assetRoot: assets + 'changed' }
    if (bad === 'module-change') rows[0]!.name = '@deepseek-ai/dsh-skill-filesystem'
    if (bad === 'duplicate') rows.push({ ...rows[0]! })
    if (bad === 'ordinary-enable') rows[0]!.config = { ...ordinaryOffice, invocation: { modelInvocable: true, userInvocable: true } }
  })
  return expect(f.owner.start().then(graph => graph.guards.sessions.resolveCreate({}))).rejects.toThrow()
})
it.each(['skill-office', 'bundled-report-skills'])('withdraws original API/model/tool authority after Native entry update of %s', async (id) => {
  const f = fixture(), graph = await f.owner.start(), agent = await session(graph)
  await model(graph); const calls = graph.adapter.calls
  expect(graph.ctx.settingsController.describe()).toBeDefined()
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === id)
  if (entry === undefined) throw new Error('Original provider missing')
  await entry.update({ config: { ...entry.options.config as Record<string, unknown>, ...id === 'skill-office'
    ? { invocation: { modelInvocable: false, userInvocable: false } }
    : { bundledInvocation: { modelInvocable: false, userInvocable: false } } } })
  await graph.ctx.loader.await()
  await expect(graph.invoke('create', { requestId: 'stale-office' })).rejects.toThrow()
  expect(() => graph.ctx.settingsController.describe()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await expect(model(graph)).rejects.toThrow()
  const result = await graph.ctx.tools.execute({ agent, signal: graph.lifetime.signal,
    callId: ToolCallId('withdrawn-office'), name: 'skill', arguments: { name: 'office-docx' } })
  expect(result.isError).toBe(true); expect(graph.adapter.calls).toBe(calls)
})
it('preserves launch overlays through an unrelated actual ConfigEditor save and a cold new epoch, and rejects old scope', async () => {
  const f = fixture(), first = await f.owner.start(), old = await session(first)
  const profile = first.ctx.profileContext, entry = [...first.ctx.loader.entries()].find(row => row.options.id === 'office-probe')
  if (entry === undefined) throw new Error('Original unrelated edit target absent')
  await first.ctx.configEditor.edit(entry, value => ({ ...value, count: 2 }))
  expect(readFileSync(f.owner.patchPath, 'utf8')).toContain('count: 2')
  expect(first.ctx.profileContext.patchPath).toBe(profile.patchPath)
  const protectedEntry = [...first.ctx.loader.entries()].find(row => row.options.id === 'skill-office')
  if (protectedEntry === undefined) throw new Error('Original protected provider missing')
  await expect(first.ctx.configEditor.edit(protectedEntry, value => ({ ...value, cli: false }))).rejects.toThrow()
  await first.close()
  const second = await f.owner.start('2'), current = await session(second)
  expect(second.binding.accountId).toBe(first.binding.accountId); expect(second.binding.epoch).not.toBe(first.binding.epoch)
  expect(second.ctx.profileContext.overlays).toEqual(profile.overlays)
  expect((await second.ctx.skills.list()).filter(row => row.invocation?.modelInvocable)).toHaveLength(13)
  expect(await second.ctx.tools.execute({ agent: old, signal: second.lifetime.signal, callId: ToolCallId('old-epoch'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: true })
  expect(await second.ctx.tools.execute({ agent: current, signal: second.lifetime.signal, callId: ToolCallId('new-epoch'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: false })
})

it.each(['disabled', 'withdrawn', 'module', 'invalid-entry', 'renamed'] as const)('withdraws generic authenticated API for exact provider %s changes', async (change) => {
  const f = fixture(), graph = await f.owner.start()
  await session(graph)
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === 'skill-office')
  if (entry?.fiber === undefined) throw new Error('Original provider absent')
  expect(graph.ctx.settingsController.describe()).toBeDefined()
  if (change === 'disabled') await entry.update({ disabled: true })
  if (change === 'withdrawn') await entry.fiber.dispose()
  if (change === 'module') await entry.update({ name: '@deepseek-ai/dsh-skill-filesystem' })
  if (change === 'renamed') await entry.update({ id: 'renamed-office-provider' })
  if (change === 'invalid-entry') await expect(entry.update({ config: { ...entry.options.config as Record<string, unknown>, invocation: 'invalid' } })).rejects.toThrow()
  expect(() => graph.ctx.settingsController.describe()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})

it('rejects original settings, model and tool consumers after a rejected Fiber update while the Session declaration remains available', async () => {
  const f = fixture(), graph = await f.owner.start(), agent = await session(graph)
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === 'skill-office')
  const fiber = entry?.fiber
  if (fiber === undefined) throw new Error('Original provider absent')
  expect(() =>{  fiber.update({ ...fiber.config as Record<string, unknown>, invocation: 'invalid' }, true) }).toThrow()
  expect(graph.api.requireRpc('session/create')).toMatchObject({ guard: 'account-project' })
  expect(() => graph.ctx.settingsController.describe()).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  await expect(model(graph)).rejects.toThrow()
  expect(await graph.ctx.tools.execute({ agent, signal: graph.lifetime.signal, callId: ToolCallId('invalid-fiber-gap'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: true })
})
