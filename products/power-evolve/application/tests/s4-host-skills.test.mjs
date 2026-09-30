/** Native skill registry boundary for two concurrently leased Host Agents. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as nativeToolSkill from '@deepseek-ai/dsh-tool-skill'
import { installSelectedSkills, selectedSkillAliases } from '../lib/host/skills.js'

async function testContext() {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(AgentRegistry)
  await root.plugin(SkillRegistry)
  await root.plugin(nativeToolSkill)
  let selected
  await root.inject(['tools', 'skills', 'systemPrompt', 'agents'], ctx => { selected = ctx })
  return selected
}

function selection(name, instructions, fields = {}) {
  return { skillId: randomUUID(), name, description: `Description for ${name}`,
    digest: createHash('sha256').update(instructions).digest('hex'), revision: 1,
    kind: 'text', version: null, packageDigest: null, manifestDigest: null, ...fields }
}

function snapshot(item, instructions) {
  const { name, description, digest, revision, kind, version, packageDigest, manifestDigest } = item
  return { name, description, digest, revision, kind, version, packageDigest, manifestDigest, instructions }
}

function mount(ctx, scopeName, token, items, runtime) {
  const scope = createScope(ctx, { skillAgent: scopeName })
  const grant = { token, selection: items, skills: [] }
  installSelectedSkills({ ctx: scope.ctx }, grant, runtime)
  return { scope, grant, view: { scope: scopeOf(scope.ctx) } }
}

test('selected skill catalogs are Agent-scoped metadata; only get reads the selected body', async () => {
  const ctx = await testContext()
  const aliceSkill = selection('word', 'Alice body')
  const bobSkill = selection('中文 技能', 'Bob body')
  const calls = []
  const runtime = { async call(path, token, body) {
    calls.push({ path, token, body })
    if (token === 'alice-token' && body.skillId === aliceSkill.skillId) return snapshot(aliceSkill, 'Alice body')
    if (token === 'bob-token' && body.skillId === bobSkill.skillId) return snapshot(bobSkill, 'Bob body')
    throw new Error('wrong owner')
  } }
  const alice = mount(ctx, 'alice', 'alice-token', [aliceSkill], runtime)
  const bob = mount(ctx, 'bob', 'bob-token', [bobSkill], runtime)
  const bobAlias = `pe-user-skill-${bobSkill.skillId}`
  assert.deepEqual((await ctx.skills.list(alice.view)).map(item => item.name), ['word'])
  assert.deepEqual((await ctx.skills.list(bob.view)).map(item => [item.name, item.description]),
    [[bobAlias, `中文 技能: ${bobSkill.description}`]])
  assert.deepEqual(calls, [])
  assert.equal(await ctx.skills.get(bobAlias, alice.view), undefined)
  assert.equal(await ctx.skills.get('word', bob.view), undefined)
  assert.deepEqual(calls, [])
  assert.equal((await ctx.skills.get('word', alice.view)).content, 'Alice body')
  const loaded = await ctx.skills.get(bobAlias, bob.view)
  assert.equal(loaded.content, 'Bob body')
  assert.match(renderSkillContent(loaded), /<skill_content name="pe-user-skill-/)
  assert.deepEqual(calls, [
    { path: '/runtime/skills/read', token: 'alice-token', body: { skillId: aliceSkill.skillId } },
    { path: '/runtime/skills/read', token: 'bob-token', body: { skillId: bobSkill.skillId } },
  ])
  await alice.scope.dispose()
  assert.deepEqual(await ctx.skills.list(alice.view), [])
  assert.equal(await ctx.skills.get('word', alice.view), undefined)
  assert.deepEqual((await ctx.skills.list(bob.view)).map(item => item.name), [bobAlias])
  await bob.scope.dispose()
})

test('package path is only a cloud resource hint and retained package is read through Platform', async () => {
  const ctx = await testContext()
  const packageDigest = 'a'.repeat(64)
  const packageSkill = selection('build-assets', 'Package body', { kind: 'package', version: '1.0.0',
    packageDigest, manifestDigest: 'b'.repeat(64) })
  const calls = []
  const runtime = { async call(path, token, body) {
    calls.push({ path, token, body })
    return snapshot(packageSkill, 'Package body')
  } }
  const owner = mount(ctx, 'package-owner', 'package-token', [packageSkill], runtime)
  const listed = await ctx.skills.list(owner.view)
  assert.equal(listed[0].path, undefined)
  assert.equal(listed[0].resourceBase.kind, 'opaque')
  assert.match(listed[0].resourceBase.description, new RegExp(`/opt/power-evolve/skills/sha256/${packageDigest}/skill`))
  assert.equal(calls.length, 0)
  const loaded = await ctx.skills.get('build-assets', owner.view)
  assert.match(renderSkillContent(loaded), /authorized cloud Sandbox path/)
  assert.equal(calls.length, 1)
  await owner.scope.dispose()
})

test('native aliases preserve unique /word names and prevent legacy or duplicate collisions', () => {
  const word = selection('word', 'One')
  const duplicateA = selection('same-name', 'Two')
  const duplicateB = selection('same-name', 'Three')
  const legacy = selection('我的 技能', 'Four')
  const reserved = selection('pe-user-skill-custom', 'Five')
  const items = [word, duplicateA, duplicateB, legacy, reserved]
  const aliases = selectedSkillAliases(items)
  assert.equal(aliases.get(word.skillId), 'word')
  for (const item of items.slice(1)) assert.equal(aliases.get(item.skillId), `pe-user-skill-${item.skillId}`)
  assert.equal(new Set(aliases.values()).size, items.length)
  assert.deepEqual([...selectedSkillAliases(items).values()], [...aliases.values()])
})

test('mismatched snapshots and revoked or expired grants fail closed', async () => {
  const ctx = await testContext()
  const item = selection('private-skill', 'Original body')
  let result = snapshot(item, 'Original body')
  const runtime = { async call(_path, token) {
    assert.equal(token, 'strict-token')
    if (result instanceof Error) throw result
    return result
  } }
  const owner = mount(ctx, 'strict', 'strict-token', [item], runtime)
  owner.grant.selection[0] = { ...item, name: 'changed-after-admission' }
  owner.grant.token = 'changed-token'
  assert.deepEqual((await ctx.skills.list(owner.view)).map(skill => skill.name), ['private-skill'])
  assert.equal((await ctx.skills.get('private-skill', owner.view)).content, 'Original body')
  const altered = [
    { ...snapshot(item, 'Original body'), description: 'Other user' },
    { ...snapshot(item, 'Original body'), revision: 2 },
    { ...snapshot(item, 'Other body') },
    { ...snapshot(item, 'Original body'), packageDigest: 'c'.repeat(64) },
    { ...snapshot(item, 'Original body'), extra: 'malformed response' },
  ]
  for (result of altered) await assert.rejects(ctx.skills.get('private-skill', owner.view))
  for (result of [new Error('skill_revoked'), new Error('lease_lost')]) {
    await assert.rejects(ctx.skills.get('private-skill', owner.view), result)
  }
  await owner.scope.dispose()
  assert.equal(await ctx.skills.get('private-skill', owner.view), undefined)
})

test('native skill tool publishes a durable metadata-only catalog and renders on-demand body', async () => {
  const ctx = await testContext()
  const item = selection('word', 'Read this only on demand')
  const calls = []
  const runtime = { async call(path, token, body) {
    calls.push({ path, token, body })
    if (path === '/runtime/skills/resource') return { kind: 'text', path: 'SKILL.md',
      text: 'Read this only on demand', sha256: item.digest }
    return snapshot(item, 'Read this only on demand')
  } }
  const id = SessionId(randomUUID())
  const agent = { id, session: Session.create(id), ctx: undefined }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  installSelectedSkills(agent, { token: 'native-token', selection: [item], skills: [] }, runtime)
  assert.equal(ctx.tools.schemas().some(tool => tool.name === 'skill'), true)
  assert.equal(ctx.tools.get('skill', agent)?.name, 'skill')
  assert.deepEqual((await ctx.skills.list({ scope: agent })).map(skill => skill.name), ['word'])
  const signal = new AbortController().signal
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step',
    { messages: [], turn: 1, step: 1, signal }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'enter')
  for (const message of decision.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  const catalog = agent.session.snapshotEvents().find(event => event.type === 'user/message'
    && event.data.source.kind === 'skill-catalog')
  assert.deepEqual(catalog.data.source.entries, [{ name: 'word', description: item.description }])
  assert.doesNotMatch(JSON.stringify(catalog), /Read this only on demand/)
  assert.equal(calls.length, 0)
  const loaded = await ctx.tools.execute({ signal, callId: ToolCallId('skill-call-1'),
    name: 'skill', arguments: { name: 'word' }, agent })
  assert.equal(loaded.isError, false)
  assert.match(loaded.content[0].text, /<skill_content name="word">/)
  assert.match(loaded.content[0].text, /Read this only on demand/)
  assert.deepEqual(calls, [{ path: '/runtime/skills/read', token: 'native-token',
    body: { skillId: item.skillId } }])
  const direct = createUserMessage({ content: [{ type: 'text', text: '/word Explain the skill.' }],
    source: { kind: 'user' } })
  const invoked = await agentEvents(ctx, agent).waterfall('agent/pre-step',
    { messages: [direct], turn: 2, step: 1, signal },
    () => Promise.resolve({ kind: 'enter', messages: [direct] }))
  assert.equal(invoked.kind, 'enter')
  for (const message of invoked.messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  const invocation = agent.session.snapshotEvents().find(event => event.type === 'user/message'
    && event.data.source.kind === 'skill-invocation')
  assert.deepEqual(invocation.data.source, { kind: 'skill-invocation', name: 'word', form: 'instructions' })
  assert.match(invocation.data.content[0].text, /Read this only on demand/)
  assert.equal(calls.length, 2)
  const resource = await ctx.tools.execute({ signal, callId: ToolCallId('resource-call-1'),
    name: 'skill_resource', arguments: { name: 'word', path: 'SKILL.md' }, agent })
  assert.equal(resource.isError, false)
  assert.equal(JSON.parse(resource.content[0].text).text, 'Read this only on demand')
  assert.deepEqual(calls.at(-1), { path: '/runtime/skills/resource', token: 'native-token',
    body: { skillId: item.skillId, path: 'SKILL.md' } })
  const foreign = await ctx.tools.execute({ signal, callId: ToolCallId('resource-call-2'),
    name: 'skill_resource', arguments: { name: 'unselected-skill', path: 'SKILL.md' }, agent })
  assert.equal(foreign.isError, true)
  assert.equal(calls.length, 3)
  await scope.dispose()
  assert.equal(ctx.tools.get('skill_resource', agent), undefined)
})

test('report suite paths must be the exact named package under an immutable suite', async () => {
  const ctx = await testContext()
  const item = selection('report-reviewer', 'Review report', { kind: 'package', version: '1.1.0',
    packageDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) })
  let runtimePath = `/opt/power-evolve/skills/report-suites/${'c'.repeat(64)}/report-reviewer`
  let suiteAvailable = true
  const runtime = { async call() { return { ...snapshot(item, 'Review report'), runtimePath, suiteAvailable } } }
  const owner = mount(ctx, 'report-owner', 'report-token', [item], runtime)
  assert.match(renderSkillContent(await ctx.skills.get(item.name, owner.view)), /report-suites\/c{64}\/report-reviewer/)
  suiteAvailable = false
  await assert.rejects(ctx.skills.get(item.name, owner.view), /runtime path/)
  suiteAvailable = true
  for (runtimePath of ['/tmp/host-file', `/opt/power-evolve/skills/report-suites/${'c'.repeat(64)}/tech-report-writer`,
    `/opt/power-evolve/skills/report-suites/${'c'.repeat(64)}/../report-reviewer`]) {
    await assert.rejects(ctx.skills.get(item.name, owner.view), /runtime path/)
  }
  await owner.scope.dispose()
})
