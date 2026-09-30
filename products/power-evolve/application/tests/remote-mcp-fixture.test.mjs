/** Short-lived loopback fixture processes exercised through the installed official MCP SDK. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client, SdkErrorCode, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

async function fixture(t, delayMs) {
  const directory = await mkdtemp(join(tmpdir(), 'pe-remote-mcp-fixture-'))
  const readyFile = join(directory, 'ready.json')
  const accounts = ['alice', 'bob'].map((username, index) => ({ username,
    token: randomBytes(24).toString('base64url'), unitPrice: 11 + index * 8 }))
  const clients = []
  let child, exited, closed, stderr = ''
  async function stop() {
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) { await closed; return exited }
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.kill('SIGTERM')
    try { const result = await exited; await closed; return result } finally { clearTimeout(timer) }
  }
  t.after(async () => {
    try {
      await Promise.all(clients.map(client => client.close()))
    } finally {
      await stop()
      child?.stdout?.destroy(); child?.stderr?.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  })
  await writeFile(join(directory, 'remote-mcp-fixture-users.json'), JSON.stringify(accounts), { mode: 0o600 })
  child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/remote-mcp-fixture.mjs', import.meta.url))], {
    env: { PE_REMOTE_MCP_PORT: '0', PE_PRIVATE_DIR: directory, PE_READY_FILE: readyFile,
      ...delayMs === undefined ? {} : { PE_REMOTE_MCP_DELAY_MS: String(delayMs) } },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  exited = once(child, 'exit')
  closed = once(child, 'close')
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192) })
  async function ready() {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture exited before readiness')
      await delay(10)
    }
    throw new Error('Fixture readiness timed out')
  }
  function client(origin, path, token, fetch) {
    const value = new Client({ name: 'fixture-acceptance', version: '1' })
    clients.push(value)
    const transport = new StreamableHTTPClientTransport(new URL(path, origin), {
      ...token === undefined ? {} : { requestInit: { headers: { authorization: `Bearer ${token}` } } },
      ...fetch === undefined ? {} : { fetch },
    })
    return { value, transport }
  }
  async function connect(origin, path, token) {
    const { value, transport } = client(origin, path, token)
    await value.connect(transport, { timeout: 2000 })
    return value
  }
  return { accounts, exited, closed, ready, readyFile, stop, client, connect,
    stderr: () => stderr,
    audit: async () => (await readFile(join(directory, 'remote-mcp-fixture-calls.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line)),
  }
}

test('private Bearer catalogs and audit fields stay unchanged; public, empty and delayed catalogs use SDK 2',
  { timeout: 10000 }, async t => {
    const f = await fixture(t, 30), { url } = await f.ready()
    assert.equal(new URL(url).hostname, '127.0.0.1')
    for (const authorization of [undefined, 'Bearer incorrect']) {
      const denied = await fetch(`${url}/mcp`, { method: 'POST',
        headers: authorization === undefined ? {} : { authorization } })
      assert.equal(denied.status, 401); await denied.text()
    }
    for (const account of f.accounts) {
      const client = await f.connect(url, '/mcp', account.token)
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['lookup_item', 'calculate_quote'])
      const result = await client.callTool({ name: 'lookup_item', arguments: { sku: 'notebook' } })
      assert.deepEqual(result.structuredContent, { owner: account.username, sku: 'notebook',
        unitPrice: account.unitPrice, quoteCode: `${account.username}-notebook-2026`, currency: 'CNY' })
    }
    const publicClient = await f.connect(url, '/mcp/public')
    const tools = (await publicClient.listTools()).tools
    assert.deepEqual(tools.map(tool => tool.name), ['lookup_item', 'calculate_quote'])
    assert.match(tools[0].description, /synthetic fixed test data/u)
    const item = await publicClient.callTool({ name: 'lookup_item', arguments: { sku: 'notebook' } })
    assert.deepEqual(item.structuredContent, { owner: 'public', sku: 'notebook', unitPrice: 7,
      quoteCode: 'public-notebook-2026', currency: 'CNY' })
    const quote = await publicClient.callTool({ name: 'calculate_quote',
      arguments: { quoteCode: item.structuredContent.quoteCode, quantity: 3 } })
    assert.deepEqual(quote.structuredContent, { owner: 'public', sku: 'notebook', quantity: 3, total: 21, currency: 'CNY' })
    const wrongOwner = await publicClient.callTool({ name: 'calculate_quote',
      arguments: { quoteCode: 'alice-notebook-2026', quantity: 3 } })
    assert.equal(wrongOwner.isError, true)
    const suppliedBearer = await f.connect(url, '/mcp/public', f.accounts[1].token)
    assert.equal((await suppliedBearer.callTool({ name: 'lookup_item', arguments: { sku: 'pencil' } }))
      .structuredContent.owner, 'public')
    const empty = await f.connect(url, '/mcp/empty')
    assert.ok(empty.getServerCapabilities().tools)
    assert.deepEqual((await empty.listTools()).tools, [])
    const slow = await f.connect(url, '/mcp/slow')
    assert.deepEqual((await slow.listTools()).tools.map(tool => tool.name), ['lookup_item', 'calculate_quote'])
    const audit = await f.audit()
    assert.equal(audit.length, 5)
    for (const entry of audit) assert.deepEqual(Object.keys(entry).sort(), ['args', 'owner', 'tool', 'value'])
    assert.deepEqual(audit.map(entry => entry.owner), ['alice', 'bob', 'public', 'public', 'public'])
    assert.deepEqual(audit[3], { owner: 'public', tool: 'calculate_quote',
      args: { quoteCode: 'public-notebook-2026', quantity: 3 }, value: quote.structuredContent })
    assert.deepEqual(await f.stop(), [0, null])
  })

test('default slow discovery can be cancelled or time out while private requests proceed; shutdown closes pending waits',
  { timeout: 10000 }, async t => {
    const f = await fixture(t), { url } = await f.ready()
    let sent
    const requestStarted = new Promise(resolve => { sent = resolve })
    const controller = new AbortController()
    const slow = f.client(url, '/mcp/slow', undefined, (request, init) => {
      sent(); return fetch(request, init)
    })
    const cancelled = assert.rejects(slow.value.connect(slow.transport, { signal: controller.signal, timeout: 2000 }),
      { message: /abort|cancel|closed/iu })
    await requestStarted
    const privateClient = await f.connect(url, '/mcp', f.accounts[0].token)
    assert.equal((await privateClient.listTools()).tools.length, 2)
    controller.abort(new Error('Discovery cancelled by fixture test'))
    await cancelled; await slow.value.close()
    const timeout = f.client(url, '/mcp/slow')
    await assert.rejects(timeout.value.connect(timeout.transport, { timeout: 100 }), { code: SdkErrorCode.RequestTimeout })
    await timeout.value.close()
    const abort = new AbortController()
    const pending = assert.rejects(fetch(`${url}/mcp/slow`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}', signal: abort.signal }))
    try {
      const health = await fetch(`${url}/health`)
      assert.equal((await health.json()).ready, true)
      assert.deepEqual(await f.stop(), [0, null])
      await pending
      await assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }))
    } finally { abort.abort() }
  })

test('non-finite and out-of-range delay configuration fail before publishing readiness',
  { timeout: 10000 }, async t => {
    for (const value of ['not-a-number', 60001]) {
      const f = await fixture(t, value)
      assert.deepEqual(await f.exited, [1, null])
      await f.closed
      assert.match(f.stderr(), /Invalid remote MCP fixture configuration/u)
      await assert.rejects(readFile(f.readyFile), { code: 'ENOENT' })
    }
  })
