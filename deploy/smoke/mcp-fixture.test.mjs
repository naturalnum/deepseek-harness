/** Real keyless SDK entry and socket shutdown; no external account or API. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { createMcpSmokeFixture, resolveMcpFixtureHost } from './mcp-fixture.mjs'

const require = createRequire(new URL('../../packages/mcp/mcp-client/package.json', import.meta.url))
async function connect(t, url) {
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href)
  const client = new Client({ name: 'smoke-fixture-test', version: '1.0.0' }, { capabilities: {} })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

test('the SDK lists and invokes the owned tool, then actual stop and same-URL restart work', async t => {
  const fixture = await createMcpSmokeFixture()
  t.after(() => fixture.close())
  const originalUrl = fixture.url
  const client = await connect(t, originalUrl)
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ping'])
  const result = await client.callTool({ name: 'ping', arguments: {} })
  assert.notEqual(result.isError, true)
  assert.deepEqual(result.content, [{ type: 'text', text: fixture.marker }])
  assert.deepEqual(fixture.calls, ['ping'])
  await client.close()
  await Promise.all([fixture.stop(), fixture.stop()])
  assert.equal(fixture.state, 'stopped')
  await assert.rejects(fetch(originalUrl), error => error.cause?.code === 'ECONNREFUSED')
  await fixture.restart()
  assert.equal(fixture.url, originalUrl)
  const restored = await connect(t, originalUrl)
  assert.deepEqual((await restored.callTool({ name: 'ping', arguments: {} })).content,
    [{ type: 'text', text: fixture.marker }])
  assert.deepEqual(fixture.calls, ['ping', 'ping'])
  await restored.close()
})

test('separate fixtures own distinct OS-assigned ports and stopping one leaves the other callable', async t => {
  const first = await createMcpSmokeFixture()
  t.after(() => first.close())
  const second = await createMcpSmokeFixture()
  t.after(() => second.close())
  assert.notEqual(first.url, second.url)
  assert.notEqual(first.marker, second.marker)
  const client = await connect(t, second.url)
  await first.stop()
  assert.equal(first.state, 'stopped')
  assert.equal(second.state, 'running')
  assert.deepEqual((await client.callTool({ name: 'ping', arguments: {} })).content,
    [{ type: 'text', text: second.marker }])
  assert.deepEqual(first.calls, [])
  await client.close()
})

test('fixture selection preserves loopback and refuses wildcard, DNS, public and unowned LAN addresses', async () => {
  assert.equal(resolveMcpFixtureHost(), '127.0.0.1')
  assert.equal(resolveMcpFixtureHost('127.0.0.1'), '127.0.0.1')
  const assigned = Object.values(networkInterfaces()).flat().map(row => row?.address)
  const unowned = ['10.255.255.254', '172.31.255.254', '192.168.255.254'].find(host => !assigned.includes(host))
  assert.notEqual(unowned, undefined)
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '8.8.8.8', '192.0.2.1', '',
    'http://127.0.0.1', 'user:password@127.0.0.1', '127.0.0.1:80', unowned]) {
    assert.throws(() => resolveMcpFixtureHost(host), /MCP 测试服务地址必须/)
  }
  await assert.rejects(createMcpSmokeFixture({ host: '0.0.0.0' }), /MCP 测试服务地址必须/)
})

test('an explicitly owned LAN IPv4 uses the same bound and advertised host through SDK stop and restart', async t => {
  const selected = Object.values(networkInterfaces()).flat().find(row => row?.family === 'IPv4' && !row.internal
    && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(row.address))
  assert.notEqual(selected, undefined, 'the Linux SDK run requires an actual owned private LAN IPv4')
  const host = selected.address
  assert.equal(resolveMcpFixtureHost(host), host)
  const fixture = await createMcpSmokeFixture({ host })
  t.after(() => fixture.close())
  const originalUrl = fixture.url
  assert.equal(new URL(originalUrl).hostname, host)
  assert.notEqual(new URL(originalUrl).port, '0')
  const client = await connect(t, originalUrl)
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['ping'])
  assert.deepEqual((await client.callTool({ name: 'ping', arguments: {} })).content,
    [{ type: 'text', text: fixture.marker }])
  const rejected = await new Promise((resolve, reject) => {
    const incoming = request(originalUrl, { headers: { host: 'different.invalid' } }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    incoming.once('error', reject)
    incoming.end()
  })
  assert.equal(rejected, 403)
  assert.deepEqual(fixture.calls, ['ping'])
  await client.close()
  await fixture.stop()
  assert.equal(fixture.state, 'stopped')
  await assert.rejects(fetch(originalUrl), error => error.cause?.code === 'ECONNREFUSED')
  await fixture.restart()
  assert.equal(fixture.url, originalUrl)
  const restored = await connect(t, originalUrl)
  assert.deepEqual((await restored.callTool({ name: 'ping', arguments: {} })).content,
    [{ type: 'text', text: fixture.marker }])
  assert.deepEqual(fixture.calls, ['ping', 'ping'])
  await restored.close()
})
