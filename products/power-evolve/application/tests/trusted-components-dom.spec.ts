/** Exercise the original trusted DOM components; wire fixtures grant no Platform authority. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'

const web = process.env.PE_WEB_DOM_ROOT ?? resolve(import.meta.dirname, '../web')
const USER = '7f257f12-6670-472c-a263-9ce5a9314090'
const OTHER = '2f257f12-6670-472c-a263-9ce5a9314090'
const EXEC = '3f257f12-6670-472c-a263-9ce5a9314090'
const SESSION = '4f257f12-6670-472c-a263-9ce5a9314090'
const REQUEST = '5f257f12-6670-472c-a263-9ce5a9314090'
const ACTION = '6f257f12-6670-472c-a263-9ce5a9314090'
const CONNECTION = '8f257f12-6670-472c-a263-9ce5a9314090'
const WORKSPACE = '9f257f12-6670-472c-a263-9ce5a9314090'
const FP = 'a'.repeat(64)
const EXEC_KEY = 'pe-execution-resolution-attempts'
const STDIO_KEY = 'pe-stdio-v2-approval-attempts'
type RecordValue = Record<string, unknown>
type Call = { path: string; init: RequestInit | undefined; body: RecordValue }
type Handler = (call: Call) => unknown
type Gate = { settled: boolean; release: () => void }
const gates = new WeakMap<Promise<unknown>, Gate>()
const responseGates = new WeakMap<Response, Gate>()
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function deferred() {
  let fulfill!: (value: unknown) => void, fail!: (error: Error) => void
  const promise = new Promise<unknown>((yes, no) => { fulfill = yes; fail = no })
  const gate: Gate = { settled: false, release: () => { done(response({}, 499)) } }
  const done = (value: unknown) => { if (!gate.settled) { gate.settled = true; fulfill(value) } }
  const reject = (error: Error) => { if (!gate.settled) { gate.settled = true; fail(error) } }
  gates.set(promise, gate)
  return { promise, resolve: done, reject }
}
function heldBody() {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (controller) => { writer = controller } })
  const reply = new Response(body, { headers: { 'content-type': 'application/json' } })
  const gate: Gate = { settled: false, release: () => { finish({}) } }
  const finish = (value: unknown) => {
    if (gate.settled) return
    gate.settled = true; writer.enqueue(new TextEncoder().encode(JSON.stringify(value))); writer.close()
  }
  responseGates.set(reply, gate)
  return { reply, resolve: finish }
}
type Lifecycle = { refresh: (owner: string) => Promise<void>; reset: () => void; invalidate?: () => void }
type MountOptions = {
  document: Document
  storage: Storage
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  credential: () => string
  unauthorized: () => void
  now?: () => number
  uuid?: () => string
  delay?: (callback: () => void, ms: number) => number
  cancelDelay?: (handle: number) => void
}
type Mounted = { dom: JSDOM; pending: Set<Promise<unknown>>; operations: Set<Promise<void>>; close: () => Promise<void> }
const fixtures: Mounted[] = []
async function page(kind: 'execution' | 'stdio', options: { handler?: Handler
  saved?: string | undefined
  token?: string | undefined
  hash?: string
  defaults?: boolean } = {}) {
  const dom = new JSDOM(await readFile(resolve(web, 'approval.html'), 'utf8'), { url: 'https://platform.example/approval' + (options.hash ?? '') })
  const pending = new Set<Promise<unknown>>(), owned = new Set<Gate>(), timers = new Map<number, () => void>()
  const operations = new Set<Promise<void>>()
  // Observe rejection immediately, but preserve the original promise for the case's await/rejects assertion.
  const observe = (operation: Promise<void>): Promise<void> => {
    const completion: Promise<void> = operation.then(
      () => { operations.delete(completion) },
      () => { operations.delete(completion) },
    )
    operations.add(completion)
    return operation
  }
  let closing = false, token = options.token ?? 'synthetic-independent-approval-token', now = Date.parse('2026-01-01T00:00:00Z'), nextTimer = 0
  let credential = () => token
  let afterRead: (call: Call) => void = () => {}
  const lifecycles: Lifecycle[] = []
  const close = async () => {
    closing = true; for (const lifecycle of lifecycles) lifecycle.reset()
    for (const gate of owned) gate.release()
    await Promise.all([...operations])
    await vi.waitFor(async () => {
      await nextTurn(); expect(pending.size).toBe(0); expect(operations.size).toBe(0); expect(timers.size).toBe(0)
    })
  }
  fixtures.push({ dom, pending, operations, close })
  if (options.saved !== undefined) dom.window.sessionStorage.setItem(kind === 'execution' ? EXEC_KEY : STDIO_KEY, options.saved)
  const storage: Storage = {
    get length() { return dom.window.sessionStorage.length },
    getItem: key => dom.window.sessionStorage.getItem(key),
    setItem: (key, value) => { dom.window.sessionStorage.setItem(key, value) },
    removeItem: (key) => { dom.window.sessionStorage.removeItem(key) },
    clear: () => { dom.window.sessionStorage.clear() },
    key: index => dom.window.sessionStorage.key(index),
  }
  const calls: Call[] = []
  const track = <T>(promise: Promise<T>): Promise<T> => { pending.add(promise); return promise.finally(() => { pending.delete(promise) }) }
  const fetcher = vi.fn((path: string, init?: RequestInit) => track((async () => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (!record(body)) throw new Error('Expected an owned request object')
    const call = { path, init, body }; calls.push(call)
    let value = closing ? response({}, 499) : options.handler?.(call)
    if (value === undefined) {
      if (path === '/approvals/executions/list') value = { available: true, items: [] }
      else if (path === '/approvals/stdio-v2/list') value = { items: [], nextOffset: null }
      else if (path === '/approvals/executions/status') value = { receipt: null }
      else throw new Error('Unexpected owned request: ' + path)
    }
    const promise = Promise.resolve(value), gate = gates.get(promise)
    if (gate) owned.add(gate)
    const raw = await promise, reply = raw instanceof Response ? raw : response(raw)
    const bodyGate = responseGates.get(reply)
    if (bodyGate) owned.add(bodyGate)
    const json = reply.json.bind(reply), text = reply.text.bind(reply)
    reply.json = () => track(json().then((value: unknown) => { afterRead(call); return value }))
    reply.text = () => track(text().then((value) => { afterRead(call); return value }))
    return reply
  })()))
  const loaded: unknown = await import(resolve(web, kind === 'execution' ? 'execution-resolution.js' : 'stdio-v2-approval.js'))
  const name = kind === 'execution' ? 'createExecutionResolutionApproval' : 'createStdioV2Approval'
  if (!record(loaded) || typeof loaded[name] !== 'function') throw new Error('Missing original component export')
  const mount = loaded[name] as (options: MountOptions) => Lifecycle
  const unauthorized = vi.fn()
  const timing: Partial<MountOptions> = options.defaults ? {} : {
    now: () => now, uuid: () => REQUEST,
    delay: (callback, ms) => { expect(ms).toBe(2000); const id = ++nextTimer; timers.set(id, callback); return id },
    cancelDelay: (handle) => { timers.delete(handle) },
  }
  const component = mount({ document: dom.window.document, storage, fetch: fetcher,
    credential: () => credential(), unauthorized, ...timing })
  const invalidate = component.invalidate?.bind(component)
  const lifecycle: Lifecycle = {
    refresh: owner => observe(component.refresh(owner)),
    reset: () => { component.reset() },
    ...(invalidate ? { invalidate } : {}),
  }
  lifecycles.push(lifecycle)
  const area = dom.window.document.getElementById(kind === 'execution' ? 'execution-resolutions' : 'stdio-v2-actions')!
  const status = () => area.querySelector('[role="status"]')!.textContent
  const buttons = () => Array.from(area.querySelectorAll<HTMLButtonElement>('button'))
  const button = (text: string) => {
    const found = buttons().find(node => node.textContent === text)
    expect(found, text).toBeDefined(); return found!
  }
  const click = (node: HTMLElement) => node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }))
  const check = (value = true) => { const input = area.querySelector<HTMLInputElement>('input')!
    input.checked = value
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    return input }
  const idle = async () => { await vi.waitFor(async () => { await nextTurn(); expect(pending.size).toBe(0) }) }
  const tick = async () => {
    const entry = timers.entries().next().value; expect(entry).toBeDefined()
    const [id, callback] = entry!; timers.delete(id); callback(); await idle()
  }
  return { dom, area, storage, calls, fetcher, pending, timers, lifecycle, unauthorized, status, button, buttons, click, check, idle, tick,
    token: (value: string) => { token = value }, credential: (reader: () => string) => { credential = reader },
    afterRead: (effect: (call: Call) => void) => { afterRead = effect },
    clock: (value: number) => { now = value }, close }
}
afterEach(async () => {
  const owned = fixtures.splice(0)
  const unfinished = owned.map(fixture => ({ requests: fixture.pending.size, operations: fixture.operations.size }))
  try { for (const fixture of owned) await fixture.close()
    expect(unfinished, 'the case must settle its requests and complete its refresh operations')
      .toEqual(owned.map(() => ({ requests: 0, operations: 0 }))) }
  finally { for (const fixture of owned) fixture.dom.window.close(); vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules() }
})
type Page = Awaited<ReturnType<typeof page>>
const text = (p: Page) => p.area.textContent ?? ''
const mutations = (p: Page) => p.calls.filter(call => /\/(resolve|decide)$/u.test(call.path))
function executionItem(overrides: RecordValue = {}) { return { executionId: EXEC, sessionId: SESSION, target: 'cloud', executionState: 'uncertain', command: 'printf "<script>synthetic</script>"', cwd: '/workspace/中文', createdAt: '2026-01-01T00:00:00Z', errorCode: null, resolution: null, ...overrides } }
function inspection(overrides: RecordValue = {}) { return { item: executionItem(), fingerprint: FP, canStop: true, blockedReason: null, runnerObservation: 'running', ...overrides } }
function receipt(overrides: RecordValue = {}) { return { requestId: REQUEST, executionId: EXEC, sessionId: SESSION, target: 'cloud', state: 'accepted', finalState: null, stopConfirmed: false, continuationQueued: false, errorCode: null, ...overrides } }
function executionRequest(overrides: RecordValue = {}) { return { requestId: REQUEST, executionId: EXEC, target: 'cloud', fingerprint: FP, note: '固定备注', ...overrides } }
const savedExecution = (requests: RecordValue[] = [executionRequest()], owner = USER) => JSON.stringify({
  owner, items: requests.map(request => ({ bytes: JSON.stringify(request) })),
})
async function executionPage(handler?: Handler, options: { saved?: string; hash?: string } = {}) {
  const p = await page('execution', { ...options, handler: call => handler?.(call) ?? (call.path.endsWith('/list') ? { available: true, items: [executionItem()] } : call.path.endsWith('/inspect') ? inspection() : undefined) })
  await p.lifecycle.refresh(USER); await p.idle(); return p
}
async function inspectExecution(p: Page) { p.click(p.button('检查原执行')); await p.idle() }
async function resolveExecution(p: Page) { p.check(); p.click(p.button('停止旧执行者并对账')); await p.idle() }

test('execution requires explicit confirmation, displays exact command as text and sends one original identity and note', async () => {
  const hold = deferred()
  const p = await executionPage(call => call.path.endsWith('/resolve') ? hold.promise : undefined)
  await inspectExecution(p)
  expect(text(p)).toContain('printf "<script>synthetic</script>"'); expect(p.area.querySelector('script')).toBeNull()
  const submit = p.button('停止旧执行者并对账'); expect(submit.disabled).toBe(true); p.click(submit); expect(mutations(p)).toHaveLength(0)
  const note = p.area.querySelector('textarea')!; expect(note.maxLength).toBe(500); note.value = '  核对备注  '
  p.check(); p.check(false); expect(submit.disabled).toBe(true); p.check(); p.click(submit)
  await vi.waitFor(() => { expect(mutations(p)).toHaveLength(1) }); p.click(submit)
  expect(mutations(p)[0]).toMatchObject({ body: executionRequest({ note: '核对备注' }), init: { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { authorization: 'Bearer synthetic-independent-approval-token' } } })
  const stored: unknown = JSON.parse(p.dom.window.sessionStorage.getItem(EXEC_KEY)!)
  expect(stored).toEqual({ owner: USER, items: [{ bytes: mutations(p)[0]!.init!.body }] })
  hold.resolve(receipt())
  await p.idle()
  expect(mutations(p)).toHaveLength(1)
  expect(text(p)).toContain('已受理停止与对账意图')
  expect(p.timers.size).toBe(1)
})
test.each(['succeeded', 'failed', 'cancelled', 'closed_unknown'])('execution completed %s renders terminal facts without another resolution control', async (finalState) => {
  const r = receipt({ state: 'completed', finalState, stopConfirmed: true, continuationQueued: true })
  const p = await executionPage(call => call.path.endsWith('/list') ? { available: true, items: [executionItem({ executionState: finalState, resolution: r })] } : call.path.endsWith('/inspect') ? inspection({ item: executionItem({ executionState: finalState, resolution: r }), canStop: false, blockedReason: 'already_closed' }) : undefined)
  await inspectExecution(p)
  expect(text(p)).toContain('对账已结案')
  expect(p.buttons().some(node => node.textContent === '停止旧执行者并对账')).toBe(false)
  if (finalState === 'closed_unknown') expect(text(p)).toContain('这不表示成功或失败')
  expect(p.timers.size).toBe(0); expect(mutations(p)).toHaveLength(0)
})
test('execution shows blocked and unknown observations without a stop control', async () => {
  const p = await executionPage(call => call.path.endsWith('/list') ? { available: true, items: [executionItem({ executionState: 'closed_unknown', errorCode: 'synthetic_reason' })] } : call.path.endsWith('/inspect') ? inspection({ canStop: false, fingerprint: null, blockedReason: 'stop_unavailable', runnerObservation: 'unavailable' }) : undefined)
  await inspectExecution(p)
  expect(text(p)).toContain('synthetic_reason')
  expect(text(p)).toContain('stop_unavailable')
  expect(text(p)).toContain('这不表示成功或失败')
  expect(mutations(p)).toHaveLength(0)
})
test.each(['command', 'cwd', 'fingerprint', 'canStop', 'sessionId', 'executionId'])('execution refuses a changed %s at the second inspection', async (field) => {
  let reads = 0
  const p = await executionPage((call) => {
    if (!call.path.endsWith('/inspect')) return undefined
    if (++reads === 1) return inspection()
    if (field === 'fingerprint') return inspection({ fingerprint: 'b'.repeat(64) })
    if (field === 'canStop') return inspection({ canStop: false, blockedReason: 'not_stoppable' })
    return inspection({ item: executionItem({ [field]: field === 'command' || field === 'cwd' ? 'changed' : OTHER }) })
  })
  await inspectExecution(p); await resolveExecution(p); expect(mutations(p)).toHaveLength(0); expect(p.status()).toMatch(/变化|无法核对/u)
  expect(p.dom.window.sessionStorage.getItem(EXEC_KEY)).toBeNull()
})
test('execution storage failure prevents the outbound request and removes the unsaved attempt', async () => {
  const p = await executionPage(); await inspectExecution(p)
  vi.spyOn(p.storage, 'setItem').mockImplementation(() => { throw new Error('synthetic storage refusal') })
  await resolveExecution(p)
  expect(mutations(p)).toHaveLength(0)
  expect(p.status()).toContain('无法核对')
  expect(text(p)).not.toContain('本次固定备注')
})
test.each(['lost', 'bad-receipt'])('execution %s response queries status and never automatically replays the command', async (kind) => {
  const p = await executionPage(call => call.path.endsWith('/resolve') ? kind === 'lost' ? Promise.reject(new Error('synthetic lost response')) : receipt({ requestId: OTHER }) : undefined)
  await inspectExecution(p); await resolveExecution(p)
  expect(mutations(p)).toHaveLength(1)
  expect(p.calls.some(call => call.path.endsWith('/status'))).toBe(true)
  expect(text(p)).toContain('尚未查到原请求')
  const retry = p.button('核对状态后重试相同请求'); p.click(retry); await p.idle()
  expect(mutations(p)).toHaveLength(2); expect(mutations(p)[1]!.init!.body).toBe(mutations(p)[0]!.init!.body)
})
test('execution restored attempt is checked before an explicit retry and an existing receipt prevents resend', async () => {
  let statuses = 0
  const p = await executionPage(call => call.path.endsWith('/status') ? { receipt: ++statuses < 3 ? null : receipt() } : undefined, { saved: savedExecution() })
  await inspectExecution(p); p.click(p.button('核对状态后重试相同请求')); await p.idle()
  expect(mutations(p)).toHaveLength(0)
  expect(text(p)).toContain('已受理停止与对账意图')
  expect(p.calls.filter(call => call.path.endsWith('/status'))).toHaveLength(4)
})
test.each(['invalid-json', 'wrong-owner', 'wrong-items', 'too-many', 'bad-item', 'long-bytes', 'noncanonical', 'duplicate'])('execution local %s cannot authorize a fresh request', async (kind) => {
  const bytes = JSON.stringify(executionRequest())
  const saved = kind === 'invalid-json' ? '{' : JSON.stringify({ owner: kind === 'wrong-owner' ? OTHER : USER, items: kind === 'wrong-items' ? {} : kind === 'too-many' ? Array.from({ length: 101 }, () => ({ bytes })) : kind === 'bad-item' ? [null, { bytes: '{}' }, { bytes: 1 }] : kind === 'long-bytes' ? [{ bytes: 'x'.repeat(1501) }] : kind === 'noncanonical' ? [{ bytes: JSON.stringify(executionRequest(), null, 2) }] : [{ bytes }, { bytes }] })
  const p = await executionPage(undefined, { saved }); await inspectExecution(p)
  expect(mutations(p)).toHaveLength(0); expect(text(p).includes('核对状态后重试相同请求')).toBe(kind === 'duplicate')
})
test.each(['401', '403', 'bad-json', 'too-large', 'unavailable', 'duplicate'])('execution %s read does not display an actionable reconciliation', async (kind) => {
  const p = await page('execution', { handler: () => kind === '401' || kind === '403' ? response({}, Number(kind)) : kind === 'bad-json' ? new Response('{') : kind === 'too-large' ? new Response(' '.repeat(2 * 1024 * 1024 + 1)) : { available: kind !== 'unavailable', items: kind === 'duplicate' ? [executionItem(), executionItem()] : [] } })
  await expect(p.lifecycle.refresh(USER)).rejects.toThrow()
  await p.idle()
  expect(mutations(p)).toHaveLength(0)
  expect(p.buttons()).toHaveLength(0)
  expect(p.unauthorized).toHaveBeenCalledTimes(kind === '401' ? 1 : 0)
})
test.each(['#execution=' + EXEC, '#execution=' + EXEC + '&target=cloud', '#execution=' + OTHER, '#execution=' + EXEC + '&other=x', '#execution=' + EXEC + '&execution=' + EXEC, '#execution=' + EXEC + '&target=cloud&target=cloud', '#execution=' + EXEC + '&target=ssh'])('execution hash %s selects only a listed original identity and a supported target', async (hash) => {
  const invalid = hash.includes('other=') || hash.includes('&execution=') || hash.includes('&target=cloud&') || hash.includes('target=ssh')
  const p = await page('execution', { hash, handler: call => call.path.endsWith('/list') ? { available: true, items: [executionItem()] } : call.path.endsWith('/inspect') ? inspection() : undefined })
  if (invalid) await expect(p.lifecycle.refresh(USER)).rejects.toThrow(); else await p.lifecycle.refresh(USER)
  await p.idle()
  expect(p.calls.filter(call => call.path.endsWith('/inspect'))).toHaveLength(!invalid && !hash.includes(OTHER) ? 1 : 0)
  expect(mutations(p)).toHaveLength(0)
})
test('execution automatic polling ends after 15 reads, and a manual refresh restarts the observational budget', async () => {
  const r = receipt({ state: 'stopping' })
  const p = await executionPage(call => call.path.endsWith('/list') ? { available: true, items: [executionItem({ resolution: r })] } : undefined)
  for (let count = 1; count < 15; count++) await p.tick()
  expect(p.status()).toContain('自动查询已停止'); expect(p.timers.size).toBe(0); expect(mutations(p)).toHaveLength(0)
  await p.lifecycle.refresh(USER); expect(p.timers.size).toBe(1); p.lifecycle.reset(); expect(p.timers.size).toBe(0)
})
test.each(['inspect', 'resolve', 'status'])('execution reset during %s prevents a late response from changing the next owner UI', async (stage) => {
  const held = deferred(); let armed = false, holding = false
  const p = await page('execution', { saved: stage === 'status' ? savedExecution() : undefined, handler: (call) => {
    if (armed && call.path.endsWith('/' + stage)) { holding = true; return held.promise }
    if (call.path.endsWith('/list')) return { available: true, items: [executionItem()] }
    if (call.path.endsWith('/inspect')) return inspection()
    if (call.path.endsWith('/resolve')) return receipt()
    return undefined
  } })
  await p.lifecycle.refresh(USER)
  await p.idle()
  if (stage !== 'status') { await inspectExecution(p)
    armed = true
    p.check()
    p.click(p.button('停止旧执行者并对账')) } else { armed = true
    p.click(p.button('检查原执行')) }
  await vi.waitFor(() => { expect(holding).toBe(true)
    expect(p.pending.size).toBe(1) })
  p.lifecycle.reset()
  p.token('new-independent-token')
  armed = false
  await p.lifecycle.refresh(OTHER); const before = text(p)
  held.resolve(stage === 'inspect' ? inspection() : stage === 'status' ? { receipt: receipt() } : receipt())
  await p.idle(); expect(text(p)).toBe(before); expect(p.unauthorized).not.toHaveBeenCalled()
})

function stdioSummary(overrides: RecordValue = {}) { return { formatVersion: 2, actionId: ACTION, sessionId: SESSION, connectionId: CONNECTION, configRevision: 1, phase: 'discover', taskDigest: FP, state: 'pending', executionRef: { kind: 'cloud', executionId: EXEC }, ...overrides } }
function stdioView(overrides: RecordValue = {}) {
  const platform = { os: 'linux', arch: 'arm64' }, image = { kind: 'cloud', imageReference: 'synthetic.invalid/runtime@sha256:' + FP, runtimeImageId: 'runtime-1', platform }
  return { task: { formatVersion: 2, userId: USER, actionId: ACTION, sessionId: SESSION, connectionId: CONNECTION, configRevision: 1, phase: 'discover', invocation: { program: 'synthetic-program', argv: ['--完整参数', '<script>untrusted</script>'], cwd: '/workspace/中文' }, scopeBinding: { kind: 'cloud', userId: USER, workspaceId: WORKSPACE, bindingGeneration: 1, home: { kind: 'user', userId: USER }, target: { kind: 'cloud', executionId: EXEC } }, expectedDeploymentPin: { kind: 'cloud', imageReference: image.imageReference, runtimeImageIds: ['runtime-1'], platform } }, actualExecutorImage: image, taskDigest: FP, preparedDigest: 'b'.repeat(64), fingerprint: 'c'.repeat(64), approvalEpoch: 1, expiresAt: '2050-01-01T00:00:00Z', state: 'pending', expired: false, decision: null, ...overrides }
}
function changed(value: unknown, path: string, replacement: unknown): RecordValue {
  const copy: unknown = JSON.parse(JSON.stringify(value)); if (!record(copy)) throw new Error('Expected fixture object')
  const parts = path.split('.'), leaf = parts.pop()!; let target = copy
  for (const part of parts) { const next = target[part]; if (!record(next)) throw new Error('Expected fixture parent'); target = next }
  target[leaf] = replacement; return copy
}
const stdioPrior = (overrides: RecordValue = {}) => ({ owner: USER, actionId: ACTION, fingerprint: 'c'.repeat(64), decision: 'once', ...overrides })
async function stdioPage(handler?: Handler, options: { saved?: string | undefined; summary?: RecordValue } = {}) {
  const original = options.summary ?? stdioSummary()
  const p = await page('stdio', { saved: options.saved, handler: call => handler?.(call) ?? (call.path.endsWith('/list') ? { items: [original], nextOffset: null } : call.path.endsWith('/inspect') ? stdioView() : undefined) })
  await p.lifecycle.refresh(USER); await p.idle(); return p
}
async function inspectStdio(p: Page) { p.click(p.button('核对冻结任务')); await p.idle() }
async function decideStdio(p: Page, label = '批准本次') { p.check(); p.click(p.button(label)); await p.idle() }
test.each(['once', 'reject'])('STDIO %s displays complete frozen content and sends exactly one confirmed decision after a fresh inspection', async (decision) => {
  const held = deferred(), label = decision === 'once' ? '批准本次' : '拒绝本次'
  const p = await stdioPage(call => call.path.endsWith('/decide') ? held.promise : undefined); await inspectStdio(p)
  for (const value of ['synthetic-program', '--完整参数', '<script>untrusted</script>', '/workspace/中文', 'runtime-1', WORKSPACE, USER, FP]) expect(text(p)).toContain(value)
  expect(p.area.querySelector('script')).toBeNull()
  expect(p.area.querySelector('details pre')!.textContent).toBe(JSON.stringify(stdioView().task, null, 2))
  const submit = p.button(label); expect(submit.disabled).toBe(true); p.click(submit); expect(mutations(p)).toHaveLength(0)
  p.check(); p.check(false); expect(submit.disabled).toBe(true); p.check(); p.click(submit)
  await vi.waitFor(() => { expect(mutations(p)).toHaveLength(1) }); p.click(submit)
  expect(mutations(p)[0]).toMatchObject({ body: { actionId: ACTION, fingerprint: 'c'.repeat(64), decision }, init: { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { authorization: 'Bearer synthetic-independent-approval-token' } } })
  expect(JSON.parse(p.dom.window.sessionStorage.getItem(STDIO_KEY)!)).toEqual([stdioPrior({ decision })])
  held.resolve(stdioView({ state: 'approved', decision }))
  await p.idle()
  expect(p.status()).toContain('原决定已保存')
  expect(p.buttons().some(node => node.textContent === label)).toBe(false)
  expect(mutations(p)).toHaveLength(1)
})
test('STDIO call renders exact tool arguments and object order changes retain the frozen review', async () => {
  const v = stdioView(); v.task.phase = 'call'
  const call = { ...v.task, selection: { rawName: 'untrusted_tool', arguments: { z: ['x', null], a: { nested: false } } } }
  let reads = 0
  const p = await stdioPage(request => request.path.endsWith('/inspect') ? { ...v, task: ++reads === 1 ? call : { ...call, selection: { arguments: { a: { nested: false }, z: ['x', null] }, rawName: 'untrusted_tool' } } } : request.path.endsWith('/decide') ? { ...v, task: call, state: 'approved', decision: 'once' } : undefined, { summary: stdioSummary({ phase: 'call' }) })
  await inspectStdio(p)
  expect(text(p)).toContain('untrusted_tool')
  expect(text(p)).toContain('"nested": false')
  await decideStdio(p)
  expect(mutations(p)).toHaveLength(1)
  expect(p.status()).toContain('原决定已保存')
})
test.each(['state', 'decision', 'expired', 'clock'])('STDIO nonactionable %s observation renders no decision controls', async (field) => {
  const p = await stdioPage(request => request.path.endsWith('/inspect') ? stdioView(field === 'state' ? { state: 'completed' } : field === 'decision' ? { decision: 'reject' } : field === 'expired' ? { expired: true } : { expiresAt: '2020-01-01T00:00:00Z' }) : undefined)
  await inspectStdio(p)
  expect(p.buttons().some(node => ['批准本次', '拒绝本次'].includes(node.textContent))).toBe(false)
  expect(mutations(p)).toHaveLength(0)
})
test.each(['state', 'expired', 'fingerprint', 'argv', 'array-length', 'array-kind', 'object-key', 'nested-null'])('STDIO changed %s at fresh inspection prevents the decision and local sending record', async (field) => {
  let reads = 0
  const p = await stdioPage((call) => {
    if (!call.path.endsWith('/inspect')) return undefined
    if (++reads === 1) return field === 'array-kind' ? changed(stdioView(), 'task.scopeBinding.target', { kind: 'cloud', executionId: EXEC, metadata: [] }) : undefined
    if (field === 'state') return stdioView({ state: 'approved' })
    if (field === 'expired') return stdioView({ expired: true })
    if (field === 'fingerprint') return stdioView({ fingerprint: 'd'.repeat(64) })
    if (field === 'argv') return changed(stdioView(), 'task.invocation.argv', ['changed'])
    if (field === 'array-length') return changed(stdioView(), 'task.scopeBinding.target', { kind: 'cloud', executionId: EXEC, extra: [] })
    if (field === 'array-kind') return changed(stdioView(), 'task.scopeBinding.target', { kind: 'cloud', executionId: EXEC, metadata: {} })
    if (field === 'object-key') return changed(stdioView(), 'task.scopeBinding.target', { kind: 'cloud', replacement: EXEC })
    return changed(stdioView(), 'task.scopeBinding.target', { kind: 'cloud', executionId: null })
  })
  await inspectStdio(p)
  await decideStdio(p)
  expect(p.status()).toContain('冻结内容或审批状态已变化')
  expect(mutations(p)).toHaveLength(0)
  expect(p.dom.window.sessionStorage.getItem(STDIO_KEY)).toBeNull()
})
test.each(['write', 'readback', 'get', 'malformed'])('STDIO %s sending-record failure prevents the outbound decision', async (kind) => {
  const p = await stdioPage(); await inspectStdio(p)
  if (kind === 'write') vi.spyOn(p.storage, 'setItem').mockImplementation(() => { throw new Error('synthetic storage failure') })
  if (kind === 'readback') vi.spyOn(p.storage, 'setItem').mockImplementation(() => {})
  if (kind === 'get') vi.spyOn(p.storage, 'getItem').mockImplementation(() => { throw new Error('synthetic storage failure') })
  if (kind === 'malformed') p.dom.window.sessionStorage.setItem(STDIO_KEY, '{}')
  await decideStdio(p); expect(p.status()).toMatch(/无法保存|无法核对/u); expect(mutations(p)).toHaveLength(0)
})
test.each(['lost', 'wrong-decision', 'changed-reply'])('STDIO %s decision response preserves the original attempt and only offers reconciliation', async (kind) => {
  const p = await stdioPage(call => call.path.endsWith('/decide') ? kind === 'lost' ? Promise.reject(new Error('synthetic lost response')) : stdioView({ decision: kind === 'wrong-decision' ? 'reject' : 'once', fingerprint: kind === 'changed-reply' ? 'd'.repeat(64) : 'c'.repeat(64) }) : undefined)
  await inspectStdio(p)
  await decideStdio(p)
  expect(p.status()).toContain('发送结果尚不确定')
  expect(mutations(p)).toHaveLength(1)
  p.click(p.button('核对原决定'))
  await p.idle()
  expect(mutations(p)).toHaveLength(1)
})
test.each(['matching', 'different', 'other-owner'])('STDIO stored %s attempt stays owner-scoped and reconciles without resend', async (kind) => {
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? stdioView({ decision: kind === 'matching' ? 'once' : null }) : undefined, { saved: JSON.stringify([stdioPrior({ owner: kind === 'other-owner' ? OTHER : USER })]) })
  await inspectStdio(p); expect(mutations(p)).toHaveLength(0)
  if (kind === 'other-owner') expect(p.button('批准本次').disabled).toBe(true)
  else { expect(p.status()).toContain(kind === 'matching' ? '原决定已保存' : '发送结果尚不确定')
    p.click(p.button('核对原决定'))
    await p.idle()
    expect(mutations(p)).toHaveLength(0) }
})
test.each(['not-array', 'bad-item', 'extra-key', 'owner', 'action', 'fingerprint', 'decision', 'duplicate', 'bad-json'])('STDIO malformed %s local record never grants a decision control', async (kind) => {
  const item = stdioPrior()
  const saved = kind === 'bad-json' ? '{' : JSON.stringify(kind === 'not-array' ? {} : kind === 'bad-item' ? [null] : kind === 'duplicate' ? [item, item] : [{ ...item, ...(kind === 'extra-key' ? { extra: true } : kind === 'owner' ? { owner: 'invalid' } : kind === 'action' ? { actionId: 'invalid' } : kind === 'fingerprint' ? { fingerprint: 'invalid' } : { decision: 'persistent' }) }])
  const p = await stdioPage(undefined, { saved })
  await inspectStdio(p)
  expect(p.status()).toContain('无法保存或读取')
  expect(p.buttons().some(node => node.textContent === '批准本次')).toBe(false)
  expect(mutations(p)).toHaveLength(0)
})
test.each(['401', '503', '403', 'bad-json'])('STDIO %s read closes or reports the section without exposing decisions', async (kind) => {
  const p = await page('stdio', { handler: () => kind === 'bad-json' ? new Response('{') : response({}, Number(kind)) })
  await p.lifecycle.refresh(USER)
  await p.idle()
  expect(p.status()).toBe(kind === '503' ? 'STDIO 审批已关闭。' : kind === '401' ? '' : '无法核对 STDIO 审批；未发送新的决定。')
  expect(p.unauthorized).toHaveBeenCalledTimes(kind === '401' ? 1 : 0)
  expect(mutations(p)).toHaveLength(0)
})
test('STDIO pagination reads one candidate, previous and first use exact offsets, and empty pages stay read-only', async () => {
  const p = await stdioPage(call => call.path.endsWith('/list') ? { items: call.body.offset === 2 ? [] : [stdioSummary()], nextOffset: call.body.offset === 2 ? null : Number(call.body.offset) + 1 } : undefined)
  p.click(p.button('下一页')); await p.idle(); expect(p.calls.at(-1)!.body).toEqual({ offset: 1, limit: 1 })
  p.click(p.button('上一页')); await p.idle(); expect(p.calls.at(-1)!.body).toEqual({ offset: 0, limit: 1 })
  p.click(p.button('下一页')); await p.idle(); p.click(p.button('下一页')); await p.idle(); expect(text(p)).toContain('暂无 STDIO 审批记录')
  p.click(p.button('返回第一页'))
  await p.idle()
  expect(p.calls.at(-1)!.body).toEqual({ offset: 0, limit: 1 })
  expect(mutations(p)).toHaveLength(0)
})
test.each(['bad-owner', 'no-token'])('STDIO refresh with %s performs no read', async (kind) => {
  const p = await page('stdio', { token: kind === 'no-token' ? '' : undefined })
  await p.lifecycle.refresh(kind === 'bad-owner' ? 'invalid' : USER)
  expect(p.calls).toHaveLength(0)
  expect(p.status()).toContain('无法核对')
})
test.each(['list', 'inspect', 'pre-read', 'decide'])('STDIO invalidate during %s keeps the late result out of the next owner review', async (stage) => {
  const hold = deferred(); let armed = stage === 'list', reads = 0
  const p = await page('stdio', { handler: (call) => {
    if (armed && (stage === 'list' && call.path.endsWith('/list') || stage === 'inspect' && call.path.endsWith('/inspect') || stage === 'decide' && call.path.endsWith('/decide') || stage === 'pre-read' && call.path.endsWith('/inspect') && ++reads === 1)) return hold.promise
    if (call.path.endsWith('/list')) return { items: [stdioSummary()], nextOffset: null }
    if (call.path.endsWith('/inspect')) return stdioView()
    if (call.path.endsWith('/decide')) return stdioView({ decision: 'once', state: 'approved' })
    return undefined
  } })
  let initial: Promise<void> | undefined
  if (stage === 'list') initial = p.lifecycle.refresh(USER)
  else { await p.lifecycle.refresh(USER)
    await p.idle()
    if (stage === 'inspect') { armed = true
      p.click(p.button('核对冻结任务')) } else { await inspectStdio(p)
      armed = true
      p.check()
      p.click(p.button('批准本次')) } }
  await vi.waitFor(() => { expect(p.pending.size).toBe(1)
    expect(p.calls.at(-1)?.path).toBe('/approvals/stdio-v2/' + (stage === 'list' ? 'list' : stage === 'decide' ? 'decide' : 'inspect')) })
  const oldButtons = p.buttons()
  p.lifecycle.invalidate!()
  armed = false
  await p.lifecycle.refresh(OTHER)
  const before = text(p)
  hold.resolve(stage === 'list' ? { items: [], nextOffset: null } : stdioView({ decision: stage === 'decide' ? 'once' : null }))
  await initial
  await p.idle()
  for (const node of oldButtons) p.click(node)
  expect(text(p)).toBe(before); expect(mutations(p)).toHaveLength(stage === 'decide' ? 1 : 0); expect(p.unauthorized).not.toHaveBeenCalled()
})

test('execution stale list failure cannot overwrite a new owner status', async () => {
  const hold = deferred(); let reads = 0
  const p = await page('execution', { handler: () => ++reads === 1 ? hold.promise : { available: true, items: [] } })
  const original = p.lifecycle.refresh(USER).catch(() => {})
  await vi.waitFor(() => { expect(p.pending.size).toBe(1) })
  p.lifecycle.reset(); p.token('new-independent-token'); await p.lifecycle.refresh(OTHER)
  expect(p.status()).toBe(''); const current = text(p)
  hold.resolve({ available: true, items: [executionItem()] }); await original; await p.idle()
  expect(p.status()).toBe(''); expect(text(p)).toBe(current)
})
test('execution stale same-owner refresh failure cannot overwrite the newer refresh status', async () => {
  const hold = deferred(); let reads = 0
  const p = await page('execution', { handler: () => ++reads === 1 ? hold.promise : { available: true, items: [] } })
  const original = p.lifecycle.refresh(USER).catch(() => {})
  await vi.waitFor(() => { expect(p.pending.size).toBe(1) }); await p.lifecycle.refresh(USER)
  const current = text(p); expect(p.status()).toBe('')
  hold.resolve(response({}, 403)); await original; await p.idle()
  expect(p.status()).toBe(''); expect(text(p)).toBe(current)
})
test('execution stale button failure cannot overwrite a new owner status', async () => {
  const hold = deferred()
  const p = await executionPage(call => call.path.endsWith('/inspect') ? hold.promise : undefined)
  p.click(p.button('检查原执行')); await vi.waitFor(() => { expect(p.pending.size).toBe(1) })
  p.lifecycle.reset(); p.token('new-independent-token'); await p.lifecycle.refresh(OTHER)
  const current = text(p); expect(p.status()).toBe('')
  hold.resolve(response({}, 401)); await p.idle()
  expect(p.status()).toBe(''); expect(text(p)).toBe(current); expect(p.unauthorized).not.toHaveBeenCalled()
})
test('execution default timers and UUID remain observational and reset cancels the scheduled read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const schedule = vi.spyOn(globalThis, 'setTimeout'), cancel = vi.spyOn(globalThis, 'clearTimeout')
  const p = await page('execution', { defaults: true, handler: call => call.path.endsWith('/list') ? { available: true, items: [executionItem()] } : call.path.endsWith('/inspect') ? inspection() : call.path.endsWith('/resolve') ? receipt({ requestId: call.body.requestId }) : undefined })
  await p.lifecycle.refresh(USER); await inspectExecution(p); await resolveExecution(p)
  expect(mutations(p)).toHaveLength(1); expect(mutations(p)[0]!.body.requestId).toMatch(/^[a-f\d-]{36}$/u)
  const index = schedule.mock.calls.findIndex(call => call[1] === 2000)
  expect(index).toBeGreaterThanOrEqual(0); expect(schedule.mock.calls.filter(call => call[1] === 2000)).toHaveLength(1)
  const handle: unknown = schedule.mock.results[index]!.value
  p.lifecycle.reset(); expect(cancel).toHaveBeenCalledWith(handle)
})
test('execution empty list and read-only queued states display the original state without a decision', async () => {
  const p = await page('execution'); await p.lifecycle.refresh(USER); expect(text(p)).toContain('没有不确定执行')
  const q = await executionPage(call => call.path.endsWith('/list') ? { available: true, items: [executionItem({ executionState: 'queued' })] } : undefined)
  expect(text(q)).toContain('queued'); expect(mutations(q)).toHaveLength(0)
})
test('execution preserved frozen controls stay disabled and detached inspect cannot run while submit is busy', async () => {
  const hold = deferred()
  const p = await executionPage(call => call.path.endsWith('/resolve') ? hold.promise : undefined); await inspectExecution(p)
  const inspect = p.button('检查原执行'), check = p.area.querySelector<HTMLInputElement>('input')!
  check.dataset.frozen = 'true'; p.check(); expect(check.disabled).toBe(true)
  p.click(p.button('停止旧执行者并对账')); await vi.waitFor(() => { expect(mutations(p)).toHaveLength(1) })
  const before = p.calls.length; p.click(inspect); expect(p.calls).toHaveLength(before)
  hold.resolve(receipt())
  await p.idle()
  const settledCalls = p.calls.length
  p.token('')
  p.click(inspect)
  expect(p.calls).toHaveLength(settledCalls)
})
test.each(['mismatched-request', 'mismatched-session', 'regression', 'changed-terminal-state', 'changed-final-state'])('execution receipt %s never replaces an established fact', async (kind) => {
  let reads = 0
  const initial = receipt(kind.startsWith('changed-') ? { state: 'completed', finalState: 'succeeded', stopConfirmed: true } : { state: 'stopping' })
  const later = receipt(kind === 'mismatched-request' ? { requestId: OTHER } : kind === 'mismatched-session' ? { sessionId: OTHER } : kind === 'regression' ? {} : kind === 'changed-terminal-state' ? { state: 'blocked', errorCode: 'blocked' } : { state: 'completed', finalState: 'failed', stopConfirmed: true })
  const makeItem = (r: ReturnType<typeof receipt>) => executionItem({ resolution: r, sessionId: r.sessionId, executionState: r.state === 'completed' ? r.finalState : 'uncertain' })
  const p = await executionPage(call => call.path.endsWith('/list') ? { available: true, items: [makeItem(++reads === 1 ? initial : later)] } : undefined)
  if (kind === 'regression') { await p.lifecycle.refresh(USER); expect(text(p)).toContain('正在停止旧执行者') }
  else { await expect(p.lifecycle.refresh(USER)).rejects.toThrow(); expect(p.status()).toContain('无法核对') }
  expect(mutations(p)).toHaveLength(0)
})
test('execution blocked receipt displays its reason and a preserved attempt cannot offer another stop', async () => {
  const r = receipt({ state: 'blocked', errorCode: 'synthetic_blocked' })
  const p = await executionPage(call => call.path.endsWith('/list') ? { available: true, items: [executionItem({ resolution: r })] } : call.path.endsWith('/inspect') ? inspection({ canStop: false, blockedReason: 'blocked' }) : undefined, { saved: savedExecution() })
  await inspectExecution(p)
  expect(text(p)).toContain('synthetic_blocked')
  expect(p.buttons().some(node => node.textContent === '核对状态后重试相同请求')).toBe(false)
})
test('execution a preserved attempt on a now-unavailable target shows its frozen note without offering retry', async () => {
  const p = await executionPage(call => call.path.endsWith('/inspect') ? inspection({ canStop: false, blockedReason: 'stop_unavailable' }) : undefined, { saved: savedExecution() })
  await inspectExecution(p)
  expect(text(p)).toContain('固定备注')
  expect(p.buttons().some(node => node.textContent === '核对状态后重试相同请求')).toBe(false)
})
test('execution rejects a mismatched inspection identity and allows a fresh read without sending', async () => {
  const p = await executionPage(call => call.path.endsWith('/inspect') ? inspection({ item: executionItem({ executionId: OTHER }) }) : undefined)
  await inspectExecution(p)
  expect(p.status()).toContain('无法核对')
  expect(p.area.querySelector('textarea')).toBeNull()
  expect(mutations(p)).toHaveLength(0)
})
test('execution a failed status query after a lost response remains uncertain without automatic replay', async () => {
  const p = await executionPage(call => call.path.endsWith('/resolve') || call.path.endsWith('/status') ? Promise.reject(new Error('synthetic response failure')) : undefined)
  await inspectExecution(p)
  await resolveExecution(p)
  expect(mutations(p)).toHaveLength(1)
  expect(text(p)).toContain('尚未查到原请求')
  expect(p.calls.filter(call => call.path.endsWith('/status'))).toHaveLength(2)
})
test.each(['post-submit', 'timer'])('execution failed %s list reports unavailable without replay or another polling timer', async (kind) => {
  let lists = 0
  const p = await executionPage(call => call.path.endsWith('/list') ? ++lists === 1 ? { available: true, items: [executionItem({ resolution: kind === 'timer' ? receipt() : null })] } : Promise.reject(new Error('synthetic read failure')) : call.path.endsWith('/resolve') ? receipt() : undefined)
  if (kind === 'timer') await p.tick(); else { await inspectExecution(p); await resolveExecution(p) }
  expect(p.status()).toContain('无法核对'); expect(p.timers.size).toBe(0); expect(mutations(p)).toHaveLength(kind === 'timer' ? 0 : 1)
})
test('execution maximum 100 local attempts prevents a 101st resolution request', async () => {
  const requests = Array.from({ length: 100 }, (_, index) => executionRequest({ executionId: '00000000-0000-4000-8000-' + String(index).padStart(12, '0') }))
  const p = await executionPage(undefined, { saved: savedExecution(requests) }); await inspectExecution(p); await resolveExecution(p)
  expect(mutations(p)).toHaveLength(0); expect(p.status()).toContain('无法核对')
})
test('execution missing credential does not query or retain actionable controls', async () => {
  const p = await page('execution', { token: '' })
  await p.lifecycle.refresh(USER)
  expect(p.calls).toHaveLength(0)
  expect(p.buttons()).toHaveLength(0)
})

const badSummaries: [string, unknown][] = [
  ['value', null], ['formatVersion', 1], ['actionId', 'invalid'], ['sessionId', null], ['connectionId', 'invalid'],
  ['configRevision', 0], ['phase', 'unknown'], ['taskDigest', 'invalid'], ['state', null], ['executionRef', null],
  ['executionRef.kind', 'local'], ['executionRef.executionId', 'invalid'],
]
test.each(badSummaries)('STDIO malformed summary %s stays nonactionable', async (path, value) => {
  const item = path === 'value' ? value : changed(stdioSummary(), path, value)
  const p = await page('stdio', { handler: () => ({ items: [item], nextOffset: null }) }); await p.lifecycle.refresh(USER)
  expect(p.status()).toContain('无法核对'); expect(p.buttons()).toHaveLength(0); expect(mutations(p)).toHaveLength(0)
})
const badInspections: [string, unknown][] = [
  ['value', null], ['extra', true], ['task', null], ['actualExecutorImage', null], ['actualExecutorImage.kind', 'local'],
  ['taskDigest', 'invalid'], ['preparedDigest', 'invalid'], ['fingerprint', 'invalid'], ['approvalEpoch', 2], ['expiresAt', 'invalid'],
  ['state', null], ['expired', null], ['decision', 'persistent'], ['task.formatVersion', 1], ['task.userId', OTHER],
  ['task.actionId', OTHER], ['task.sessionId', OTHER], ['task.connectionId', OTHER], ['task.configRevision', 2], ['task.phase', 'call'],
  ['taskDigest', 'd'.repeat(64)], ['task.invocation', null], ['task.invocation.program', null], ['task.invocation.program', ''],
  ['task.invocation.cwd', null], ['task.invocation.argv', null], ['task.invocation.argv', [1]], ['task.scopeBinding', null],
  ['task.scopeBinding.kind', 'local'], ['task.scopeBinding.userId', OTHER], ['task.scopeBinding.workspaceId', 'invalid'],
  ['task.scopeBinding.home', null], ['task.scopeBinding.home.kind', 'shared'], ['task.scopeBinding.home.userId', OTHER],
  ['task.scopeBinding.target', null], ['task.expectedDeploymentPin', null], ['task.expectedDeploymentPin.kind', 'local'],
  ['task.expectedDeploymentPin.platform', null], ['task.expectedDeploymentPin.runtimeImageIds', null],
  ['task.expectedDeploymentPin.imageReference', 'changed-image'], ['task.expectedDeploymentPin.runtimeImageIds', []],
  ['task.expectedDeploymentPin.platform', { os: 'linux', arch: 'amd64' }],
]
test.each(badInspections)('STDIO malformed inspection %s never creates a decision or sending record', async (path, value) => {
  const view = path === 'value' ? value : changed(stdioView(), path, value)
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? response(view) : undefined); await inspectStdio(p)
  expect(p.status()).toContain('无法核对')
  expect(p.buttons().some(node => node.textContent === '批准本次')).toBe(false)
  expect(mutations(p)).toHaveLength(0)
  expect(p.dom.window.sessionStorage.getItem(STDIO_KEY)).toBeNull()
})
test.each([null, { rawName: null, arguments: {} }, { rawName: 'tool', arguments: [] }])('STDIO malformed call selection %j remains nonactionable', async (selection) => {
  const view = changed(stdioView(), 'task.phase', 'call'); view.task = { ...stdioView().task, phase: 'call', selection }
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? view : undefined, { summary: stdioSummary({ phase: 'call' }) })
  await inspectStdio(p)
  expect(p.status()).toContain('无法核对'); expect(mutations(p)).toHaveLength(0)
})
test.each([null, { items: null, nextOffset: null }, { items: [stdioSummary(), stdioSummary()], nextOffset: null }, { items: [], nextOffset: -1 }, { items: [], nextOffset: 0 }, { items: [], nextOffset: 1.5 }])('STDIO malformed page %j cannot expose a decision', async (value) => {
  const p = await page('stdio', { handler: () => response(value) })
  await p.lifecycle.refresh(USER)
  expect(p.status()).toContain('无法核对')
  expect(p.buttons()).toHaveLength(0)
  expect(mutations(p)).toHaveLength(0)
})
test.each(['no-prior', 'prior', 'bad-local'])('STDIO unavailable inspection with %s retains only an original reconciliation option', async (kind) => {
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? response({}, 403) : undefined, { saved: kind === 'prior' ? JSON.stringify([stdioPrior()]) : kind === 'bad-local' ? '{}' : undefined })
  await inspectStdio(p); expect(p.status()).toContain(kind === 'prior' ? '发送结果尚不确定' : kind === 'bad-local' ? '无法保存或读取' : '无法核对')
  expect(p.buttons().some(node => node.textContent === '核对原决定')).toBe(kind === 'prior'); expect(mutations(p)).toHaveLength(0)
})
test.each(['inspect', 'fresh', 'decide'])('STDIO service closed during %s keeps the closed status and sends no duplicate', async (stage) => {
  let reads = 0
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? ++reads === (stage === 'inspect' ? 1 : stage === 'fresh' ? 2 : -1) ? response({}, 503) : undefined : call.path.endsWith('/decide') ? response({}, 503) : undefined)
  await inspectStdio(p); if (stage !== 'inspect') await decideStdio(p)
  expect(p.status()).toBe('STDIO 审批已关闭。')
  expect(mutations(p)).toHaveLength(stage === 'decide' ? 1 : 0)
  expect(p.area.querySelector('input')).toBeNull()
})
test('STDIO a record appearing between review and decision prevents another outbound decision', async () => {
  const p = await stdioPage(); await inspectStdio(p); p.dom.window.sessionStorage.setItem(STDIO_KEY, JSON.stringify([stdioPrior()]))
  await decideStdio(p); expect(mutations(p)).toHaveLength(0); expect(p.status()).toContain('无法核对')
})
test('STDIO foreign owner records survive a new owner decision and use the normal clock', async () => {
  const p = await page('stdio', { defaults: true, saved: JSON.stringify([stdioPrior({ owner: OTHER })]), handler: call => call.path.endsWith('/list') ? { items: [stdioSummary()], nextOffset: null } : call.path.endsWith('/inspect') ? stdioView() : stdioView({ state: 'approved', decision: 'once' }) })
  await p.lifecycle.refresh(USER); await inspectStdio(p); await decideStdio(p)
  expect(JSON.parse(p.dom.window.sessionStorage.getItem(STDIO_KEY)!)).toEqual([stdioPrior({ owner: OTHER }), stdioPrior()])
  expect(mutations(p)).toHaveLength(1)
})
test('STDIO expiry after confirmation makes the old control inert before even a new inspection', async () => {
  const p = await stdioPage(); await inspectStdio(p); p.check(); p.clock(Date.parse('2051-01-01T00:00:00Z'))
  const count = p.calls.length
  p.click(p.button('批准本次'))
  await p.idle()
  expect(p.calls).toHaveLength(count)
  expect(mutations(p)).toHaveLength(0)
})
test.each(['execution', 'stdio'] as const)('%s owner reset while the actual response body is unread prevents a stale decoded reply', async (kind) => {
  const body = heldBody(); let reads = 0
  const p = await page(kind, { handler: () => ++reads === 1 ? body.reply : kind === 'execution' ? { available: true, items: [] } : { items: [], nextOffset: null } })
  const first = p.lifecycle.refresh(USER).catch(() => {})
  await vi.waitFor(() => { expect(body.reply.bodyUsed).toBe(true); expect(p.pending.size).toBe(1) })
  p.lifecycle.reset(); await p.lifecycle.refresh(OTHER); const current = text(p)
  body.resolve(kind === 'execution' ? { available: true, items: [executionItem()] } : { items: [stdioSummary()], nextOffset: null })
  await first
  await p.idle()
  expect(text(p)).toBe(current)
  expect(p.unauthorized).not.toHaveBeenCalled()
  expect(mutations(p)).toHaveLength(0)
})
test.each(['execution', 'stdio'] as const)('%s newer same-owner list wins while an older read completes successfully', async (kind) => {
  const hold = deferred(); let reads = 0
  const p = await page(kind, { handler: () => ++reads === 1 ? hold.promise : kind === 'execution' ? { available: true, items: [] } : { items: [], nextOffset: null } })
  const first = p.lifecycle.refresh(USER); await vi.waitFor(() => { expect(p.pending.size).toBe(1) })
  await p.lifecycle.refresh(USER); const current = text(p)
  hold.resolve(kind === 'execution' ? { available: true, items: [executionItem()] } : { items: [stdioSummary()], nextOffset: null })
  await first; await p.idle(); expect(text(p)).toBe(current); expect(mutations(p)).toHaveLength(0)
})
test('execution newer inspection wins over a successful older inspection without restoring old review', async () => {
  const hold = deferred(); let reads = 0
  const p = await executionPage(call => call.path.endsWith('/inspect') ? ++reads === 1 ? hold.promise : inspection({ runnerObservation: 'stopped_unknown' }) : undefined)
  p.click(p.button('检查原执行'))
  await vi.waitFor(() => { expect(p.pending.size).toBe(1)
    expect(p.calls.at(-1)?.path).toBe('/approvals/executions/inspect') })
  p.click(p.button('检查原执行')); await vi.waitFor(() => { expect(text(p)).toContain('stopped_unknown') })
  const current = text(p); hold.resolve(inspection()); await p.idle(); expect(text(p)).toBe(current); expect(mutations(p)).toHaveLength(0)
})
test('execution manual refresh during a submit inspection clears selection and prevents the new intent', async () => {
  const hold = deferred(); let reads = 0
  const p = await executionPage(call => call.path.endsWith('/inspect') && ++reads === 2 ? hold.promise : undefined)
  await inspectExecution(p); p.check(); p.click(p.button('停止旧执行者并对账')); await vi.waitFor(() => { expect(p.pending.size).toBe(1) })
  await p.lifecycle.refresh(USER); hold.resolve(inspection()); await p.idle()
  expect(mutations(p)).toHaveLength(0)
  expect(p.area.querySelector('textarea')).toBeNull()
  expect(p.dom.window.sessionStorage.getItem(EXEC_KEY)).toBeNull()
})
test('execution a detached original submit after an uncertain attempt cannot create a second request', async () => {
  const p = await executionPage(call => call.path.endsWith('/resolve') ? Promise.reject(new Error('synthetic lost reply')) : undefined)
  await inspectExecution(p); const old = p.button('停止旧执行者并对账'); await resolveExecution(p)
  p.click(old); await p.idle(); expect(mutations(p)).toHaveLength(1)
})
test('execution refresh while an inspection status is pending keeps the old review detached', async () => {
  const hold = deferred(); let statuses = 0
  const p = await executionPage(call => call.path.endsWith('/status') && ++statuses === 2 ? hold.promise : undefined, { saved: savedExecution() })
  p.click(p.button('检查原执行'))
  await vi.waitFor(() => { expect(p.pending.size).toBe(1)
    expect(p.calls.filter(call => call.path.endsWith('/status'))).toHaveLength(2) })
  await p.lifecycle.refresh(USER); const current = text(p); hold.resolve({ receipt: null }); await p.idle()
  expect(text(p)).toBe(current); expect(p.area.querySelector('textarea')).toBeNull(); expect(mutations(p)).toHaveLength(0)
})
test('execution refresh while the list queries an old attempt keeps the newer list visible', async () => {
  const hold = deferred(); let statuses = 0, lists = 0
  const p = await page('execution', { saved: savedExecution(), handler: call => call.path.endsWith('/list') ? { available: true, items: ++lists === 1 ? [executionItem()] : [] } : call.path.endsWith('/status') && ++statuses === 1 ? hold.promise : undefined })
  const first = p.lifecycle.refresh(USER)
  await vi.waitFor(() => { expect(p.pending.size).toBe(1)
    expect(p.calls.at(-1)?.path).toBe('/approvals/executions/status') })
  await p.lifecycle.refresh(USER)
  const current = text(p)
  hold.resolve({ receipt: null })
  await first
  await p.idle()
  expect(text(p)).toBe(current)
})
test('execution refresh while hash-selected inspection is pending cannot restore or schedule the old review', async () => {
  const hold = deferred(); let lists = 0
  const p = await page('execution', { hash: '#execution=' + EXEC, handler: call => call.path.endsWith('/list') ? { available: true, items: ++lists === 1 ? [executionItem()] : [] } : hold.promise })
  const first = p.lifecycle.refresh(USER)
  await vi.waitFor(() => { expect(p.pending.size).toBe(1)
    expect(p.calls.at(-1)?.path).toBe('/approvals/executions/inspect') })
  await p.lifecycle.refresh(USER)
  const current = text(p)
  hold.resolve(inspection())
  await first
  await p.idle()
  expect(text(p)).toBe(current)
  expect(p.timers.size).toBe(0)
})
test.each(['status-error', 'final-list', 'timer-list'])('execution reset during %s leaves background error callbacks unable to change the next owner', async (stage) => {
  const hold = deferred(); let lists = 0
  const p = await executionPage((call) => {
    if (call.path.endsWith('/list')) { if (++lists === 2 && stage !== 'status-error') return hold.promise
      return { available: true, items: [executionItem({ resolution: stage === 'timer-list' ? receipt() : null })] } }
    if (call.path.endsWith('/resolve')) return stage === 'status-error' ? Promise.reject(new Error('synthetic lost reply')) : receipt()
    if (stage === 'status-error' && call.path.endsWith('/status')) return hold.promise
    return undefined
  })
  if (stage === 'timer-list') { const entry = p.timers.entries().next().value!; p.timers.delete(entry[0]); entry[1]() }
  else { await inspectExecution(p); p.check(); p.click(p.button('停止旧执行者并对账')) }
  await vi.waitFor(() => { expect(p.pending.size).toBe(1)
    expect(p.calls.at(-1)?.path).toBe('/approvals/executions/' + (stage === 'status-error' ? 'status' : 'list')) })
  p.lifecycle.reset(); await p.lifecycle.refresh(OTHER); const current = text(p); hold.resolve(response({}, 403)); await p.idle()
  expect(text(p)).toBe(current)
  expect(p.timers.size).toBe(stage === 'timer-list' ? 1 : 0)
  expect(mutations(p)).toHaveLength(stage === 'timer-list' ? 0 : 1)
})
test('execution manual refresh while the accepted response is pending keeps selection cleared on completion', async () => {
  const hold = deferred()
  const p = await executionPage(call => call.path.endsWith('/resolve') ? hold.promise : undefined); await inspectExecution(p)
  p.check(); p.click(p.button('停止旧执行者并对账')); await vi.waitFor(() => { expect(mutations(p)).toHaveLength(1) })
  await p.lifecycle.refresh(USER)
  hold.resolve(receipt())
  await p.idle()
  expect(p.area.querySelector('textarea')).toBeNull()
  expect(mutations(p)).toHaveLength(1)
})
test('STDIO original unknown inspection offers a working reconciliation control without another decision', async () => {
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? response({}, 403) : undefined, { saved: JSON.stringify([stdioPrior()]) })
  await inspectStdio(p)
  p.click(p.button('核对原决定'))
  await p.idle()
  expect(p.calls.filter(call => call.path.endsWith('/inspect'))).toHaveLength(2)
  expect(mutations(p)).toHaveLength(0)
})
test('STDIO a failed DOM control update is contained by its actual button error callback', async () => {
  const p = await stdioPage(call => call.path.endsWith('/list') ? { items: [stdioSummary()], nextOffset: 1 } : undefined)
  const next = Array.from(p.area.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '下一页')!
  vi.spyOn(p.area, 'querySelectorAll').mockImplementationOnce(() => { throw new Error('synthetic DOM unavailable') })
  p.click(next); await p.idle(); expect(p.status()).toContain('无法核对'); expect(mutations(p)).toHaveLength(0)
})
test('execution expiry between the eligibility read and POST prevents a request', async () => {
  const p = await executionPage(); let reads = 0
  p.credential(() => ++reads <= 2 ? 'synthetic-independent-approval-token' : '')
  const count = p.calls.length
  p.click(p.button('检查原执行'))
  await p.idle()
  expect(p.calls).toHaveLength(count)
  expect(mutations(p)).toHaveLength(0)
})
test('STDIO expiry between an enabled click and POST prevents even the fresh inspection', async () => {
  const p = await stdioPage(); await inspectStdio(p); p.check(); let reads = 0
  p.credential(() => ++reads === 1 ? 'synthetic-independent-approval-token' : '')
  const count = p.calls.length
  p.click(p.button('批准本次'))
  await p.idle()
  expect(p.calls).toHaveLength(count)
  expect(mutations(p)).toHaveLength(0)
})
// Queue a parent-owned lifecycle event at the response's final credential read, before the caller resumes.
// This keeps the response bytes and the component real while placing the external event deterministically.
function lifecycleAfterRead(p: Page, suffix: string, effect: () => void) {
  p.afterRead((call) => {
    if (!call.path.endsWith('/' + suffix)) return
    p.afterRead(() => {})
    p.credential(() => {
      p.credential(() => 'synthetic-independent-approval-token')
      queueMicrotask(effect)
      return 'synthetic-independent-approval-token'
    })
  })
}
test.each(['list', 'fresh', 'decide'])('STDIO parent invalidation after decoded %s response prevents its later DOM application', async (stage) => {
  const p = await stdioPage(call => call.path.endsWith('/decide') ? stdioView({ decision: 'once', state: 'approved' }) : undefined)
  if (stage !== 'list') await inspectStdio(p)
  lifecycleAfterRead(p, stage === 'fresh' ? 'inspect' : stage, () => { p.lifecycle.invalidate!() })
  if (stage === 'list') await p.lifecycle.refresh(USER)
  else { p.check(); p.click(p.button('批准本次')) }
  await p.idle()
  expect(p.buttons()).toHaveLength(0)
  expect(p.status()).toBe('')
  expect(mutations(p)).toHaveLength(stage === 'decide' ? 1 : 0)
})
test('STDIO parent invalidation immediately after sending-record readback prevents the outbound decision', async () => {
  const p = await stdioPage(); await inspectStdio(p)
  const read = p.storage.getItem.bind(p.storage); let reads = 0
  vi.spyOn(p.storage, 'getItem').mockImplementation((key) => {
    const value = read(key)
    if (++reads === 2) p.lifecycle.invalidate!()
    return value
  })
  await decideStdio(p)
  expect(mutations(p)).toHaveLength(0)
  expect(p.buttons()).toHaveLength(0)
  expect(p.dom.window.sessionStorage.getItem(STDIO_KEY)).toBe(JSON.stringify([stdioPrior()]))
})
test('STDIO expiry between response status validation and section closure does not restore old UI', async () => {
  const p = await stdioPage(call => call.path.endsWith('/inspect') ? response({}, 503) : undefined); let reads = 0
  p.credential(() => ++reads <= 3 ? 'synthetic-independent-approval-token' : '')
  p.click(p.button('核对冻结任务')); await p.idle(); expect(p.status()).not.toBe('STDIO 审批已关闭。'); expect(mutations(p)).toHaveLength(0)
})
test('STDIO a delayed DOM failure after invalidation cannot overwrite the next owner status', async () => {
  const p = await stdioPage(call => call.path.endsWith('/list') ? { items: [stdioSummary()], nextOffset: 1 } : undefined)
  const next = p.button('下一页')
  vi.spyOn(p.area, 'querySelectorAll').mockImplementationOnce(() => {
    queueMicrotask(() => { p.lifecycle.invalidate!() })
    throw new Error('synthetic DOM unavailable')
  })
  p.click(next); await p.idle(); expect(p.status()).toBe(''); expect(mutations(p)).toHaveLength(0)
})
test('execution parent reset after a decoded retry receipt leaves the old review detached', async () => {
  let statuses = 0
  const p = await executionPage(call => call.path.endsWith('/status') ? { receipt: ++statuses < 3 ? null : receipt() } : undefined, { saved: savedExecution() })
  await inspectExecution(p); lifecycleAfterRead(p, 'status', () => { p.lifecycle.reset() })
  p.click(p.button('核对状态后重试相同请求'))
  await p.idle()
  expect(p.buttons()).toHaveLength(0)
  expect(mutations(p)).toHaveLength(0)
  expect(p.status()).toBe('')
})
test('execution null blockedReason is rejected by the real inspection parser before any review fallback', async () => {
  const p = await executionPage(call => call.path.endsWith('/inspect') ? inspection({ canStop: false, blockedReason: null }) : undefined)
  await inspectExecution(p)
  expect(p.status()).toContain('无法核对')
  expect(p.area.querySelector('textarea')).toBeNull()
  expect(mutations(p)).toHaveLength(0)
  expect(p.area.querySelector('[role="status"]')!.previousElementSibling!.childElementCount).toBe(0)
  expect(p.dom.window.sessionStorage.getItem(EXEC_KEY)).toBeNull()
})
