import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FixedMcpHttpClient } from '../src/client/mcp-api.ts'

const connectionId = 'f76e4521-45b0-4829-91dd-9a205c7ef68c'
const requestId = '458b17f6-ed08-47c6-8eaa-81ce259d4ad0'
const item = { connectionId, name: 'My whoami', enabled: true, revision: 1,
  toolName: 'mcp__personal__whoami', description: 'Read only identity' }

test('fixed MCP client sends only user choice and an opaque connection ID', async () => {
  const calls: Array<{ route: string; body: unknown }> = []
  const replies = [
    { available: true, preset: { toolName: 'mcp__personal__whoami', description: 'Read only identity' }, items: [] },
    item, { ...item, enabled: false, revision: 2 }, { toolName: 'mcp__personal__whoami', result: 'alice' },
  ]
  const client = new FixedMcpHttpClient(async (input, init) => {
    calls.push({ route: String(input), body: JSON.parse(String(init?.body)) })
    return Response.json(replies[calls.length - 1])
  })
  assert.equal((await client.list()).available, true)
  assert.equal((await client.install({ requestId, name: 'My whoami' })).connectionId, connectionId)
  assert.equal((await client.toggle({ connectionId, requestId, baseRevision: 1, enabled: false })).enabled, false)
  assert.equal((await client.check(connectionId)).result, 'alice')
  assert.deepEqual(calls, [
    { route: '/api/powerEvolve/mcpList', body: { request: {} } },
    { route: '/api/powerEvolve/mcpInstall', body: { request: { requestId, name: 'My whoami' } } },
    { route: '/api/powerEvolve/mcpToggle', body: { request: { connectionId, requestId, baseRevision: 1, enabled: false } } },
    { route: '/api/powerEvolve/mcpCheck', body: { request: { connectionId } } },
  ])
})

test('fixed MCP client rejects foreign tool names and unbounded results', async () => {
  const badList = new FixedMcpHttpClient(async () => Response.json({ available: true,
    preset: { toolName: 'mcp__personal__other', description: 'Something else' }, items: [item] }))
  await assert.rejects(badList.list(), /Invalid MCP list response/u)
  const badResult = new FixedMcpHttpClient(async () => Response.json({ toolName: 'mcp__personal__whoami',
    result: 'x'.repeat(8193) }))
  await assert.rejects(badResult.check(connectionId), /Invalid MCP check response/u)
  const oversizedUtf8 = new FixedMcpHttpClient(async () => Response.json({ toolName: 'mcp__personal__whoami',
    result: '你'.repeat(2731) }))
  await assert.rejects(oversizedUtf8.check(connectionId), /Invalid MCP check response/u)
  await assert.rejects(badResult.install({ requestId, name: '' }), /Invalid MCP install request/u)
  await assert.rejects(badResult.install({ requestId, name: 'a'.repeat(81) }), /Invalid MCP install request/u)
})
