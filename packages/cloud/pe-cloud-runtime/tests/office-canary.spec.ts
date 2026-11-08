/** Actual Native Loader/providers/tool and model dispatch; no image or production AccountFactory qualification. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as SkillRegistry from '@deepseek-ai/dsh-skill'
import * as Office from '@deepseek-ai/dsh-skill-office'
import * as Reports from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { AccountId } from '../src/types.ts'
import { accountPresetConfigDigest } from '../src/account-policy.ts'
import { selectOfficeProfile } from '../src/office-profile.ts'
import { RuntimeRootConfigSchema } from '../src/root-config.ts'
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
function ordinaryDeployment() {
  const { officeCanary, ...config } = deployment()
  const { accountId: _canary, ...officeOrdinary } = officeCanary
  return { ...config, officeOrdinary }
}
function fixture(accountId = 'office-canary', mutate?: (rows: { id: string; name: string; config: object }[]) => void,
  mode: 'canary' | 'ordinary' = 'canary', scopedSkillTool = false) {
  const config = mode === 'ordinary' ? ordinaryDeployment() : deployment()
  const selected = selectOfficeProfile(config, brandString<AccountId>(accountId))
  const base = [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: ordinaryOffice },
    { id: 'bundled-report-skills', name: '@deepseek-ai/dsh-skill-filesystem', config: ordinaryReports }]
  mutate?.(base)
  const owner = policyFixture([], { maxHomeBytes: 4096, maxCollectionItems: 64, maxFrameBytes: 131072,
    maxQueuedEvents: 16, maxQueuedBytes: 262144 }, accountId, undefined, undefined, undefined, undefined, undefined, [], true, undefined, {
    defaultId: 'cloud-chat', declarations: [{ entryId: 'cloud-preset', config: { id: 'cloud-chat', plugins: scopedSkillTool
      ? [{ id: 'preset-skill-tool', name: '@deepseek-ai/dsh-tool-skill' }] : [] }, selectable: true }],
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
it('publishes the original Office catalog through a Loader-mounted preset beside the account skill tool', async () => {
  const f = fixture('ordinary-office-account', undefined, 'ordinary', true), graph = await f.owner.start()
  try {
    const agent = await session(graph)
    const cwd = await graph.ctx.workingDirectory.ensure(agent, graph.lifetime.signal)
    const snapshot = await graph.ctx.skills.snapshot({ scope: agent, cwd })
    expect(snapshot.complete).toBe(true)
    expect(snapshot.skills.filter(row => row.invocation.modelInvocable)).toHaveLength(13)
    expect(graph.ctx.tools.get('skill', agent)).not.toBe(graph.ctx.tools.get('skill'))
    agent.session.append('turn/start', { turn: 1 })
    const decision = await agentEvents(graph.ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: 1, signal: graph.lifetime.signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [] }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('Original Native step rejected')
    const catalog = decision.messages.filter(message => message.source.kind === 'skill-catalog')
    expect(catalog).toHaveLength(1)
    expect(JSON.stringify(catalog)).toContain('office-xlsx')
    for (const message of catalog) agent.session.append('user/message', message, { surfaceOp: 'append' })
    expect(agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'skill-catalog' ? [event.data.content] : [])).toMatchInlineSnapshot(`
        [
          [
            {
              "text": "<system-reminder>
        A skill is a reusable set of task-specific instructions. The following skills are available in this session:

        <available_skills>
        - \`latex-report-writer\`: Generate, revise, and validate Chinese electric-power technical reports in XeLaTeX. Use when a report must follow a retained Word template or technical-report specification while being produced as .tex and PDF, including checks for fonts, page geometry, cover, approval page, abstracts, contents, headings, figures, tables, equations, appendices, references, and page numbering.
        - \`office\`: Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Load to choose the relevant workflow.
        - \`office-docx\`: Create, read, edit, and validate Word documents (.docx).
        - \`office-export-pdf\`: Convert an Office document to a requested PDF with LibreOffice Kit.
        - \`office-pptx\`: Create, read, edit, and validate PowerPoint presentations (.pptx).
        - \`office-recalculate\`: Refresh spreadsheet formula caches and verify calculated values with LibreOffice Kit.
        - \`office-render\`: Render requested document images or inspect visual layout with LibreOffice Kit.
        - \`office-xlsx\`: Read, create, edit, and validate Excel workbooks, data, and formulas (.xlsx).
        - \`power-grid-technical-report-writer\`: 面向电网科技项目结题技术报告的渐进式写作 Skill。用于建立项目档案、确认论证架构与目录、制定章节计划、分章生成正文、维护摘要证据包并组装最终报告；支持基于已有内容和大模型自主生成两种模式，并与报告审核及 Word 排版子 Skill 协同工作。
        - \`report-reviewer\`: 审核报告目录、单章和全文，检查任务完成度、内容完整性、逻辑结构、证据引用、章节协同、术语一致性和中文长文表达，输出结构化审核结论。本 Skill 不直接重写正文。
        - \`report-workflow-orchestrator\`: 编排电网科技报告的项目档案、论证架构、目录、章节生成与审核、全文审核，以及最终 Word 排版、格式修复和逐页验收。所有子 Skill 名称和动作集中在配置区。
        - \`tech-report-writer\`: 编写、重排或校验中国电力科学研究院科技项目、咨询项目技术报告，基于任务书、研究资料、用户说明或已有 .docx，生成符合院技术报告管理办法的 Word 文件；用于新建完整技术报告、调整已有报告格式，以及校验封面、审批页、中英文摘要、目录、正文、附录、参考文献、页眉页脚和分节页码
        - \`technical-report-pre-review\`: 依据科技项目任务书、总技术报告及可选课题分报告开展前置审查，从可配置审稿人池中选取5种互补视角，生成兼顾任务书—报告总体判断与具体问题的可追溯Markdown审查稿，并套用既有Word汇总表模板；可在初审后吸收分报告证据形成盲审意见最终版。用于科技项目结题前、函审前或内部送审前的技术报告评阅；不用于代替项目组编造回复、伪造专家签名或无依据给出验收结论。
        </available_skills>

        If the user names a skill, or the task clearly matches a skill's description, call the \`skill\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
        A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the \`skill\` tool again for that skill.
        </system-reminder>",
              "type": "text",
            },
          ],
        ]
      `)
    expect(await graph.ctx.tools.execute({ agent, signal: graph.lifetime.signal,
      callId: ToolCallId('loader-preset-office'), name: 'skill', arguments: { name: 'office-xlsx' } })).toMatchObject({
      isError: false, value: { name: 'office-xlsx', provider: 'dsh-office', resourceBase: { path: '/opt/dsh/skills/office/office-xlsx' } },
    })
  } finally { await graph.close() }
})
it.each((['canary', 'ordinary'] as const).flatMap(mode =>
  (['baseline-version', 'asset-change', 'module-change', 'duplicate', 'ordinary-enable'] as const).map(bad => [mode, bad] as const),
))('refuses actual %s base+patch %s before a new Session is admitted', (mode, bad) => {
  const f = fixture('office-canary', (rows) => {
    if (bad === 'baseline-version') rows[0]!.config = { ...ordinaryOffice, packagedBundles: false }
    if (bad === 'asset-change') rows[0]!.config = { ...ordinaryOffice, assetRoot: assets + 'changed' }
    if (bad === 'module-change') rows[0]!.name = '@deepseek-ai/dsh-skill-filesystem'
    if (bad === 'duplicate') rows.push({ ...rows[0]! })
    if (bad === 'ordinary-enable') rows[0]!.config = { ...ordinaryOffice, invocation: { modelInvocable: true, userInvocable: true } }
  }, mode)
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

it('keeps Root omission unchanged, preserves the canary schema and rejects simultaneous or account-selected ordinary policies', () => {
  const plain = rootConfig('/root-only-fixture')
  expect(RuntimeRootConfigSchema(plain)).toEqual(plain)
  expect(RuntimeRootConfigSchema(deployment()).officeCanary).toEqual(deployment().officeCanary)
  const config = ordinaryDeployment()
  expect(RuntimeRootConfigSchema(config).officeOrdinary).toEqual(config.officeOrdinary)
  const both = { ...config, officeCanary: deployment().officeCanary }
  expect(() => RuntimeRootConfigSchema(both)).toThrow()
  expect(() => selectOfficeProfile(both, brandString<AccountId>('ordinary-A'))).toThrow()
  for (const officeOrdinary of [{ ...config.officeOrdinary, accountId: 'ordinary-A' },
    { ...config.officeOrdinary, extraProvider: {} },
    { ...config.officeOrdinary, office: { ...config.officeOrdinary.office, quota: 1 } }]) {
    expect(() => RuntimeRootConfigSchema({ ...config, officeOrdinary })).toThrow()
  }
})

it('selects the same original13 resources for two independent ordinary account graphs without a canary identity', async () => {
  const a = fixture('ordinary-A', undefined, 'ordinary'), b = fixture('ordinary-B', undefined, 'ordinary')
  const first = await a.owner.start(), second = await b.owner.start(), agent = await session(first), other = await session(second)
  expect(first.binding.accountId).not.toBe(second.binding.accountId)
  for (const graph of [first, second]) {
    expect((await graph.ctx.skills.list()).filter(row => row.invocation?.modelInvocable && row.invocation.userInvocable)).toHaveLength(13)
    await model(graph); expect(graph.adapter.calls).toBe(1)
  }
  expect(await first.ctx.tools.execute({ agent, signal: first.lifetime.signal, callId: ToolCallId('ordinary-own'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: false })
  expect(await first.ctx.tools.execute({ agent: other, signal: first.lifetime.signal, callId: ToolCallId('ordinary-other'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: true })
  expect((await first.ctx.skills.inspect()).candidates.map(row => row.candidate.package?.version))
    .toEqual((await second.ctx.skills.inspect()).candidates.map(row => row.candidate.package?.version))
})

it('overlays historical saved false provider rows through the original composition and rejects an old ordinary epoch', async () => {
  const f = fixture('ordinary-saved-false', undefined, 'ordinary'), first = await f.owner.start(), old = await session(first)
  await first.close()
  // Only this stopped fixture Profile is seeded; no production/private account file is read or migrated.
  const saved = JSON.parse(readFileSync(f.owner.patchPath, 'utf8')) as object[]
  saved.push({ id: 'skill-office', config: ordinaryOffice }, { id: 'bundled-report-skills', config: ordinaryReports })
  const bytes = JSON.stringify(saved)
  writeFileSync(f.owner.patchPath, bytes)
  const second = await f.owner.start('2'), current = await session(second)
  expect(readFileSync(f.owner.patchPath, 'utf8')).toBe(bytes)
  expect((await second.ctx.skills.list()).filter(row => row.invocation?.modelInvocable)).toHaveLength(13)
  expect(await second.ctx.tools.execute({ agent: current, signal: second.lifetime.signal, callId: ToolCallId('ordinary-saved'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: false })
  expect(await second.ctx.tools.execute({ agent: old, signal: second.lifetime.signal, callId: ToolCallId('ordinary-old'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: true })
})

it('retains the original ordinary provider plan and withdrawal checks for model, settings, tools and Session admission', async () => {
  const f = fixture('ordinary-revoked', undefined, 'ordinary'), graph = await f.owner.start(), agent = await session(graph)
  await model(graph); const calls = graph.adapter.calls
  const entry = [...graph.ctx.loader.entries()].find(row => row.options.id === 'skill-office')
  if (entry === undefined) throw Error('Original ordinary provider absent')
  await expect(graph.ctx.configEditor.edit(entry, value => ({ ...value, cli: false }))).rejects.toThrow()
  await entry.update({ config: { ...entry.options.config as Record<string, unknown>,
    invocation: { modelInvocable: false, userInvocable: false } } })
  await graph.ctx.loader.await()
  expect(() => graph.ctx.settingsController.describe()).toThrow()
  await expect(graph.invoke('create', { requestId: 'ordinary-revoked' })).rejects.toThrow()
  await expect(model(graph)).rejects.toThrow()
  expect(await graph.ctx.tools.execute({ agent, signal: graph.lifetime.signal, callId: ToolCallId('ordinary-revoked'),
    name: 'skill', arguments: { name: 'office-docx' } })).toMatchObject({ isError: true })
  expect(graph.adapter.calls).toBe(calls)
})
