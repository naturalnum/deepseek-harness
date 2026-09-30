/** Real approval DOM with explicit fetch substitutes; no backend or browser trial is started. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { t } from '../web/locale.js'

const html = readFileSync(new URL('../web/approval.html', import.meta.url), 'utf8')
const source = readFileSync(new URL('../web/approval.js', import.meta.url), 'utf8')
const importStatement = "import { t } from './locale.js'"
assert(source.includes(importStatement))
const actionId = '00000000-0000-4000-8000-000000000001'
const permissionId = '00000000-0000-4000-8000-000000000002'
const approvalToken = 'fixture-approval-audience', hostToken = 'fixture-host-audience'
const owner = { userId: '00000000-0000-4000-8000-000000000003', username: 'alice' }

function action(overrides = {}) {
  return { actionId, state: 'pending', fingerprint: 'a'.repeat(64), errorCode: null,
    tool: { formatVersion: 1, connectionId: '00000000-0000-4000-8000-000000000004',
      connectionRevision: 7, configurationRevision: 5, credentialRevision: 3,
      catalogId: '00000000-0000-4000-8000-000000000005', toolId: '00000000-0000-4000-8000-000000000006',
      descriptorDigest: 'b'.repeat(64), modelDigest: 'c'.repeat(64),
      raw: { name: 'original_write', description: 'Remote description', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false } },
      model: { name: 'mcp_fixed_alias', description: 'Admitted description', parameters: { type: 'object' } } },
    arguments: { destination: 'frozen target', message: 'exact text' },
    configuration: { displayName: 'Private knowledge', serverUrl: 'https://remote.example.test/mcp',
      authentication: 'headers', headerNames: ['X-API-Key'], secretConfigured: true, serverName: 'mcp_saved' },
    createdAt: '2026-09-30T00:00:00.000Z', expiresAt: '2099-09-30T00:00:00.000Z', permissionId: null, ...overrides }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Approval DOM did not reach the requested state')
}
function deferred() {
  let resolve
  const promise = new Promise(land => { resolve = land })
  return { promise, resolve }
}
function page(context, options = {}) {
  const dom = new JSDOM(html, { url: 'https://platform.example.test/approval', runScripts: 'outside-only' })
  context.after(() => dom.window.close())
  const { window } = dom, calls = []
  let records = structuredClone(options.items ?? [action()])
  const server = { calls, get items() { return records }, set items(value) { records = structuredClone(value) } }
  window.approvalLabels = t
  window.sessionStorage.setItem('pe-approval-token', approvalToken)
  window.sessionStorage.setItem('pe-token', hostToken)
  if (options.attempts) window.sessionStorage.setItem('pe-mcp-approval-attempts', options.attempts)
  window.fetch = async (path, init) => {
    const call = { path, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const override = await options.fetch?.(call, server)
    if (override !== undefined) return override
    switch (path) {
      case '/config': return Response.json({ hostUrl: 'https://host.example.test' })
      case '/approvals/me': return Response.json(options.owner ?? owner)
      case '/approvals/list': return Response.json({ items: options.notes ?? [] })
      case '/approvals/permissions': return Response.json({ items: [] })
      case '/approvals/ssh-execute/list': return Response.json({ items: options.ssh ?? [] })
      case '/approvals/mcp/list': return Response.json({ items: records })
      case '/approvals/mcp/decide': {
        const record = records.find(item => item.actionId === call.body.actionId)
        record.state = call.body.decision === 'reject' ? 'rejected' : 'approved'
        if (['session', 'persistent'].includes(call.body.decision)) record.permissionId = permissionId
        return Response.json({ actionId: record.actionId, state: record.state,
          fingerprint: record.fingerprint, errorCode: null })
      }
      case '/approvals/mcp/cancel': {
        const record = records.find(item => item.actionId === call.body.actionId)
        record.state = record.state === 'dispatch-intent' ? 'uncertain' : 'cancelled'
        return Response.json({ actionId: record.actionId, state: record.state,
          fingerprint: record.fingerprint, errorCode: null })
      }
      case '/approvals/mcp/revoke': return Response.json({ ok: true })
      case '/approvals/logout': return Response.json({ ok: true })
      case '/identity/approval-login': return Response.json({ token: 'fixture-next-approval', user: owner })
      default: throw new Error(`Unexpected fixture route: ${path}`)
    }
  }
  // Replace only the locale module import; execute the complete shipped script in its DOM realm.
  runInContext(source.replace(importStatement, 'const t = globalThis.approvalLabels'), dom.getInternalVMContext())
  return { window, document: window.document, server, calls,
    async ready() { await until(() => window.document.querySelector('#mcp-actions article')) },
    buttons(kind = 'decide') { return [...window.document.querySelectorAll(`button[data-mcp-attempt^="${kind}:"]`)] },
    mutations(kind = 'decide') { return calls.filter(call => call.path === `/approvals/mcp/${kind}`) },
  }
}

test('MCP review renders the frozen target, versions and exact arguments only as text', async context => {
  const attack = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>'
  const record = action()
  record.configuration.displayName = attack
  record.configuration.serverUrl = `javascript:${attack}`
  record.tool.raw.name = attack; record.tool.raw.description = attack
  record.arguments = { target: attack, nested: { exact: ['one', { two: attack }] } }
  const view = page(context, { items: [record] }); await view.ready()
  const area = view.document.getElementById('mcp-actions'), text = area.textContent
  assert(text.includes(record.configuration.serverUrl)); assert(text.includes(record.tool.raw.description))
  assert(text.includes('连接版本: 7')); assert(text.includes('配置版本: 5')); assert(text.includes('凭据版本: 3'))
  assert(text.includes(record.tool.catalogId)); assert(text.includes(record.tool.toolId)); assert(text.includes(record.fingerprint))
  assert.equal(area.querySelector('pre').textContent, JSON.stringify(record.arguments, null, 2))
  assert.equal(area.querySelector('img, script, iframe, a, input'), null)
  assert.equal(view.window.injected, undefined)
  assert.deepEqual(view.buttons().map(control => control.textContent), [
    '批准本次调用', '允许本操作所在会话使用此工具版本', '持续授权此工具版本（跨会话）', '拒绝本次调用',
  ])
  assert.equal(view.mutations().length, 0)
  assert(view.document.getElementById('mcp-note').textContent.includes('已发出的远端动作不能撤回'))
  for (const call of view.calls.filter(call => call.path.startsWith('/approvals/'))) {
    assert.equal(call.headers.authorization, `Bearer ${approvalToken}`)
  }
  assert.equal(view.window.sessionStorage.getItem('pe-token'), hostToken)
})

test('each explicit scope sends one frozen decision and ignores double clicks or other scope buttons', async context => {
  for (const [index, decision] of ['once', 'session', 'persistent', 'reject'].entries()) {
    await context.test(decision, async child => {
      const pending = deferred()
      const view = page(child, { fetch(call) {
        if (call.path === '/approvals/mcp/decide') return pending.promise
      } })
      await view.ready()
      const controls = view.buttons()
      controls[index].click(); controls[index].dispatchEvent(new view.window.MouseEvent('click'))
      controls[(index + 1) % controls.length].dispatchEvent(new view.window.MouseEvent('click'))
      await until(() => view.mutations().length === 1)
      assert.deepEqual(view.mutations()[0].body, { actionId, fingerprint: action().fingerprint, decision })
      assert(view.buttons().every(control => control.disabled))
      view.document.getElementById('refresh').click()
      await until(() => view.calls.filter(call => call.path === '/approvals/mcp/list').length === 3)
      controls[index].dispatchEvent(new view.window.MouseEvent('click'))
      assert.equal(view.mutations().length, 1)
      pending.resolve(Response.json({ actionId, fingerprint: action().fingerprint, state: 'pending', errorCode: null }))
      await until(() => view.document.getElementById('mcp-actions').textContent.includes('本次变更已经提交'))
      view.buttons()[index].dispatchEvent(new view.window.MouseEvent('click'))
      assert.equal(view.mutations().length, 1)
    })
  }
})

test('a lost decision response reconciles status and does not authorize again after list or page refresh', async context => {
  const view = page(context, { fetch(call) {
    if (call.path === '/approvals/mcp/decide') throw new Error('fixture lost response')
  } })
  await view.ready(); view.buttons()[0].click()
  await until(() => view.document.getElementById('mcp-actions').textContent.includes('本次变更已经提交'))
  assert.equal(view.mutations().length, 1)
  assert.equal(view.calls.filter(call => call.path === '/approvals/mcp/list').length, 3)
  view.document.getElementById('refresh').click()
  await until(() => view.document.querySelector('#mcp-actions article') && view.buttons().every(control => control.disabled))
  view.buttons()[2].dispatchEvent(new view.window.MouseEvent('click'))
  assert.equal(view.mutations().length, 1)
  const reload = page(context, { attempts: view.window.sessionStorage.getItem('pe-mcp-approval-attempts') })
  await reload.ready()
  assert(reload.buttons().every(control => control.disabled))
  reload.buttons()[0].dispatchEvent(new reload.window.MouseEvent('click'))
  assert.equal(reload.mutations().length, 0)
})

test('a changed fingerprint, argument, state or expiry requires a fresh explicit review', async context => {
  for (const changed of ['fingerprint', 'arguments', 'state', 'expiresAt']) {
    await context.test(changed, async child => {
      const view = page(child); await view.ready()
      const original = view.buttons()[0]
      const record = action({ [changed]: changed === 'fingerprint' ? 'd'.repeat(64)
        : changed === 'arguments' ? { message: 'different target' }
          : changed === 'state' ? 'approved' : '2000-01-01T00:00:00.000Z' })
      view.server.items = [record]; original.click()
      await until(() => view.document.getElementById('error').textContent.includes('本次没有提交变更'))
      assert.equal(view.mutations().length, 0)
      original.dispatchEvent(new view.window.MouseEvent('click'))
      assert.equal(view.mutations().length, 0)
    })
  }
})

test('an older list response cannot restore actionable pending controls after a newer refresh', async context => {
  const old = deferred(); let reads = 0
  const view = page(context, { fetch(call) {
    if (call.path === '/approvals/mcp/list' && ++reads === 1) return old.promise
  } })
  await until(() => reads === 1)
  view.server.items = [action({ state: 'approved' })]
  view.document.getElementById('refresh').click(); await view.ready()
  assert.equal(view.buttons().length, 0)
  old.resolve(Response.json({ items: [action()] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.buttons().length, 0)
  assert(view.document.getElementById('mcp-actions').textContent.includes(t.approvalApproved))
  assert.equal(view.mutations().length, 0)
})

test('cancellation sends only the action ID and displays uncertainty after dispatch intent', async context => {
  const view = page(context, { items: [action({ state: 'dispatch-intent' })] }); await view.ready()
  const control = view.buttons('cancel')[0]
  control.click(); control.dispatchEvent(new view.window.MouseEvent('click'))
  await until(() => view.document.getElementById('mcp-actions').textContent.includes(t.approvalUncertain))
  assert.deepEqual(view.mutations('cancel').map(call => call.body), [{ actionId }])
  assert.equal(view.buttons().length, 0); assert.equal(view.buttons('cancel').length, 0)
})

test('a shared permission ID is shown and revoked once, without promising remote rollback', async context => {
  const record = action({ state: 'succeeded', permissionId })
  const view = page(context, { items: [record, { ...record, actionId: '00000000-0000-4000-8000-000000000007' }] })
  await view.ready()
  assert(view.document.getElementById('mcp-actions').textContent.includes(permissionId))
  const controls = view.buttons('revoke'); controls[0].click()
  controls[1].dispatchEvent(new view.window.MouseEvent('click'))
  await until(() => view.buttons('revoke').every(control => control.textContent === '已撤销此许可'))
  assert.deepEqual(view.mutations('revoke').map(call => call.body), [{ permissionId }])
  assert(view.buttons('revoke').every(control => control.disabled))
  assert.equal(view.mutations().length, 0)
  assert(view.document.getElementById('mcp-note').textContent.includes('可能仍会完成'))
})

test('a lost revocation response stays unresolved because the list supplies no revocation status', async context => {
  const view = page(context, { items: [action({ state: 'succeeded', permissionId })], fetch(call) {
    if (call.path === '/approvals/mcp/revoke') throw new Error('fixture lost response')
  } })
  await view.ready(); view.buttons('revoke')[0].click()
  await until(() => view.document.getElementById('mcp-actions').textContent.includes('不能据此认定已撤销'))
  assert.equal(view.mutations('revoke').length, 1)
  assert(view.buttons('revoke')[0].disabled)
  assert.equal(view.buttons('revoke')[0].textContent, '撤销此许可')
})

test('a failed reconciliation keeps the original decision locked and reports an unknown outcome', async context => {
  let reads = 0
  const view = page(context, { fetch(call, server) {
    if (call.path === '/approvals/mcp/list' && ++reads === 3) return Response.json({ error: 'unavailable' }, { status: 503 })
    if (call.path === '/approvals/mcp/decide') {
      server.items = [action({ state: 'approved' })]
      throw new Error('fixture accepted but response lost')
    }
  } })
  await view.ready(); view.buttons()[0].click()
  await until(() => view.document.getElementById('error').textContent.includes('不能据此认定远端动作未执行'))
  assert.equal(view.mutations().length, 1); assert(view.buttons().every(control => control.disabled))
  view.document.getElementById('refresh').click()
  await until(() => view.buttons('cancel').some(control => !control.disabled))
  assert.equal(view.mutations().length, 1); assert.equal(view.buttons().length, 0)
})

test('a malformed revocation acknowledgement cannot display a confirmed revocation', async context => {
  const view = page(context, { items: [action({ state: 'succeeded', permissionId })], fetch(call) {
    if (call.path === '/approvals/mcp/revoke') return Response.json({ ok: false })
  } })
  await view.ready(); view.buttons('revoke')[0].click()
  await until(() => view.document.getElementById('mcp-actions').textContent.includes('不能据此认定已撤销'))
  assert.equal(view.buttons('revoke')[0].textContent, '撤销此许可')
  assert(view.buttons('revoke')[0].disabled); assert.equal(view.mutations('revoke').length, 1)
})

test('logout invalidates a pending status read before it can authorize an old review', async context => {
  const pending = deferred(); let reads = 0
  const view = page(context, { fetch(call) {
    if (call.path === '/approvals/mcp/list' && ++reads === 2) return pending.promise
  } })
  await view.ready(); view.buttons()[0].click()
  await until(() => reads === 2)
  view.document.getElementById('logout').click()
  await until(() => view.document.getElementById('approval-console').hidden)
  pending.resolve(Response.json({ items: [action()] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.mutations().length, 0)
  assert.equal(view.window.sessionStorage.getItem('pe-approval-token'), null)
})

test('a new login can approve while an earlier audience status read is still unresolved', async context => {
  const pending = deferred(); let reads = 0
  const view = page(context, { fetch(call) {
    if (call.path === '/approvals/mcp/list' && ++reads === 2) return pending.promise
  } })
  await view.ready(); view.buttons()[0].click(); await until(() => reads === 2)
  view.document.getElementById('logout').click()
  await until(() => view.document.getElementById('approval-console').hidden)
  view.document.getElementById('username').value = 'alice'
  view.document.getElementById('password').value = 'fixture-password'
  view.document.getElementById('approval-login').dispatchEvent(new view.window.Event('submit', { cancelable: true }))
  await until(() => !view.document.getElementById('approval-console').hidden && view.buttons().some(control => !control.disabled))
  view.buttons()[0].click()
  await until(() => view.buttons('cancel').some(control => !control.disabled))
  assert.equal(view.mutations().length, 1)
  assert.equal(view.mutations()[0].headers.authorization, 'Bearer fixture-next-approval')
  pending.resolve(Response.json({ items: [action()] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.mutations().length, 1); assert.equal(view.buttons().length, 0)
})

test('saved submission guards apply only to their independently authenticated account', async context => {
  const attempts = JSON.stringify({ owner: owner.userId, items: [[`decide:${actionId}`, 'submitted']] })
  const view = page(context, { attempts, owner: { userId: '00000000-0000-4000-8000-000000000099', username: 'bob' } })
  await view.ready(); assert(view.buttons().every(control => !control.disabled))
  view.buttons()[0].click()
  await until(() => view.buttons('cancel').some(control => !control.disabled))
  assert.equal(view.mutations().length, 1)
})

test('MCP unavailability preserves the existing notes and SSH review layout', async context => {
  const view = page(context, { fetch(call) {
    if (call.path === '/approvals/mcp/list') return Response.json({ error: 'unavailable' }, { status: 503 })
  }, notes: [{ actionId, state: 'pending', text: 'Existing note', fingerprint: 'old-note', createdAt: action().createdAt }],
  ssh: [{ actionId, state: 'pending', displayName: 'Existing SSH', username: 'worker', host: 'host.test', port: 22,
    workingDirectory: null, hostKeySha256: `SHA256:${'A'.repeat(43)}`, connectionRevision: 2, credentialRevision: 1,
    command: 'printf exact', fingerprint: 'old-ssh', createdAt: action().createdAt }] })
  await until(() => view.document.getElementById('mcp-actions').textContent.includes('无法读取 MCP 操作'))
  assert(view.document.getElementById('actions').textContent.includes('Existing note'))
  assert(view.document.getElementById('ssh-actions').textContent.includes('printf exact'))
  assert.equal(view.mutations().length, 0)
})

test('SSH review preserves the frozen directory, host key and command in its text snapshot', async context => {
  const record = { actionId, state: 'pending', displayName: '<b>Project host</b>', username: 'worker',
    host: 'host.test', port: 2222, workingDirectory: ' project ',
    hostKeySha256: `SHA256:${'A'.repeat(43)}`, connectionRevision: 4, credentialRevision: 2,
    command: 'CDPATH=; export CDPATH\ncd -- "${HOME:?}"/\' project \' || exit\nprintf "<script>literal</script>"',
    fingerprint: 'f'.repeat(64), createdAt: action().createdAt }
  const view = page(context, { ssh: [record], fetch(call) {
    if (call.path === '/approvals/ssh-execute/decide') {
      record.state = 'approved'
      return Response.json(record)
    }
  } })
  await view.ready()
  const card = view.document.querySelector('#ssh-actions article')
  const snapshot = [...card.children].filter(element => element.tagName !== 'SMALL')
    .map(element => ({ tag: element.tagName.toLowerCase(), text: element.textContent }))
  assert.deepEqual(snapshot, JSON.parse(readFileSync(new URL('./expected/ssh-approval.json', import.meta.url), 'utf8')))
  assert.equal(card.querySelector('script, b, img, iframe, a, input'), null)
  card.querySelector('button').click()
  await until(() => view.calls.some(call => call.path === '/approvals/ssh-execute/decide'))
  const sent = view.calls.find(call => call.path === '/approvals/ssh-execute/decide')
  assert.deepEqual(sent.body, { actionId, fingerprint: record.fingerprint, approve: true })
  assert.equal(sent.headers.authorization, `Bearer ${approvalToken}`)
  await until(() => view.document.querySelector('#ssh-actions button')?.textContent === t.approvalSshCancel)
})
