import { bodyText, jsonRecord, requestUrl } from './fetch-fixture.ts'
/** Native HTTP requests and strict public parsing over synthetic endpoint replies; no real Platform or executor. */
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { StdioV2HttpClient, StdioV2HttpError } from '../src/client/stdio-v2-api.ts'
import { stdioV2Configuration } from '../src/client/stdio-v2-state.ts'
import { id, available, management, configuration, connection, create, check, receipt, checkReceipt, summary, detail } from './stdio-v2-fixtures.ts'

afterEach(() => { vi.unstubAllGlobals() })

test('default fetch preserves status when a proxy sends malformed or private failure details', async () => {
  for (const body of ['not-json', JSON.stringify({ error: 'private details / token' }), 'null', '[]', '{}', '{"error":5}']) {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 502 }))
    await assert.rejects(new StdioV2HttpClient().config(), (cause: unknown) =>
      cause instanceof StdioV2HttpError && cause.status === 502 && cause.code === undefined)
  }
})

test('aborted public configuration cannot enable a subsequent operation', async () => {
  const abort = new AbortController(); abort.abort()
  const client = new StdioV2HttpClient(async () => Response.json(available))
  await client.config(abort.signal)
  await assert.rejects(client.list({}), StdioV2HttpError)
})

test('mutations, check and cancellation refuse a valid reply for another original request', async () => {
  let result: unknown = receipt
  const client = new StdioV2HttpClient(async url => Response.json(requestUrl(url).endsWith('Config') ? available : result))
  await client.config()
  const update = management.update.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1, configuration })
  const toggle = management.toggle.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1, enabled: false })
  const remove = management.remove.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1 })
  result = { ...receipt, requestId: id(99), purpose: 'update', revision: 2 }
  await assert.rejects(client.update(update), /receipt mismatch/u)
  result = { ...receipt, requestId: id(99), purpose: 'toggle' }
  await assert.rejects(client.toggle(toggle), /receipt mismatch/u)
  result = { ...receipt, requestId: id(99), purpose: 'delete', deleted: true }
  await assert.rejects(client.remove(remove), /receipt mismatch/u)
  result = { ...checkReceipt, requestId: id(99) }
  await assert.rejects(client.check(check), /receipt mismatch/u)
  result = { ...summary, actionId: id(99) }
  await assert.rejects(client.cancel({ actionId: summary.actionId }), /receipt mismatch/u)
  result = { items: [connection], next: null }
  await assert.rejects(client.list({ after: connection.connectionId }), /page mismatch/u)
  result = { ...receipt, enabled: true }
  await assert.rejects(client.create(create), /receipt mismatch/u)
  result = { ...receipt, deleted: true }
  await assert.rejects(client.create(create), /receipt mismatch/u)
})

test('all eleven native methods use object request wire and original same-origin cookie policy', async () => {
  const calls: { route: string; request: unknown; signal: AbortSignal | null | undefined }[] = []
  const replies = [available, { items: [connection], next: null }, receipt,
    { ...receipt, purpose: 'update', revision: 2 }, { ...receipt, purpose: 'toggle', enabled: true },
    { ...receipt, purpose: 'delete', deleted: true }, receipt, checkReceipt,
    { items: [summary], nextOffset: null }, detail, { ...summary, cancelRequested: true }]
  const controller = new AbortController()
  const client = new StdioV2HttpClient(async (url, init) => {
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.method, 'POST')
    assert.deepEqual(init?.headers, { 'content-type': 'application/json' })
    const wire = jsonRecord(JSON.parse(bodyText(init?.body))); assert.deepEqual(Object.keys(wire), ['request']); assert(!Array.isArray(wire.request))
    calls.push({ route: requestUrl(url), request: wire.request, signal: init?.signal })
    return Response.json(replies[calls.length - 1])
  })
  await client.config(controller.signal); await client.list({}, controller.signal); await client.create(create, controller.signal)
  await client.update(management.update.parse({ ...create, connectionId: id(4), expectedRevision: 1 }), controller.signal)
  await client.toggle(management.toggle.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1,
    enabled: true }), controller.signal)
  await client.remove(management.remove.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1 }), controller.signal)
  await client.receipt({ requestId: create.requestId }, controller.signal); await client.check(check, controller.signal)
  await client.actions({ sessionId: summary.sessionId, offset: 0, limit: 2 }, controller.signal)
  assert.deepEqual(await client.detail({ actionId: summary.actionId }, controller.signal), detail)
  await client.cancel({ actionId: summary.actionId }, controller.signal)
  assert.deepEqual(calls.map(c => c.route), ['Config', 'ConnectionsList', 'ConnectionsCreate', 'ConnectionsUpdate', 'ConnectionsToggle',
    'ConnectionsDelete', 'ConnectionsReceipt', 'ConnectionsCheck', 'ActionsList', 'ActionsDetail', 'ActionsCancel'].map(n => `/api/powerEvolve/stdioV2${n}`))
  assert(calls.every(c => c.signal === controller.signal)); assert.deepEqual(calls[2]!.request, create)
  assert.deepEqual(calls[7]!.request, check)
})

test('literal argv preserves empty arguments and shell characters while relative cwd and NUL are validated', async () => {
  const fields = { name: 'Literal', program: 'node', argv: '["", "a b", "$(never);\\\\literal", "最后"]', cwd: '.' }
  assert.deepEqual(stdioV2Configuration(fields, available).invocation.argv, ['', 'a b', '$(never);\\literal', '最后'])
  for (const patch of [{ argv: '"array required"' }, { argv: '[1]' }, { argv: '["\\u0000"]' }, { argv: '{"argv":[]}' },
    { cwd: '/workspace' }, { cwd: '../outside' }, { cwd: 'a//b' }, { cwd: 'a\\b' }, { program: 'bad\0name' }]) {
    assert.throws(() => stdioV2Configuration({ ...fields, ...patch }, available))
  }
  let posts = 0
  const client = new StdioV2HttpClient(async () => { posts++; return Response.json(available) })
  await client.config()
  await assert.rejects(client.create({ ...create, configuration: { ...configuration, invocation: { ...configuration.invocation, cwd: '/workspace' } } }))
  await assert.rejects(client.check({ ...check, target: { kind: 'cloud', extra: true } } as typeof check))
  assert.equal(posts, 1)
})

test('missing metadata disables generic endpoints and preserves actual refusal codes without replay', async () => {
  let posts = 0
  const client = new StdioV2HttpClient(async () => { posts++; return Response.json({ formatVersion: 2, available: false }) })
  assert.equal((await client.config()).available, false)
  await assert.rejects(client.list({}), (e: unknown) => e instanceof StdioV2HttpError && e.status === 503)
  assert.equal(posts, 1)
  const refused = new StdioV2HttpClient(async url => requestUrl(url).endsWith('Config') ? Response.json(available)
    : Response.json({ error: 'stdio_v2_revision_conflict' }, { status: 409 }))
  await refused.config()
  await assert.rejects(refused.create(create), (e: unknown) => e instanceof StdioV2HttpError && e.status === 409 && e.code === 'stdio_v2_revision_conflict')
})

test('raw complete task/outcome fields survive HTTP parsing, while wrong associations and excess bytes reject', async () => {
  let response: unknown = detail
  const client = new StdioV2HttpClient(async url => Response.json(requestUrl(url).endsWith('Config') ? available : response))
  await client.config()
  const parsed = await client.detail({ actionId: summary.actionId })
  assert.deepEqual(parsed, detail)
  assert(parsed.task.phase === 'call' && Object.hasOwn(parsed.task.selection.arguments, '__proto__'))
  response = { ...detail, actionId: id(12), task: { ...detail.task, actionId: id(12) } }
  await assert.rejects(client.detail({ actionId: summary.actionId }))
  response = { ...detail, extra: true }; await assert.rejects(client.detail({ actionId: summary.actionId }))
  response = { ...detail, task: { ...detail.task, invocation: { ...detail.task.invocation, argv: ['x'.repeat(available.maxReplyBytes)] } } }
  await assert.rejects(client.detail({ actionId: summary.actionId }))
})

test('receipt and pagination mismatch cannot be presented as an original successful response', async () => {
  let response: unknown = { ...receipt, requestId: id(15) }
  const client = new StdioV2HttpClient(async url => Response.json(requestUrl(url).endsWith('Config') ? available : response))
  await client.config(); await assert.rejects(client.create(create)); await assert.rejects(client.receipt({ requestId: create.requestId }))
  response = { ...checkReceipt, executionRef: { kind: 'desktop', executionId: id(11) } }; await assert.rejects(client.check(check))
  response = { items: [summary], nextOffset: 1 }
  await assert.rejects(client.actions({ sessionId: summary.sessionId, offset: 0, limit: 2 }))
  response = { items: [{ ...summary, sessionId: id(16) }], nextOffset: null }
  await assert.rejects(client.actions({ sessionId: summary.sessionId, offset: 0, limit: 2 }))
  response = { items: [connection, connection], next: null }; await assert.rejects(client.list({}))
})
