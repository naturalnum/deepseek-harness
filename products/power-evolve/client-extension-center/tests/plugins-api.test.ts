import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PluginHttpClient, approvalUrl } from '../src/client/plugins-api.ts'

const id = '90795549-5b84-4e10-a5a2-6c633bb1633c'
const notes = { id: 'notes', title: '受控便签', category: 'tools', kind: 'builtin',
  enabled: true, revision: 2, requiresApproval: true }

test('personal plugin RPC sends no user assertion or credentials', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const client = new PluginHttpClient(async (input, init) => {
    calls.push({ url: String(input), init: init! })
    return Response.json(calls.length === 1 ? { items: [notes] } : { ...notes, enabled: false, revision: 3 })
  })
  assert.deepEqual(await client.list(), [notes])
  assert.deepEqual(await client.setEnabled({ requestId: id, expectedRevision: 2, enabled: false }),
    { ...notes, enabled: false, revision: 3 })
  assert.deepEqual(calls.map(call => call.url), ['/api/powerEvolve/pluginsList',
    '/api/powerEvolve/pluginsNotesSetEnabled'])
  assert.deepEqual(calls.map(call => JSON.parse(String(call.init.body))), [
    { request: {} }, { request: { requestId: id, expectedRevision: 2, enabled: false } },
  ])
  assert(calls.every(call => call.init.credentials === 'same-origin'))
})

test('plugin response validation rejects extra tenant entries and mismatched toggle', async () => {
  const wrongList = new PluginHttpClient(async () => Response.json({ items: [notes, { ...notes, id: 'ssh' }] }))
  await assert.rejects(wrongList.list(), /Invalid plugin list response/u)
  const wrongToggle = new PluginHttpClient(async () => Response.json(notes))
  await assert.rejects(wrongToggle.setEnabled({ requestId: id, expectedRevision: 2, enabled: false }),
    /Plugin toggle response mismatch/u)
})

test('approval destination is the Host-declared exact Platform page', async () => {
  const valid = await approvalUrl(async () => Response.json({ approvalUrl: 'http://127.0.0.1:19211/approval' }))
  assert.equal(valid, 'http://127.0.0.1:19211/approval')
  for (const invalid of ['https://example.com/approval?next=https://evil.example',
    'http://example.com/approval', 'https://example.com/approval/../login',
    'https://user:pass@example.com/approval']) {
    await assert.rejects(approvalUrl(async () => Response.json({ approvalUrl: invalid })),
      /Invalid approval URL/u)
  }
})
