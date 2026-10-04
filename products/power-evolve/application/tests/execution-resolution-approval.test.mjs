/** Shipped trusted DOM/helper with actual shared Zod and explicit HTTP substitutes; not E2E. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
// The product's post-build Node test lane builds this shared protocol dependency first.
import * as schemas from '../../contracts/lib/execution-resolution.js'

const html = readFileSync(new URL('../web/approval.html', import.meta.url), 'utf8')
const source = readFileSync(new URL('../web/execution-resolution.js', import.meta.url), 'utf8')
const executionId = '00000000-0000-4000-8000-000000000001'
const sessionId = '00000000-0000-4000-8000-000000000002'
const requestId = '00000000-0000-4000-8000-000000000003'
const otherId = '00000000-0000-4000-8000-000000000004'
const owner = '00000000-0000-4000-8000-000000000005'
const token = 'fixture-approval-audience'
const item = { executionId, sessionId, target: 'cloud', executionState: 'uncertain',
  command: 'printf "<img src=x onerror=attack()>"', cwd: '/workspace',
  createdAt: '2026-10-03T00:00:00Z', errorCode: 'runner_unknown', resolution: null }
const inspection = { item, fingerprint: 'a'.repeat(64), canStop: true, blockedReason: null, runnerObservation: 'not_observed' }
const receipt = { executionId, sessionId, requestId, target: 'cloud', state: 'accepted', finalState: null,
  stopConfirmed: false, continuationQueued: false, errorCode: null }
const deviceItem = { ...item, target: 'desktop', command: 'printf original-device-command', cwd: 'project' }
const deviceInspection = { ...inspection, item: deviceItem, runnerObservation: 'stopped_unknown' }
const deviceReceipt = { ...receipt, target: 'desktop' }
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('Trusted DOM did not reach expected state')
}
function page(context, override = () => undefined, saved) {
  const dom = new JSDOM(html, { url: 'https://platform.test/approval', runScripts: 'outside-only' })
  context.after(() => dom.window.close())
  const { window } = dom, calls = [], timers = new Map()
  let currentToken = token, records = [structuredClone(item)], result = null, timerId = 0, uuidCount = 0
  const state = { get items() { return records }, set items(value) { records = value },
    get receipt() { return result }, set receipt(value) { result = value } }
  window.sharedSchemas = schemas
  window.AbortController = AbortController; window.AbortSignal = AbortSignal
  if (saved) window.sessionStorage.setItem('pe-execution-resolution-attempts', saved)
  window.fixtureOptions = { document: window.document, storage: window.sessionStorage,
    uuid: () => uuidCount++ === 0 ? requestId : otherId, credential: () => currentToken,
    unauthorized: () => { currentToken = null },
    delay: callback => { timers.set(++timerId, callback); return timerId }, cancelDelay: id => timers.delete(id),
    fetch: async (path, init) => {
      const call = { path, bytes: init.body, body: JSON.parse(init.body), headers: init.headers, signal: init.signal }
      calls.push(call)
      const overridden = await override(call, state)
      if (overridden !== undefined) return overridden
      if (path.endsWith('/list')) return Response.json({ available: true, items: records })
      if (path.endsWith('/inspect')) {
        const record = records.find(record => record.executionId === call.body.executionId && record.target === (call.body.target ?? 'cloud'))
        if (!record) return new Response('', { status: 404 })
        return Response.json({ ...inspection, item: record, runnerObservation: record.target === 'desktop' ? 'stopped_unknown' : 'not_observed',
          canStop: record.resolution === null, blockedReason: record.resolution ? 'already_requested' : null })
      }
      if (path.endsWith('/status')) return Response.json({ receipt: result })
      if (path.endsWith('/resolve')) {
        result = { ...receipt, requestId: call.body.requestId, target: call.body.target }
        records = records.map(record => record.executionId === call.body.executionId && record.target === call.body.target
          ? { ...record, resolution: result } : record)
        return Response.json(result)
      }
      throw new Error(`Unexpected route ${path}`)
    } }
  const script = source.replace(/import \{[\s\S]*?\} from '\.\/execution-resolution-contract\.js'/u,
    'const { executionResolutionsList, executionResolutionInspection, executionResolutionReceipt, executionResolutionStatus, executionResolutionRequest, executionResolutionInspectRequest, executionResolutionStatusRequest } = globalThis.sharedSchemas')
    .replaceAll('export ', '')
  runInContext(script + '\nglobalThis.component = createExecutionResolutionApproval(globalThis.fixtureOptions)', dom.getInternalVMContext())
  const component = window.component
  context.after(() => component.reset())
  return { window, document: window.document, calls, state, component, timers,
    button(label) { return [...window.document.querySelectorAll('#execution-resolutions button')].find(b => b.textContent === label) },
    mutations() { return calls.filter(call => call.path.endsWith('/resolve')) },
    async inspect(target = 'cloud') {
      await component.refresh(owner)
      window.document.querySelector(`article[data-execution-target="${target}"] button`).click()
      await until(() => window.document.querySelector('#execution-resolutions textarea'))
    },
    async confirm(note = '', target = 'cloud') {
      const input = window.document.querySelector('#execution-resolutions textarea'); input.value = note
      const check = window.document.querySelector('#execution-resolutions input'); check.checked = true
      check.dispatchEvent(new window.Event('change'))
      const count = this.mutations().length
      this.button(target === 'desktop' ? '核对已停止事实并以结果未知结案' : '停止旧执行者并对账').click()
      await until(() => this.mutations().length === count + 1)
    },
    async tick() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await new Promise(resolve => setImmediate(resolve)) },
  }
}

test('the original command is inert text and one checked confirmation sends only a frozen Cloud intent', async context => {
  const view = page(context); await view.inspect()
  assert.equal(view.document.getElementById('execution-resolutions').querySelector('img,script,iframe'), null)
  assert.equal(view.button('停止旧执行者并对账').disabled, true)
  assert.equal(view.mutations().length, 0)
  await view.confirm(' <img src=x onerror=attack()> ')
  await until(() => view.document.getElementById('execution-resolutions').textContent.includes('已受理停止'))
  assert.deepEqual(view.mutations()[0].body, { requestId, executionId, target: 'cloud', fingerprint: 'a'.repeat(64), note: '<img src=x onerror=attack()>' })
  assert(view.document.getElementById('execution-resolutions').textContent.includes('本次固定备注: <img'))
  assert.equal(view.document.getElementById('execution-resolutions').querySelector('img,script,iframe'), null)
  assert.equal(view.mutations()[0].bytes, JSON.stringify(view.mutations()[0].body))
  assert(view.calls.every(call => call.headers.authorization === `Bearer ${token}`))
  assert(view.calls.every(call => call.path.startsWith('/approvals/executions/')))
  assert.equal(view.document.querySelector('#execution-resolutions textarea'), null)
  const saved = JSON.parse(view.window.sessionStorage.getItem('pe-execution-resolution-attempts'))
  assert.equal(saved.items[0].bytes, view.mutations()[0].bytes)
})

test('live changed fingerprint or command and a canStop=false reason cannot submit', async context => {
  for (const change of ['fingerprint', 'command', 'cwd', 'blocked']) {
    await context.test(change, async child => {
      let reads = 0
      const view = page(child, call => {
        if (!call.path.endsWith('/inspect') || ++reads === 1) return
        return Response.json(change === 'fingerprint' ? { ...inspection, fingerprint: 'b'.repeat(64) }
          : change === 'command' ? { ...inspection, item: { ...item, command: 'other command' } }
            : change === 'cwd' ? { ...inspection, item: { ...item, cwd: '/other-directory' } }
            : { ...inspection, canStop: false, blockedReason: 'pod_uid_missing' })
      })
      await view.inspect()
      const checkbox = view.document.querySelector('#execution-resolutions input'); checkbox.checked = true
      checkbox.dispatchEvent(new view.window.Event('change')); view.button('停止旧执行者并对账').click()
      await until(() => view.document.getElementById('execution-resolutions').textContent.includes('本次没有提交'))
      assert.equal(view.mutations().length, 0)
      if (change === 'blocked') assert(view.document.getElementById('execution-resolutions').textContent.includes('pod_uid_missing'))
    })
  }
})

test('a lost response queries status first; refresh restores the receipt without a second mutation', async context => {
  const view = page(context, (call, state) => {
    if (call.path.endsWith('/resolve')) {
      state.receipt = receipt; state.items = [{ ...item, resolution: receipt }]
      throw new Error('accepted response lost')
    }
  })
  await view.inspect(); await view.confirm('frozen')
  await until(() => view.calls.some(call => call.path.endsWith('/status')))
  await view.component.refresh(owner)
  assert.equal(view.mutations().length, 1)
  assert.equal(view.button('停止旧执行者并对账'), undefined)
  const saved = view.window.sessionStorage.getItem('pe-execution-resolution-attempts')
  const reload = page(context, call => call.path.endsWith('/list') ? Response.json({ available: true,
    items: [{ ...item, resolution: receipt }] }) : undefined, saved)
  await reload.component.refresh(owner)
  assert.equal(reload.mutations().length, 0)
  assert(reload.document.getElementById('execution-resolutions').textContent.includes(requestId))
})

test('a missing receipt permits only an explicit status-first byte-identical retry', async context => {
  let sends = 0
  const view = page(context, call => {
    if (call.path.endsWith('/resolve') && ++sends === 1) throw new Error('not known accepted')
  })
  await view.inspect(); await view.confirm('immutable note')
  await until(() => view.button('核对状态后重试相同请求'))
  const first = view.mutations()[0].bytes
  view.button('核对状态后重试相同请求').click()
  await until(() => view.mutations().length === 2)
  assert.equal(view.mutations()[1].bytes, first)
  const second = view.calls.lastIndexOf(view.mutations()[1])
  assert.deepEqual(view.calls.slice(second - 2, second).map(call => call.path), [
    '/approvals/executions/status', '/approvals/executions/inspect',
  ])
})

test('completed closed_unknown and blocked receipts stop polling and never claim success', async context => {
  for (const terminal of ['completed', 'blocked']) {
    await context.test(terminal, async child => {
      const final = terminal === 'completed' ? { ...receipt, state: terminal, finalState: 'closed_unknown', stopConfirmed: true }
        : { ...receipt, state: terminal, errorCode: 'pod_uid_missing' }
      const view = page(child); view.state.items = [{ ...item,
        executionState: terminal === 'completed' ? 'closed_unknown' : 'uncertain', resolution: final }]
      await view.component.refresh(owner)
      assert.equal(view.timers.size, 0); assert.equal(view.mutations().length, 0)
      const text = view.document.getElementById('execution-resolutions').textContent
      if (terminal === 'completed') { assert(text.includes('副作用结果仍不明')); assert(!text.includes('已核验原执行成功')) }
      else assert(text.includes('pod_uid_missing'))
    })
  }
})

test('accepted/stopping polling is bounded, never resubmits and can resume from list after refresh', async context => {
  const view = page(context); view.state.items = [{ ...item, resolution: receipt }]
  await view.component.refresh(owner)
  for (let i = 0; i < 20; i++) await view.tick()
  assert.equal(view.timers.size, 0)
  assert.equal(view.calls.filter(call => call.path.endsWith('/list')).length, 15)
  assert(view.document.getElementById('execution-resolutions').textContent.includes('本轮自动查询已停止'))
  assert.equal(view.mutations().length, 0)
  await view.component.refresh(owner); assert.equal(view.timers.size, 1)
})

test('revoked audience clears the sensitive DOM; invalid Origin or 500 cannot claim completion', async context => {
  for (const status of [401, 403, 500]) {
    await context.test(String(status), async child => {
      let reject = false
      const view = page(child, call => reject && call.path.endsWith('/list') ? new Response('', { status }) : undefined)
      await view.component.refresh(owner); reject = true
      await assert.rejects(view.component.refresh(owner))
      const area = view.document.getElementById('execution-resolutions')
      assert(!area.textContent.includes('对账已结案'))
      if (status === 401) { assert.equal(area.textContent, ''); assert.equal(view.timers.size, 0) }
      assert.equal(view.mutations().length, 0)
    })
  }
})

test('mismatched or malformed receipts and saved requests never become a confirmed result', async context => {
  const view = page(context, call => call.path.endsWith('/resolve') ? Response.json({ ...receipt, executionId: otherId }) : undefined)
  await view.inspect(); await view.confirm()
  await until(() => view.calls.some(call => call.path.endsWith('/status')))
  assert.equal(view.button('停止旧执行者并对账'), undefined)
  assert(!view.document.getElementById('execution-resolutions').textContent.includes('对账已结案'))
  const bad = JSON.stringify({ owner, items: [{ bytes: JSON.stringify({ requestId, executionId, target: 'cloud',
    fingerprint: 'a'.repeat(64), note: '', stopProof: { forged: true } }) }] })
  const reload = page(context, () => undefined, bad)
  await reload.inspect()
  assert.equal(reload.mutations().length, 0); assert(reload.document.querySelector('#execution-resolutions textarea'))
})

test('double clicks and a pending inspection after reset or owner change never send another intent', async context => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  let inspections = 0
  const view = page(context, call => call.path.endsWith('/inspect') && ++inspections === 2 ? pending : undefined)
  await view.inspect()
  const checkbox = view.document.querySelector('#execution-resolutions input'); checkbox.checked = true
  checkbox.dispatchEvent(new view.window.Event('change'))
  const button = view.button('停止旧执行者并对账')
  button.click(); button.dispatchEvent(new view.window.MouseEvent('click'))
  await until(() => inspections === 2)
  view.component.reset()
  await view.component.refresh(otherId)
  finish(Response.json(inspection))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view.mutations().length, 0)
  assert.equal(view.document.querySelector('#execution-resolutions textarea'), null)
  assert.equal(view.timers.size, 0)
})

test('local retry storage failure and an invalid note refuse the mutation before dispatch', async context => {
  for (const invalid of ['storage', 'note']) {
    await context.test(invalid, async child => {
      const view = page(child); await view.inspect()
      if (invalid === 'storage') view.window.Storage.prototype.setItem = () => { throw new Error('quota failure') }
      const input = view.document.querySelector('#execution-resolutions textarea')
      input.value = invalid === 'note' ? '\u0001' : 'valid note'
      const checkbox = view.document.querySelector('#execution-resolutions input'); checkbox.checked = true
      checkbox.dispatchEvent(new view.window.Event('change')); view.button('停止旧执行者并对账').click()
      await until(() => view.document.getElementById('execution-resolutions').textContent.includes('无法核对执行状态'))
      assert.equal(view.mutations().length, 0)
    })
  }
})

test('an older inspection cannot replace a later selected original execution', async context => {
  let finish
  const first = new Promise(resolve => { finish = resolve })
  const secondItem = { ...item, executionId: otherId, command: 'printf second original' }
  const view = page(context, call => {
    if (call.path.endsWith('/inspect')) return call.body.executionId === executionId ? first
      : Response.json({ ...inspection, item: secondItem })
  })
  view.state.items = [item, secondItem]; await view.component.refresh(owner)
  const controls = [...view.document.querySelectorAll('#execution-resolutions button')]
  controls[0].click(); controls[1].click()
  await until(() => view.document.querySelector('#execution-resolutions textarea'))
  const review = view.document.querySelector('#execution-resolutions').children[1]
  assert(review.textContent.includes(secondItem.command))
  finish(Response.json(inspection)); await new Promise(resolve => setImmediate(resolve))
  assert(review.textContent.includes(secondItem.command)); assert(!review.textContent.includes(item.command))
  assert.equal(view.mutations().length, 0)
})

test('Cloud and Device sharing an execution ID keep distinct inspected targets, retry bytes and receipts', async context => {
  const view = page(context); view.state.items = [item, deviceItem]
  await view.inspect(); await view.confirm('cloud note')
  await until(() => view.state.items[0].resolution !== null)
  await view.inspect('desktop')
  assert(view.document.querySelector('#execution-resolutions').textContent.includes('执行目标: 本地设备'))
  assert.equal(view.button('停止旧执行者并对账'), undefined)
  await view.confirm('device note', 'desktop')
  await until(() => view.state.items[1].resolution !== null)
  assert.deepEqual(view.mutations().map(call => call.body.target), ['cloud', 'desktop'])
  assert.deepEqual(view.mutations().map(call => call.body.note), ['cloud note', 'device note'])
  const saved = JSON.parse(view.window.sessionStorage.getItem('pe-execution-resolution-attempts'))
  assert.deepEqual(saved.items.map(entry => JSON.parse(entry.bytes).target), ['cloud', 'desktop'])
  assert(view.calls.filter(call => call.path.endsWith('/inspect')).every(call => ['cloud', 'desktop'].includes(call.body.target)))
  assert.equal(view.state.items[0].resolution.target, 'cloud'); assert.equal(view.state.items[1].resolution.target, 'desktop')
})

test('Device lost acceptance response queries its target without resubmitting and restores the target after reload', async context => {
  const view = page(context, (call, state) => {
    if (call.path.endsWith('/resolve')) {
      state.receipt = deviceReceipt; state.items = [{ ...deviceItem, resolution: deviceReceipt }]
      throw new Error('device acceptance response lost')
    }
  })
  view.state.items = [deviceItem]; await view.inspect('desktop'); await view.confirm('frozen device note', 'desktop')
  await until(() => view.calls.some(call => call.path.endsWith('/status')))
  await view.component.refresh(owner)
  assert.equal(view.mutations().length, 1)
  assert.equal(view.mutations()[0].body.target, 'desktop')
  assert(view.calls.filter(call => call.path.endsWith('/status')).every(call => call.body.target === 'desktop'))
  assert.equal(view.button('核对已停止事实并以结果未知结案'), undefined)
  const saved = view.window.sessionStorage.getItem('pe-execution-resolution-attempts')
  const reload = page(context, call => call.path.endsWith('/status') ? Response.json({ receipt: deviceReceipt }) : undefined, saved)
  reload.state.items = [deviceItem]; await reload.component.refresh(owner)
  assert.equal(reload.mutations().length, 0)
  assert(reload.calls.some(call => call.path.endsWith('/status') && call.body.target === 'desktop'))
  assert.equal(JSON.parse(saved).items[0].bytes, view.mutations()[0].bytes)
})

test('Device receipts from another target with the same IDs never authorize completion or a retry dispatch', async context => {
  const view = page(context, call => call.path.endsWith('/resolve') || call.path.endsWith('/status')
    ? Response.json(call.path.endsWith('/resolve') ? receipt : { receipt }) : undefined)
  view.state.items = [deviceItem]; await view.inspect('desktop'); await view.confirm('frozen', 'desktop')
  await until(() => view.button('核对状态后重试相同请求'))
  assert.equal(view.mutations().length, 1)
  assert(!view.document.querySelector('#execution-resolutions').textContent.includes('对账已结案'))
  const first = view.mutations()[0].bytes
  view.button('核对状态后重试相同请求').click()
  // A wrong-provider status is not a missing receipt and cannot authorize a second dispatch.
  await until(() => view.document.querySelector('#execution-resolutions').textContent.includes('无法核对执行状态'))
  assert.equal(view.mutations().length, 1); assert.equal(JSON.parse(first).target, 'desktop')
  assert(view.calls.filter(call => call.path.endsWith('/status')).every(call => call.body.target === 'desktop'))
})

test('Device missing receipt permits an explicit status-first byte-identical retry', async context => {
  let sends = 0
  const view = page(context, call => {
    if (call.path.endsWith('/resolve') && ++sends === 1) throw new Error('device receipt not yet known')
  })
  view.state.items = [deviceItem]; await view.inspect('desktop'); await view.confirm('immutable device note', 'desktop')
  await until(() => view.button('核对状态后重试相同请求'))
  assert.equal(view.mutations().length, 1)
  const first = view.mutations()[0].bytes; view.button('核对状态后重试相同请求').click()
  await until(() => view.mutations().length === 2)
  assert.equal(view.mutations()[1].bytes, first); assert.equal(JSON.parse(first).target, 'desktop')
  const second = view.calls.lastIndexOf(view.mutations()[1])
  assert.deepEqual(view.calls.slice(second - 2, second).map(call => [call.path, call.body.target]), [
    ['/approvals/executions/status', 'desktop'], ['/approvals/executions/inspect', 'desktop'],
  ])
})

test('Device with no trusted stopped observation cannot submit or inject client stop proof', async context => {
  for (const mode of ['blocked', 'running', 'recheck', 'target-changed']) {
    await context.test(mode, async child => {
      let reads = 0
      const view = page(child, call => {
        if (!call.path.endsWith('/inspect')) return
        reads++
        if ((mode === 'recheck' || mode === 'target-changed') && reads === 1) return Response.json(deviceInspection)
        if (mode === 'target-changed') return Response.json(inspection)
        return Response.json(mode === 'blocked' ? { ...deviceInspection, canStop: false, blockedReason: 'device_stop_observation_missing' }
          : mode === 'recheck' ? { ...deviceInspection, canStop: false, blockedReason: 'device_stop_observation_missing', runnerObservation: 'unavailable' }
            : { ...deviceInspection, runnerObservation: 'running' })
      })
      view.state.items = [deviceItem]; await view.component.refresh(owner); view.button('检查原执行').click()
      if (mode === 'recheck' || mode === 'target-changed') {
        await until(() => view.document.querySelector('#execution-resolutions textarea'))
        const check = view.document.querySelector('#execution-resolutions input'); check.checked = true
        check.dispatchEvent(new view.window.Event('change')); view.button('核对已停止事实并以结果未知结案').click()
        await until(() => view.document.querySelector('#execution-resolutions').textContent.includes(mode === 'recheck' ? '本次没有提交' : '无法核对执行状态'))
      } else await until(() => view.document.querySelector('#execution-resolutions').textContent.includes(mode === 'blocked' ? 'device_stop_observation_missing' : '无法核对执行状态'))
      assert.equal(view.mutations().length, 0); assert.equal(view.document.querySelector('#execution-resolutions input'), null)
    })
  }
  const forged = JSON.stringify({ owner, items: [{ bytes: JSON.stringify({ requestId, executionId, target: 'desktop',
    fingerprint: 'a'.repeat(64), note: '', stopProof: { Running: false } }) }] })
  const view = page(context, () => undefined, forged); view.state.items = [deviceItem]
  await view.inspect('desktop'); assert.equal(view.mutations().length, 0)
  await view.confirm('', 'desktop'); assert.equal('stopProof' in view.mutations()[0].body, false)
})

test('trusted hashes retain explicit target, accept old Cloud hashes, and reject unknown providers without fallback', async context => {
  for (const target of ['cloud', 'desktop', 'legacy', 'ssh']) {
    await context.test(target, async child => {
      const view = page(child); view.state.items = [item, deviceItem]
      view.window.location.hash = `#execution=${executionId}${target === 'legacy' ? '' : '&target=' + target}`
      if (target === 'ssh') await assert.rejects(view.component.refresh(owner))
      else await view.component.refresh(owner)
      const calls = view.calls.filter(call => call.path.endsWith('/inspect'))
      assert.equal(calls.length, target === 'ssh' ? 0 : 1)
      if (calls.length) assert.equal(calls[0].body.target, target === 'legacy' ? 'cloud' : target)
      assert.equal(view.mutations().length, 0)
    })
  }
})
