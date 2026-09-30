/** OfficeCLI is proposed through the cloud execution seam as one guarded command. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import {
  encodeOfficeCommand, installOfficeTool, OfficeCommandError, parseOfficeCommand,
} from '../lib/host/office.js'

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

test('only an execution-enabled cloud grant installs one office tool', () => {
  const runtime = { async call() { throw Error('unexpected proposal') } }
  for (const grant of [
    { target: { kind: 'cloud' }, executionEnabled: false, token: 'token' },
    { target: { kind: 'desktop' }, executionEnabled: true, token: 'token' },
  ]) {
    const { agent, registered } = agentTools()
    installOfficeTool(agent, grant, runtime)
    assert.equal(registered.length, 0)
  }
  const { agent, registered } = agentTools()
  installOfficeTool(agent, { target: { kind: 'cloud' }, executionEnabled: true, token: 'token' }, runtime)
  assert.deepEqual(registered.map(tool => tool.name), ['office'])
  assert.deepEqual(registered[0].parameters.required, ['command'])
  assert.deepEqual(Object.keys(registered[0].parameters.properties), ['command'])
  assert.match(registered[0].description, /resident state does not survive calls/u)
  assert.match(registered[0].description, /receipt means the command was accepted, not completed/u)
})

test('office forwards native call ID and returns only the durable acceptance receipt', async () => {
  const executionId = randomUUID()
  const receipt = { executionId, state: 'queued', command: 'recorded command', cwd: '', exitCode: 0 }
  const calls = []
  const runtime = { async call(path, token, body) {
    calls.push({ path, token, body })
    return receipt
  } }
  const { agent, registered } = agentTools()
  installOfficeTool(agent, { target: { kind: 'cloud' }, executionEnabled: true, token: 'grant-token' }, runtime)
  const value = await registered[0].execute({ command: 'create "中文 report.docx"' }, { callId: 'native-42' })
  assert.deepEqual(calls, [{ path: '/runtime/executions/propose', token: 'grant-token', body: {
    callId: 'native-42', command: encodeOfficeCommand('create "中文 report.docx"'), cwd: '',
  } }])
  assert.deepEqual(value, { executionId, state: 'queued', command: 'recorded command', cwd: '' })
  assert.deepEqual(registered[0].output.render({}, value),
    [{ type: 'text', text: JSON.stringify(value) }])
  assert.equal('exitCode' in value, false)
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
