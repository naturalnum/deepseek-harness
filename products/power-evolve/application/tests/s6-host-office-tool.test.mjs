/** Built Host face: OfficeCLI uses the selected target's execution seam as one guarded command. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  encodeOfficeCommand, installOfficeTool, OfficeCommandError, parseOfficeCommand,
} from '../lib/host/office.js'
import { installExecutionTools } from '../lib/host/executions.js'

function agentTools() {
  const registered = []
  const agent = { ctx: {
    tools: { register(value) { registered.push(value); return () => {} } },
    effect(start) { start() },
  } }
  return { agent, registered }
}

test('guide commands print runtime constraints before invoking the unchanged upstream guide', () => {
  for (const request of ['load_skill', 'load_skill word', 'load_skill excel', 'load_skill pptx']) {
    const command = encodeOfficeCommand(request)
    const separator = command.indexOf(' && ')
    assert(separator > 0)
    const prefix = execFileSync('/bin/sh', ['-c', command.slice(0, separator)], { encoding: 'utf8' })
    assert.match(prefix, /^\[PowerEvolve Office runtime constraint\]/u)
    assert.match(prefix, /skip its open\/edit\/save lifecycle/u)
    assert.match(prefix, /Replace guide variables such as \$FILE with the actual path/u)
    assert(prefix.endsWith('\n\n'))
    assert.match(command.slice(separator + 4), /^'\/usr\/bin\/env' '--' /u)
  }
})

test('parser confines OfficeCLI argv and quotes shell characters as literals', () => {
  assert.deepEqual(parseOfficeCommand(String.raw`officecli set book.xlsx '/Sheet1/A1' --prop 'value=$(id); $50'`),
    ['set', 'book.xlsx', '/Sheet1/A1', '--prop', 'value=$(id); $50'])
  assert.equal(encodeOfficeCommand('create "中文 report.docx"'), [
    "'/usr/bin/env'", "'--'", "'OFFICECLI_NO_AUTO_RESIDENT=1'",
    "'OFFICECLI_RESIDENT_FLUSH=each'", "'OFFICECLI_SKIP_UPDATE=1'",
    "'/usr/local/bin/officecli'", "'create'", "'中文 report.docx'",
  ].join(' '))
  assert.match(encodeOfficeCommand(`set book.xlsx /Sheet1/A1 --prop "value=O'Neil; $(id)"`),
    /'value=O'"'"'Neil; \$\(id\)'$/u)
  for (const command of [
    '', 'install', 'mcp register claude', 'plugins install sample',
    'open report.docx', 'create ../outside.xlsx', 'view /home/agent/private.docx text',
    'batch deck.pptx --input /tmp/commands.json', 'view deck.pptx screenshot --out /tmp/render',
    'view deck.pptx screenshot', 'view deck.pptx html --browser',
    'view deck.pptx html --browser=true', 'import book.xlsx /Sheet1 --stdin',
    'import book.xlsx /Sheet1 --file=/tmp/input', 'merge template.docx report.docx --data /etc/secret',
    'add deck.pptx /slide[1] --prop image=/etc/secret.png',
    'add deck.pptx /slide[1] --prop=image=/etc/secret.png',
    'load_skill financial-model', 'load_skill word --path ../internal.md',
    `batch deck.pptx --commands '${JSON.stringify([{
      command: 'add', props: { source: '/etc/secret.png' },
    }])}'`,
    'set book.xlsx /Sheet1/A1 "unfinished',
    'create report.docx\nwhoami',
  ]) assert.throws(() => parseOfficeCommand(command), OfficeCommandError, command)
  assert.deepEqual(parseOfficeCommand('get /workspace/report.docx "/body/p[1]"'),
    ['get', '/workspace/report.docx', '/body/p[1]'])
  assert.deepEqual(parseOfficeCommand('load_skill pptx --path reference/decision-rules.md'),
    ['load_skill', 'pptx', '--path', 'reference/decision-rules.md'])
  assert.deepEqual(parseOfficeCommand('view deck.pptx screenshot --out=renders/deck.png'),
    ['view', 'deck.pptx', 'screenshot', '--out=renders/deck.png'])
  assert.throws(() => parseOfficeCommand(`help ${'a '.repeat(256)}`), OfficeCommandError)
  assert.throws(() => parseOfficeCommand(`help ${'a'.repeat(16_385)}`), OfficeCommandError)
  assert.throws(() => parseOfficeCommand('batch deck.pptx --commands invalid-json'), OfficeCommandError)
  assert.throws(() => parseOfficeCommand('import book.xlsx /Sheet1 --file'), OfficeCommandError)
})

test('Desktop grants install office independently of the Cloud execution flag', () => {
  const runtime = { async call() { throw Error('unexpected proposal') } }
  for (const grant of [
    { target: { kind: 'cloud' }, executionEnabled: false, token: 'token' },
  ]) {
    const { agent, registered } = agentTools()
    installOfficeTool(agent, grant, runtime)
    assert.equal(registered.length, 0)
  }
  for (const grant of [
    { target: { kind: 'cloud' }, executionEnabled: true, token: 'token' },
    { target: { kind: 'desktop' }, executionEnabled: false, token: 'token' },
    { target: { kind: 'desktop' }, executionEnabled: true, token: 'token' },
  ]) {
    const { agent, registered } = agentTools()
    installOfficeTool(agent, grant, runtime)
    assert.deepEqual(registered.map(tool => tool.name), ['office'])
    assert.deepEqual(registered[0].parameters.required, ['command'])
    assert.deepEqual(Object.keys(registered[0].parameters.properties), ['command'])
    assert.match(registered[0].description, /resident state does not survive calls/u)
    assert.match(registered[0].description, /receipt means the command was accepted, not completed/u)
  }
})

test('native Office and execution tools forward call IDs to the selected target and return acceptance only', async t => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  let ctx
  await root.inject(['tools', 'systemPrompt'], ready => { ctx = ready })
  for (const kind of ['cloud', 'desktop']) await t.test(kind, async () => {
    const executionId = randomUUID()
    const receipt = { executionId, state: 'queued', command: 'recorded command', cwd: '', exitCode: 0 }
    const calls = []
    const runtime = { async call(path, token, body) {
      calls.push({ path, token, body })
      return receipt
    } }
    const id = SessionId(randomUUID())
    const agent = { id, session: Session.create(id), ctx: undefined }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const grant = { target: { kind }, executionEnabled: kind === 'cloud', token: 'grant-token' }
    installOfficeTool(agent, grant, runtime)
    installExecutionTools(agent, grant, runtime)
    const signal = new AbortController().signal
    const result = await ctx.tools.execute({ agent, signal, name: 'office',
      arguments: { command: 'create "中文 report.docx"' }, callId: ToolCallId('native-42') })
    assert.equal(result.isError, false)
    const value = JSON.parse(result.content[0].text)
    const path = kind === 'desktop' ? '/runtime/desktop-executions/propose' : '/runtime/executions/propose'
    assert.deepEqual(calls, [{ path, token: 'grant-token', body: {
      callId: 'native-42', command: encodeOfficeCommand('create "中文 report.docx"'), cwd: '',
    } }])
    assert.deepEqual(value, { executionId, state: 'queued', command: 'recorded command', cwd: '' })
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(value) }])
    assert.equal('exitCode' in value, false)
    const execution = await ctx.tools.execute({ agent, signal, name: `${kind}_exec`,
      arguments: { command: 'printf accepted', cwd: 'reports' }, callId: ToolCallId('native-exec-43') })
    assert.equal(execution.isError, false)
    assert.deepEqual(calls[1], { path, token: 'grant-token', body: {
      callId: 'native-exec-43', command: 'printf accepted', cwd: 'reports',
    } })
    assert.deepEqual(JSON.parse(execution.content[0].text), value)
    const refused = await ctx.tools.execute({ agent, signal, name: 'office',
      arguments: { command: 'open report.docx' }, callId: ToolCallId('native-refused-44') })
    assert.equal(refused.isError, true)
    assert.match(JSON.stringify(refused.content), /OfficeCLI open is unavailable/u)
    assert.equal(calls.length, 2)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    assert.match(assembly.sections.find(section => section.name === 'power-evolve:execution-continuation').text,
      /Never claim a test passed from an acceptance receipt/u)
    const description = assembly.tools.find(tool => tool.name === `${kind}_exec`).description
    if (kind === 'desktop') {
      assert.match(description, /\/home\/agent/u)
      assert.match(description, /read-only.*\/opt\/power-evolve\/skills\/sha256/u)
      assert.doesNotMatch(description, /only that directory mounted/u)
    }
    await scope.dispose()
  })
})

test('oversized encoded commands and parser errors are rejected before proposal', async () => {
  const calls = []
  const runtime = { async call(...args) { calls.push(args) } }
  const { agent, registered } = agentTools()
  installOfficeTool(agent, { target: { kind: 'cloud' }, executionEnabled: true, token: 'token' }, runtime)
  const tool = registered[0]
  await assert.rejects(tool.execute({ command: 'open report.docx' }, { callId: 'one' }), OfficeCommandError)
  const prefixLength = encodeOfficeCommand('help a').length - 1
  const atLimit = `help ${'a'.repeat(8192 - prefixLength)}`
  assert.equal(encodeOfficeCommand(atLimit).length, 8192)
  await assert.rejects(tool.execute({ command: `${atLimit}a` }, { callId: 'two' }),
    /Encoded OfficeCLI command exceeds 8192 characters/u)
  assert.equal(calls.length, 0)
})

test('platform errors and malformed receipts propagate without a success result', async () => {
  let response = new Error('proposal failed')
  const runtime = { async call() {
    if (response instanceof Error) throw response
    return response
  } }
  const { agent, registered } = agentTools()
  installOfficeTool(agent, { target: { kind: 'cloud' }, executionEnabled: true, token: 'token' }, runtime)
  const invoke = () => registered[0].execute({ command: 'get report.docx /body' }, { callId: 'native' })
  await assert.rejects(invoke(), /proposal failed/u)
  response = { executionId: 'invalid', state: 'queued', command: 'get', cwd: '' }
  await assert.rejects(invoke())
})
