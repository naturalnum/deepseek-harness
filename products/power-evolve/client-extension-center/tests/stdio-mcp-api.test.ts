import assert from 'node:assert/strict'
import test from 'node:test'
import { StdioMcpHttpClient } from '../src/client/stdio-mcp-api.ts'

const id = 'f76e4521-45b0-4829-91dd-9a205c7ef68c'
const item = { connectionId: id, name: 'My process MCP', enabled: true, revision: 1,
  toolName: 'mcp__stdio__whoami', description: 'Read account in isolated process' }

test('native process MCP client uses only owner metadata and validates status', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const values: unknown[] = [
    { available: true, preset: { toolName: 'mcp__stdio__whoami', description: 'Fixed process' }, items: [] },
    item, { ...item, enabled: false, revision: 2 },
    { items: [{ callId: id, state: 'succeeded', result: 'user:alice' }] },
    { callId: id, state: 'succeeded', result: 'user:alice' },
  ]
  const client = new StdioMcpHttpClient(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json(values.shift())
  })
  assert.deepEqual((await client.list()).items, [])
  assert.equal((await client.install({ requestId: id, name: item.name })).connectionId, id)
  assert.equal((await client.toggle({ connectionId: id, requestId: id,
    baseRevision: 1, enabled: false })).revision, 2)
  assert.equal((await client.calls()).items[0]?.result, 'user:alice')
  assert.equal((await client.status(id)).result, 'user:alice')
  assert.deepEqual(calls.map(value => value.url), [
    '/api/powerEvolve/stdioMcpList', '/api/powerEvolve/stdioMcpInstall',
    '/api/powerEvolve/stdioMcpToggle', '/api/powerEvolve/stdioMcpCalls',
    '/api/powerEvolve/stdioMcpStatus',
  ])
  assert.equal(JSON.stringify(calls).includes('command'), false)
})

test('browser rejects extra tool data and oversized process output', async () => {
  const invalid = [
    { available: true, preset: { toolName: 'mcp__stdio__other', description: '' }, items: [] },
    { available: true, preset: { toolName: 'mcp__stdio__whoami', description: '' },
      items: [{ ...item, command: '/bin/sh' }] },
  ]
  for (const value of invalid) {
    const client = new StdioMcpHttpClient(async () => Response.json(value))
    await assert.rejects(client.list())
  }
  const client = new StdioMcpHttpClient(async () => Response.json({ callId: id,
    state: 'succeeded', result: '界'.repeat(3000) }))
  await assert.rejects(client.status(id))
})
