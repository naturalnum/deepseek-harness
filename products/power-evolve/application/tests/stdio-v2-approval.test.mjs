/** Real shipped DOM adapter with synthetic approval endpoints; no product, model or executor is started. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { runInContext } from 'node:vm'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { createStdioV2Approval, stdioApprovalLabels as labels } from '../web/stdio-v2-approval.js'
import { t as approvalCopy } from '../web/locale.js'

const html = readFileSync(new URL('../web/approval.html', import.meta.url), 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const owner = id(1), otherOwner = id(2), actionId = id(3), sessionId = id(4), connectionId = id(5)
const token = 'synthetic-independent-approval-token', now = Date.parse('2026-10-08T00:00:00Z')
const limits = { runtimeMs: 2000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100, killGraceMs: 100,
  maxInputBytes: 262144, maxMessageBytes: 16384, maxProtocolBytes: 262144, maxProtocolMessages: 100,
  maxJsonDepth: 40, maxJsonNodes: 10000, maxPages: 4, maxTools: 10, maxCatalogBytes: 32768,
  maxToolBytes: 16384, maxResultBytes: 16384, maxStderrBytes: 4096 }
const pin = { kind: 'cloud', deploymentId: id(6), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `fixture.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'c'.repeat(64)}`] }
const actualExecutorImage = { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] }
const raw = JSON.parse('{"name":"two-parameter-tool","inputSchema":{"type":"object"},"_meta":{"__proto__":{"keep":"\\u0000雪"},"constructor":"raw"},"future":{"10":"ten","2":"two"}}')
const args = JSON.parse('{"first":"<img src=x onerror=attack()>","second":"\\u0000雪","__proto__":{"keep":true},"constructor":"original"}')
function approval(phase = 'call', action = actionId, actor = owner) {
  const task = { formatVersion: 2, actionId: action, userId: actor, sessionId, connectionId, configRevision: 1,
    configDigest: 'd'.repeat(64), phase, scopeBinding: { kind: 'cloud', userId: actor, workspaceId: id(7), bindingGeneration: 2,
      target: { spaceId: id(8), rootRelativePath: 'QA/雪' }, home: { kind: 'user', userId: actor } }, expectedDeploymentPin: pin,
    invocation: { program: 'node', argv: ['', '--name', 'literal;$(untouched)', '<img src=x onerror=attack()>', 'line\nbreak'], cwd: 'QA/雪' }, limits,
    origin: phase === 'call' ? { kind: 'operation', operationId: id(9), rootOperationId: id(10), callKey: 'original-native-call' }
      : { kind: 'stdio_discovery', requestId: id(11) } }
  if (phase === 'call') task.selection = { catalogId: id(12), catalogDigest: 'e'.repeat(64), rawCatalog: [raw],
    rawDescriptor: raw, rawName: raw.name, arguments: args, catalogImageExpectation: actualExecutorImage }
  return structuredClone({ task, actualExecutorImage, taskDigest: 'f'.repeat(64), preparedDigest: '1'.repeat(64), fingerprint: '2'.repeat(64),
    approvalEpoch: 1, expiresAt: '2026-10-08T01:00:00Z', state: 'pending', expired: false, decision: null })
}
function summary(view) {
  return { formatVersion: 2, actionId: view.task.actionId, sessionId: view.task.sessionId, connectionId: view.task.connectionId,
    configRevision: view.task.configRevision, phase: view.task.phase, taskDigest: view.taskDigest, state: view.state,
    executionRef: { kind: 'cloud', executionId: id(13) }, executionState: 'starting', cancelRequested: false,
    createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' }
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('Approval fixture did not reach expected state')
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function page(t, { override = () => undefined, saved, fetchOverride, records = [approval()] } = {}) {
  const dom = new JSDOM(html, { url: 'https://platform.test/approval' }), calls = []
  t.after(() => dom.window.close())
  const document = dom.window.document, state = { records, missing: false }, storage = dom.window.sessionStorage
  if (saved !== undefined) storage.setItem('pe-stdio-v2-approval-attempts', saved)
  let credential = token, unauthorized = 0
  const fixtureFetch = async (path, init) => {
    const call = { path, init, body: JSON.parse(init.body) }; calls.push(call)
    const response = await override(call, state)
    if (response !== undefined) return response
    if (path.endsWith('/list')) return Response.json({ items: state.records.slice(call.body.offset, call.body.offset + 1).map(summary),
      nextOffset: call.body.offset + 1 < state.records.length ? call.body.offset + 1 : null })
    const view = state.records.find(record => record.task.actionId === call.body.actionId)
    if (!view || state.missing) return new Response('', { status: 404 })
    if (path.endsWith('/inspect')) return Response.json(view)
    if (path.endsWith('/decide')) {
      assert.equal(call.body.fingerprint, view.fingerprint)
      view.decision = call.body.decision; view.state = call.body.decision === 'once' ? 'approved' : 'rejected'
      return Response.json(view)
    }
    throw new Error(`Unexpected fixture endpoint ${path}`)
  }
  const component = createStdioV2Approval({ document, storage, fetch: fetchOverride ?? fixtureFetch, credential: () => credential,
    unauthorized: () => { unauthorized++; credential = null }, now: () => now })
  t.after(() => component.reset())
  const area = document.getElementById('stdio-v2-actions')
  return { component, document, window: dom.window, storage, state, calls, area,
    get unauthorized() { return unauthorized }, set credential(value) { credential = value },
    button(label) { return [...area.querySelectorAll('button')].find(button => button.textContent === label) },
    mutations() { return calls.filter(call => call.path.endsWith('/decide')) },
    async inspect(actor = owner) {
      await component.refresh(actor); this.button(labels.inspect).click()
      await until(() => area.querySelector('details') && !this.button(labels.inspect).disabled)
    },
    choose(decision = 'once') {
      const checkbox = area.querySelector('input'); checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event('change'))
      this.button(labels[decision]).click()
    },
    async settled() { await until(() => !this.button(labels.inspect)?.disabled) },
  }
}

test('complete literal argv, scope, reviewed image and raw JSON remain inert visible text', async t => {
  const view = page(t); await view.inspect()
  assert.equal(view.area.querySelector('img,script,iframe,a'), null)
  const values = new Map([...view.area.querySelectorAll('article:last-child > p')].map(label => [label.textContent, label.nextSibling.textContent]))
  assert.deepEqual(JSON.parse(values.get(labels.argv)), view.state.records[0].task.invocation.argv)
  assert.deepEqual(JSON.parse(values.get(labels.arguments)), args)
  assert.equal(JSON.parse(values.get(labels.arguments)).__proto__.keep, true)
  assert.equal(JSON.parse(values.get(labels.image)).runtimeImageId, actualExecutorImage.runtimeImageId)
  assert.deepEqual(JSON.parse(view.area.querySelector('details pre').textContent), view.state.records[0].task)
  assert(view.area.textContent.includes('\\u0000雪'))
  assert(!view.area.textContent.includes(token))
  assert(!view.area.textContent.includes('capture'))
  assert.equal(view.button(labels.once).disabled, true)
  assert.deepEqual(view.calls.map(call => call.path), ['/approvals/stdio-v2/list', '/approvals/stdio-v2/inspect'])
  assert(view.calls.every(call => call.init.credentials === 'same-origin' && call.init.redirect === 'error'
    && call.init.headers.authorization === `Bearer ${token}`))
  const card = view.area.querySelector('details').parentElement
  const expected = JSON.parse(readFileSync(new URL('./expected/stdio-v2-approval.json', import.meta.url), 'utf8'))
  assert.deepEqual({ title: view.document.getElementById('stdio-v2-title').textContent,
    note: view.document.getElementById('stdio-v2-note').textContent, heading: card.querySelector('h3').textContent,
    fields: [...card.querySelectorAll(':scope > p')].map(field => field.textContent), fullTask: card.querySelector('summary').textContent,
    confirmation: card.querySelector('label').textContent, decisions: [...card.querySelectorAll('button')].map(control => control.textContent) }, expected)
})

test('discover and call submit exactly one once/reject decision after a second independent inspect', async t => {
  for (const phase of ['discover', 'call']) for (const decision of ['once', 'reject']) await t.test(`${phase} ${decision}`, async t => {
    const view = page(t, { records: [approval(phase)] }); await view.inspect(); view.choose(decision)
    await until(() => view.area.textContent.includes(labels.submitted))
    assert.deepEqual(view.calls.map(call => call.path.split('/').at(-1)), ['list', 'inspect', 'inspect', 'decide'])
    assert.deepEqual(view.mutations()[0].body, { actionId, fingerprint: '2'.repeat(64), decision })
    assert.equal(view.mutations().length, 1)
    assert.equal(view.button(labels.once), undefined)
    const saved = JSON.parse(view.storage.getItem('pe-stdio-v2-approval-attempts'))
    assert.deepEqual(saved, [{ owner, actionId, fingerprint: '2'.repeat(64), decision }])
    assert(!JSON.stringify(saved).includes(token))
  })
})

test('a synchronous double click reserves the decision before its independent read awaits', async t => {
  const gate = deferred(); let reads = 0
  const view = page(t, { override: call => call.path.endsWith('/inspect') && ++reads === 2 ? gate.promise : undefined })
  await view.inspect(); const button = view.button(labels.once); view.choose(); button.click()
  assert.equal(reads, 2); assert.equal(view.mutations().length, 0)
  gate.resolve(Response.json(approval())); await until(() => view.mutations().length === 1); await view.settled()
  assert.equal(view.mutations().length, 1)
})

test('fresh fingerprint, argv order, empty argv, raw metadata, image or expiry changes refuse the decision', async t => {
  const changes = {
    fingerprint: view => { view.fingerprint = '3'.repeat(64) },
    order: view => { view.task.invocation.argv.reverse() },
    empty: view => { view.task.invocation.argv.shift() },
    metadata: view => { view.task.selection.rawDescriptor._meta.__proto__.keep = 'changed' },
    image: view => { view.actualExecutorImage.runtimeImageId = 'different' },
    expiry: view => { view.expiresAt = '2026-10-08T00:30:00Z' },
    decision: view => { view.decision = 'reject'; view.state = 'rejected' },
    expired: view => { view.expired = true },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    let reads = 0
    const view = page(t, { override: call => {
      if (!call.path.endsWith('/inspect') || ++reads !== 2) return
      const fresh = approval(); change(fresh); return Response.json(fresh)
    } })
    await view.inspect(); view.choose(); await view.settled()
    assert.equal(view.mutations().length, 0); assert.equal(view.button(labels.once), undefined)
    assert.equal(view.storage.getItem('pe-stdio-v2-approval-attempts'), null)
  })
})

test('owner/session/action/phase/task digest and actual image mismatches never enable deciding', async t => {
  const changes = [value => { value.task.userId = otherOwner }, value => { value.task.sessionId = id(99) },
    value => { value.task.actionId = id(99) }, value => { value.task.phase = 'discover' },
    value => { value.taskDigest = '0'.repeat(64) }, value => { value.actualExecutorImage.kind = 'desktop' },
    value => { value.capture = { token: 'must-not-render' } }]
  for (const change of changes) {
    const view = page(t, { override: call => {
      if (!call.path.endsWith('/inspect')) return
      const fresh = approval(); change(fresh); return Response.json(fresh)
    } })
    await view.component.refresh(owner); view.button(labels.inspect).click(); await view.settled()
    assert.equal(view.button(labels.once), undefined); assert.equal(view.mutations().length, 0)
    assert(!view.area.textContent.includes('must-not-render'))
  }
})

test('pagination exposes every candidate and permits backwards navigation', async t => {
  const view = page(t, { records: [approval('call'), approval('discover', id(20)), approval('call', id(21))] })
  await view.component.refresh(owner)
  for (const action of [id(20), id(21)]) {
    view.button(labels.next).click(); await until(() => view.area.textContent.includes(action))
  }
  assert.equal(view.button(labels.next), undefined)
  view.button(labels.previous).click(); await until(() => view.area.textContent.includes(id(20)))
  view.button(labels.previous).click(); await until(() => view.area.textContent.includes(actionId))
  assert.deepEqual(view.calls.map(call => call.body), [{ offset: 0, limit: 1 }, { offset: 1, limit: 1 },
    { offset: 2, limit: 1 }, { offset: 1, limit: 1 }, { offset: 0, limit: 1 }])
})

test('late list/inspect/decision reads after owner, credential, refresh or teardown cannot render or submit', async t => {
  for (const step of ['list', 'inspect', 'predecide', 'reply']) for (const transition of ['owner', 'credential', 'invalidate', 'reset'])
    await t.test(`${step} ${transition}`, async t => {
      const gate = deferred(); let reads = 0
      const view = page(t, { override: call => {
        if (step === 'list' && call.path.endsWith('/list') && call.init.headers.authorization === `Bearer ${token}`) return gate.promise
        if (call.path.endsWith('/inspect')) { reads++; if (step === 'inspect' && reads === 1 || step === 'predecide' && reads === 2) return gate.promise }
        if (step === 'reply' && call.path.endsWith('/decide')) return gate.promise
      } })
      let pending
      if (step === 'list') pending = view.component.refresh(owner)
      else if (step === 'inspect') { await view.component.refresh(owner); view.button(labels.inspect).click() }
      else { await view.inspect(); view.choose() }
      await until(() => step === 'reply' ? view.mutations().length === 1 : step === 'predecide' ? reads === 2 : view.calls.length > 0)
      if (transition === 'owner') {
        view.credential = 'second-owner-token'; view.state.records = [approval('call', id(30), otherOwner)]; await view.component.refresh(otherOwner)
      } else if (transition === 'credential') { view.credential = 'rotated-token'; view.component.invalidate() }
      else view.component[transition]()
      const before = view.area.textContent
      gate.resolve(step === 'list' ? Response.json({ items: [summary(approval())], nextOffset: null }) : Response.json(approval()))
      if (pending) await pending
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(view.area.textContent, before)
      assert.equal(view.mutations().length, step === 'reply' ? 1 : 0)
      assert.equal(view.calls[0].init.signal.aborted, true)
    })
})

test('lost decision reply and subsequent 404 preserve the original intent across reload and forbid another POST', async t => {
  const view = page(t, { override: (call, state) => {
    if (!call.path.endsWith('/decide')) return
    state.records[0].decision = call.body.decision; state.records[0].state = 'approved'
    throw new Error('Synthetic reply lost after saved decision')
  } })
  await view.inspect(); view.choose(); await until(() => view.area.textContent.includes(labels.uncertain)); await view.settled()
  assert.equal(view.mutations().length, 1); assert.equal(view.button(labels.once), undefined)
  const saved = view.storage.getItem('pe-stdio-v2-approval-attempts')
  view.state.missing = true; view.button(labels.reconcile).click(); await view.settled()
  assert(view.area.textContent.includes(labels.uncertain)); assert(view.area.textContent.includes('2'.repeat(64)))
  assert.equal(view.storage.getItem('pe-stdio-v2-approval-attempts'), saved)
  const reload = page(t, { saved }); await reload.inspect()
  assert.equal(reload.button(labels.once), undefined); assert(reload.area.textContent.includes(labels.uncertain))
  reload.state.records[0].decision = 'once'; reload.state.records[0].state = 'approved'
  reload.button(labels.reconcile).click(); await until(() => reload.area.textContent.includes(labels.submitted))
  assert.equal(reload.mutations().length, 0)
})

test('HTTP failure before or after possible sending never becomes an automatic retry', async t => {
  for (const status of [400, 404, 409, 500]) await t.test(String(status), async t => {
    const view = page(t, { override: call => call.path.endsWith('/decide') ? new Response('', { status }) : undefined })
    await view.inspect(); view.choose('reject'); await until(() => view.area.textContent.includes(labels.uncertain)); await view.settled()
    await view.component.refresh(owner); view.button(labels.inspect).click(); await view.settled()
    assert.equal(view.button(labels.reject), undefined); assert.equal(view.mutations().length, 1)
  })
})

test('unwritable/corrupt storage refuses sending; owner isolation does not erase another owner intent', async t => {
  const view = page(t); await view.inspect()
  view.window.Storage.prototype.setItem = () => { throw new Error('quota exhausted') }
  view.choose(); await view.settled(); assert.equal(view.mutations().length, 0)
  assert(view.area.textContent.includes(labels.storage))
  const corrupt = page(t, { saved: '{broken' }); await corrupt.inspect()
  assert.equal(corrupt.button(labels.once), undefined)
  const original = [{ owner, actionId, fingerprint: '2'.repeat(64), decision: 'once' }]
  const isolated = page(t, { saved: JSON.stringify(original), records: [approval('call', actionId, otherOwner)] })
  await isolated.inspect(otherOwner); isolated.choose('reject'); await until(() => isolated.area.textContent.includes(labels.submitted))
  assert.deepEqual(JSON.parse(isolated.storage.getItem('pe-stdio-v2-approval-attempts')).slice(0, 1), original)
})

test('disabled and unauthorized responses close only the STDIO section', async t => {
  for (const status of [503, 401]) {
    const view = page(t, { override: () => new Response('', { status }) })
    const old = view.document.getElementById('mcp-actions'); old.textContent = 'Existing MCP approvals retained'
    await view.component.refresh(owner)
    assert.equal(old.textContent, 'Existing MCP approvals retained')
    assert.equal(view.button(labels.once), undefined)
    assert.equal(view.unauthorized, status === 401 ? 1 : 0)
    if (status === 503) assert(view.area.textContent.includes(labels.closed))
  }
})

test('actual loopback endpoints receive the independent bearer and frozen decisions, never executor authority', async t => {
  const receipts = [], inspections = [], views = [approval('discover'), approval('call', id(40))]
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, `Bearer ${token}`)
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); let result
    if (request.url.endsWith('/list')) result = { items: [summary(views[body.offset])], nextOffset: body.offset === 0 ? 1 : null }
    else {
      const view = views.find(view => view.task.actionId === body.actionId)
      if (request.url.endsWith('/inspect')) { inspections.push(body); result = view }
      else { receipts.push(body); view.decision = body.decision; view.state = body.decision === 'once' ? 'approved' : 'rejected'; result = view }
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const view = page(t, { fetchOverride: (path, init) => fetch(new URL(path, origin), init) })
  await view.inspect(); view.choose(); await until(() => view.area.textContent.includes(labels.submitted))
  view.button(labels.next).click(); await until(() => view.area.textContent.includes(id(40)))
  view.button(labels.inspect).click(); await until(() => view.area.querySelector('input'))
  view.choose('reject'); await until(() => receipts.length === 2)
  assert.deepEqual(receipts, [{ actionId, fingerprint: '2'.repeat(64), decision: 'once' },
    { actionId: id(40), fingerprint: '2'.repeat(64), decision: 'reject' }])
  assert.equal(inspections.length, 4)
  assert(receipts.every(receipt => Object.keys(receipt).sort().join() === 'actionId,decision,fingerprint'))
})

test('shipped approval composition invalidates STDIO immediately before logout HTTP completes', async t => {
  const dom = new JSDOM(html, { url: 'https://platform.test/approval', runScripts: 'outside-only' })
  const { window } = dom, calls = [], logout = deferred(), predecide = deferred()
  t.after(() => window.close())
  window.sessionStorage.setItem('pe-approval-token', token)
  window.approvalCopy = approvalCopy
  window.AbortController = AbortController; window.AbortSignal = AbortSignal
  // The old execution-resolution leaf is independent here; its own shipped DOM regression covers its behavior.
  window.createExecutionResolutionApproval = () => ({ refresh: async () => {}, reset: () => {} })
  window.createStdioV2Approval = options => {
    const result = createStdioV2Approval({ ...options, now: () => now }); window.stdioFixture = result; return result
  }
  let reads = 0
  window.fetch = async (path, init = {}) => {
    calls.push({ path, init })
    if (path === '/config') return Response.json({ hostUrl: 'https://host.test' })
    if (path === '/approvals/me') return Response.json({ userId: owner, username: 'alice' })
    if (['/approvals/list', '/approvals/permissions', '/approvals/ssh-execute/list', '/approvals/mcp/list'].includes(path)) return Response.json({ items: [] })
    if (path === '/approvals/stdio-v2/list') return Response.json({ items: [summary(approval())], nextOffset: null })
    if (path === '/approvals/stdio-v2/inspect') return ++reads === 2 ? predecide.promise : Response.json(approval())
    if (path === '/approvals/logout') return logout.promise
    throw new Error(`Unexpected composition fixture endpoint ${path}`)
  }
  const script = readFileSync(new URL('../web/approval.js', import.meta.url), 'utf8')
    .replace("import { t } from './locale.js'", 'const t = globalThis.approvalCopy')
    .replace("import { createExecutionResolutionApproval } from './execution-resolution.js'", '')
    .replace("import { createStdioV2Approval } from './stdio-v2-approval.js'", '')
  runInContext(script, dom.getInternalVMContext())
  const area = window.document.getElementById('stdio-v2-actions')
  const button = label => [...area.querySelectorAll('button')].find(control => control.textContent === label)
  await until(() => button(labels.inspect))
  button(labels.inspect).click(); await until(() => area.querySelector('input') && !button(labels.inspect).disabled)
  const check = area.querySelector('input'); check.checked = true; check.dispatchEvent(new window.Event('change'))
  button(labels.once).click(); await until(() => reads === 2)
  window.document.getElementById('logout').click()
  assert.equal(area.querySelector('button'), null)
  assert.equal(calls.findLast(call => call.path === '/approvals/stdio-v2/inspect').init.signal.aborted, true)
  predecide.resolve(Response.json(approval())); await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call.path.endsWith('/decide')).length, 0)
  logout.resolve(Response.json({ ok: true })); await until(() => !window.document.getElementById('approval-login').hidden)
  assert.equal(area.textContent, '')
  window.stdioFixture.reset()
})
