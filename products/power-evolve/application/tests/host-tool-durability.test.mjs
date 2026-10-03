/** Real native tool pipeline with controlled persistence failures; external bodies are counted substitutes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PlatformError } from '../lib/contracts.js'
import { installDurableToolDispatch } from '../lib/host/durability.js'

async function fixture(t) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(SessionStore)
  await root.plugin(ToolRuntime)
  let ctx
  await root.inject(['sessions', 'tools'], ready => { ctx = ready })
  const scopes = []
  t.after(async () => { for (const scope of scopes.reverse()) await scope.dispose() })
  function agent() {
    const value = { id: SessionId(randomUUID()), ctx: undefined, session: undefined }
    const scope = createScope(ctx, value)
    scopes.push(scope)
    value.ctx = scope.ctx
    value.session = scope.ctx.sessions.create(value.id)
    installDurableToolDispatch(value)
    return value
  }
  function tool(name, body) {
    ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (_args, exec) => body(exec) }))
  }
  function call(owner, name, fields = {}) {
    return owner.ctx.tools.execute({ agent: owner, name, callId: ToolCallId(randomUUID()),
      arguments: {}, signal: new AbortController().signal, ...fields })
  }
  return { ctx, agent, tool, call }
}

test('failed persistence prevents every registered side-effect body', async t => {
  const { agent, tool, call } = await fixture(t)
  const owner = agent()
  let bodies = 0, checkpoints = 0
  owner.ctx.on('session/flush', () => { checkpoints++; throw new PlatformError(413, 'history_limit') })
  for (const name of ['cloud_exec', 'desktop_exec', 'remote_api', 'file_write', 'ssh_execute', 'stdio_mcp']) {
    tool(name, () => { bodies++; return 'unexpected' })
    const result = await call(owner, name)
    assert.equal(result.isError, true, name)
    assert.match(JSON.stringify(result), /history_limit/, name)
  }
  assert.equal(checkpoints, 6)
  assert.equal(bodies, 0)
})

test('a missing durability listener refuses dispatch', async t => {
  const { agent, tool, call } = await fixture(t)
  const owner = agent()
  let bodies = 0
  tool('write', () => { bodies++; return 'written' })
  const result = await call(owner, 'write')
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /persistence_unavailable/)
  assert.equal(bodies, 0)
})

test('two concurrent Agents checkpoint only their own event prefixes before execution', async t => {
  const { agent, tool, call } = await fixture(t)
  const alice = agent(), bob = agent(), seen = []
  for (const owner of [alice, bob]) {
    owner.session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: owner.id }] }), { surfaceOp: 'append' })
    owner.ctx.on('session/flush', session => {
      assert.equal(session, owner.session)
      seen.push(['flushed', owner.id, session.snapshotEvents().length])
    })
  }
  tool('write', exec => {
    assert(seen.some(row => row[0] === 'flushed' && row[1] === exec.agent.id))
    seen.push(['body', exec.agent.id])
    return exec.agent.id
  })
  const results = await Promise.all([call(alice, 'write'), call(bob, 'write')])
  assert(results.every(result => !result.isError))
  assert.equal(seen.filter(row => row[0] === 'flushed').length, 2)
  assert.equal(seen.filter(row => row[0] === 'body').length, 2)
})

test('cancellation while persistence is pending prevents the later body', async t => {
  const { agent, tool, call } = await fixture(t)
  const owner = agent(), abort = new AbortController()
  let release, entered, bodies = 0
  const enteredFlush = new Promise(resolve => { entered = resolve })
  owner.ctx.on('session/flush', () => { entered(); return new Promise(resolve => { release = resolve }) })
  tool('write', () => { bodies++; return 'written' })
  const pending = call(owner, 'write', { signal: abort.signal })
  await enteredFlush
  abort.abort(new Error('cancelled during checkpoint'))
  release()
  assert.equal((await pending).isError, true)
  assert.equal(bodies, 0)
})

test('nested transport calls recheck durability after the outer checkpoint', async t => {
  const { agent, tool, call } = await fixture(t)
  const owner = agent()
  let failed = false, checkpoints = 0, childBodies = 0
  owner.ctx.on('session/flush', () => {
    checkpoints++
    if (failed) throw new PlatformError(413, 'history_limit')
  })
  tool('child_write', () => { childBodies++; return 'written' })
  tool('outer', async exec => {
    failed = true
    const child = await call(owner, 'child_write', { parent: exec.token, rootCallId: exec.rootCallId })
    assert.equal(child.isError, true)
    assert.match(JSON.stringify(child), /history_limit/)
    return 'nested body refused'
  })
  assert.equal((await call(owner, 'outer')).isError, false)
  assert.equal(checkpoints, 2)
  assert.equal(childBodies, 0)
})
