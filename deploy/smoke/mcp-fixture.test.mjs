/** Real keyless SDK entry and socket shutdown; no external account or API. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { createMcpSmokeFixture } from './mcp-fixture.mjs'

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
