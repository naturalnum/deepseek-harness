/** Product profile snapshot adapter: compare complete native records after volatile identity/clock normalization. */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { toHeaderLine } from '../../../../packages/session/session-persistence-jsonl/lib/types/format.js'
// Pure built leaves avoid the support package's Vitest-only suite entry in this Node adapter.
import { redactSessionSnapshotIds } from '../../../../packages/test-support/session-snapshot/lib/types/identity.js'
import { normalizeSessionLog, scrubSystemPrompts, scrubToolSchemas } from '../../../../packages/test-support/session-snapshot/lib/types/normalize.js'
import { sessionFixtureFiles } from '../../../../packages/test-support/session-snapshot/lib/types/session-files.js'
const directory = new URL('../../../../snapshots/power-evolve/conversation/', import.meta.url)
const canonical = new URL('session.v4.jsonl', directory)
const sshDirectory = new URL('../ssh-execute-continuation/', directory)
const sandboxDirectory = new URL('../sandbox-output-continuation/', directory)
const losslessDirectory = new URL('../lossless-output/', directory)
const record = process.env.PE_RECORD_SNAPSHOT === '1'
export async function recordedConversation() {
  const manifest = yaml.load(await readFile(new URL('snapshot.yml', directory), 'utf8'))
  assert.deepEqual(manifest, { version: 1, scenario: 'conversation', profile: 'power-evolve-host', composition: 'shared-host-platform-pg', recording: 'authored', header: { class: 'power-evolve-text', pin: true } })
  try {
    const rows = (await readFile(canonical,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    assert.equal(rows[0].version,4)
    return {
      input: rows.find(row=>row.type==='user/message').data.content[0].text,
      output: rows.find(row=>row.type==='assistant/message').data.message.content[0].text,
      rows,
    }
  } catch(error) {
    if (record && error.code==='ENOENT') return { input:'alpha',output:'reply:alpha',rows:null }
    throw error
  }
}
export async function recordedSshContinuation() {
  const manifest = yaml.load(await readFile(new URL('snapshot.yml', sshDirectory), 'utf8'))
  assert.deepEqual(manifest, { version: 1, scenario: 'ssh-execute-continuation', profile: 'power-evolve-host',
    composition: 'shared-host-platform-pg', recording: 'authored',
    header: { class: 'power-evolve-ssh-execute', pin: true } })
  try {
    return { rows: (await readFile(new URL('session.v4.jsonl', sshDirectory), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line)) }
  } catch (error) {
    if (record && error.code === 'ENOENT') return { rows: null }
    throw error
  }
}
export async function compareRecordedSession(page, expected, targetDirectory = directory) {
  const ids = new Map([[page.header.id,'{{session:1}}']])
  const rpcIds = new Map()
  const identity = value => { if (!ids.has(value)) ids.set(value,`{{message:${ids.size}}}`); return ids.get(value) }
  const rpcIdentity = value => { if (!rpcIds.has(value)) rpcIds.set(value, `{{request:${rpcIds.size + 1}}}`); return rpcIds.get(value) }
  const normalizeIds = value => {
    if (Array.isArray(value)) return value.map(normalizeIds)
    if (!value || typeof value!=='object') return value
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
      key==='id' && typeof item==='string' ? identity(item)
        : key==='rpcId' && typeof item==='string' ? rpcIdentity(item) : normalizeIds(item)]))
  }
  const rows = [normalizeIds({...page.header,createdAt:0}),...page.events.map(event=> {
    const {seq,time,...rest}=event
    const row=normalizeIds(rest)
    if(row.type==='assistant/message' || row.type==='assistant/attempt') {
      for(const part of row.data.stream) {
        if ('time' in part) part.time=0
        if ('time0' in part) part.time0=0
        if ('dt' in part) part.dt=part.dt.map(()=>0)
      }
    }
    if(row.type==='system/message') for(const block of row.data.message.content) if(block.type==='text') block.text='{{system}}'
    return row
  })]
  const system = page.events.filter(event=>event.type==='system/message').flatMap(event=>event.data.message.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n\n')+'\n'
  if(record) {
    await writeFile(new URL('session.v4.jsonl', targetDirectory),rows.map(row=>JSON.stringify(row)).join('\n')+'\n')
    await writeFile(new URL('system-prompt.expected.md',targetDirectory),system)
  } else {
    const target = new URL('session.v4.jsonl', targetDirectory)
    assert.deepEqual(rows,expected.rows,`Recorded native Session differs: ${fileURLToPath(target)}`)
    assert.equal(system,await readFile(new URL('system-prompt.expected.md',targetDirectory),'utf8'))
  }
}
export { sshDirectory }

/** Read the native continuation fixture, including its bounded model-visible excerpt. */
export async function recordedSandboxContinuation() {
  const manifest = yaml.load(await readFile(new URL('snapshot.yml', sandboxDirectory), 'utf8'))
  assert.equal(manifest.scenario, 'sandbox-output-continuation')
  try {
    return { rows: (await readFile(new URL('session.v4.jsonl', sandboxDirectory), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line)) }
  } catch (error) {
    if (record && error.code === 'ENOENT') return { rows: null }
    throw error
  }
}
export { sandboxDirectory }

/** Replay the exact model text, including NUL and literal escape sequences. */
export async function recordedLosslessOutput() {
  const manifest = yaml.load(await readFile(new URL('snapshot.yml', losslessDirectory), 'utf8'))
  assert.equal(manifest.scenario, 'lossless-output')
  try {
    const rows = (await readFile(new URL('session.v4.jsonl', losslessDirectory), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    return { rows, input: rows.find(row => row.type === 'user/message').data.content[0].text,
      output: rows.find(row => row.type === 'assistant/message').data.message.content[0].text }
  } catch (error) {
    if (record && error.code === 'ENOENT') return { rows: null, input: 'lossless-output-fixture',
      output: 'Observed output: \u0000表😀; literal \\u0000; complete.' }
    throw error
  }
}
export { losslessDirectory }

const mcpScenarios = { 'remote-mcp-two-step': 'alice', 'remote-mcp-rejected': 'bob' }

/** Read only the newest owned native generation; its user task and model replies are replay input. */
export async function recordedMcpSession(scenario) {
  assert(Object.hasOwn(mcpScenarios, scenario))
  const targetDirectory = new URL(`../${scenario}/`, directory)
  const manifest = yaml.load(await readFile(new URL('snapshot.yml', targetDirectory), 'utf8'))
  assert.deepEqual(manifest, { version: 1, scenario, profile: 'power-evolve-host',
    composition: 'shared-host-platform-pg', recording: 'authored',
    header: { class: scenario, pin: true, changes: scenario === 'remote-mcp-two-step' ? 2 : 1 } })
  const files = await readdir(targetDirectory)
  const selected = files.some(name => /^session(?:\.v\d+)?\.jsonl$/u.test(name)) ? sessionFixtureFiles(files)[0] : undefined
  if (!selected) {
    assert(record, `Missing native MCP fixture: ${scenario}`)
    return { targetDirectory, rows: null, input: `MCP_TWO_STEPS:${mcpScenarios[scenario]}`, replies: [] }
  }
  const source = await readFile(new URL(selected.name, targetDirectory), 'utf8')
  prepareSessionSnapshotFixtureForComparison(source)
  const rows = source.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0].version, selected.version)
  const input = rows.find(row => row.type === 'user/message' && row.data.source.kind === 'user').data.content[0].text
  const replies = rows.filter(row => row.type === 'assistant/message').map(row => row.data.message.content)
  return { targetDirectory, rows, input, replies }
}

/** Normalize only issued identities and structured Platform envelopes; arbitrary text remains visible. */
function normalizeMcpValues(value, actions, toolNames, platformOrigin) {
  if (typeof value === 'string') {
    if (toolNames.has(value)) return toolNames.get(value)
    let envelope
    try { envelope = JSON.parse(value) } catch { return value }
    if (!envelope || typeof envelope !== 'object' || !actions.has(envelope.actionId)
      || !(envelope.kind === 'remote_mcp_result' || Object.hasOwn(envelope, 'approvalUrl'))) return value
    const action = actions.get(envelope.actionId)
    envelope.actionId = action.id
    if (Object.hasOwn(envelope, 'fingerprint')) {
      assert.equal(envelope.fingerprint, action.fingerprint)
      envelope.fingerprint = action.token
    }
    if (Object.hasOwn(envelope, 'approvalUrl')) {
      assert.equal(envelope.approvalUrl, new URL('/approval', platformOrigin).toString())
      envelope.approvalUrl = '{{platform-origin}}/approval'
    }
    return JSON.stringify(envelope)
  }
  if (Array.isArray(value)) return value.map(item => normalizeMcpValues(item, actions, toolNames, platformOrigin))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'actionId' && actions.has(item) ? actions.get(item).id
      : normalizeMcpValues(item, actions, toolNames, platformOrigin)]))
  return value
}

/** Compare complete persisted native events plus readable request headers, with no writes during replay. */
export async function compareRecordedMcpSession(page, expected, { actions, tools, platformOrigin }) {
  const actionIds = new Map(actions.map((action, index) => [action.actionId,
    { id: `{{approval:${index + 1}}}`, fingerprint: action.fingerprint, token: `{{mcp-fingerprint:${index + 1}}}` }]))
  const toolNames = new Map(tools.map((tool, index) => [tool.model.name, `{{mcp-tool:${index + 1}}}`]))
  // Match the native JSONL persistence adapter's conversion from optional logical metadata.
  const header = toHeaderLine({ ...page.header, createdAt: 0 })
  const native = [header, ...page.events]
  const values = normalizeMcpValues(native, actionIds, toolNames, platformOrigin)
  const text = values.map(row => JSON.stringify(row)).join('\n') + '\n'
  const [redacted] = redactSessionSnapshotIds([text])
  const normalized = normalizeSessionLog(redacted, { cwd: '', sessionIds: [] }, { identityMode: 'preserve' })
  const complete = normalized.trim().split('\n').map(line => JSON.parse(line))
  const headers = complete.filter(row => row.type === 'request/header')
  const schemas = { initial: headers[0].data.header.tools, changes: headers.slice(1).map(row => row.data.header.tools) }
  const system = complete.filter(row => row.type === 'system/message')
    .flatMap(row => row.data.message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n\n') + '\n'
  const snapshot = scrubToolSchemas(scrubSystemPrompts(normalized)).trim().split('\n').map(line => {
    const { seq, time, ...row } = JSON.parse(line); return row
  })
  const serialized = snapshot.map(row => JSON.stringify(row)).join('\n') + '\n'
  prepareSessionSnapshotFixtureForComparison(serialized)
  assert.deepEqual(redactSessionSnapshotIds([serialized]), [serialized], 'Native MCP identity normalization is a fixed point')
  assert.equal(scrubToolSchemas(scrubSystemPrompts(serialized)), serialized)
  if (record) {
    // Version-named output preserves every previously committed generation.
    await writeFile(new URL(`session.v${page.header.version}.jsonl`, expected.targetDirectory), serialized)
    await writeFile(new URL('system-prompt.expected.md', expected.targetDirectory), system)
    await writeFile(new URL('tool-schemas.expected.json', expected.targetDirectory), JSON.stringify(schemas, null, 2) + '\n')
  } else {
    assert.deepEqual(snapshot, expected.rows, `Recorded native MCP Session differs: ${expected.targetDirectory.pathname}`)
    assert.equal(system, await readFile(new URL('system-prompt.expected.md', expected.targetDirectory), 'utf8'))
    assert.deepEqual(schemas, JSON.parse(await readFile(new URL('tool-schemas.expected.json', expected.targetDirectory), 'utf8')),
      'Recorded native MCP tool schemas differ')
  }
}
