import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createStepTrace, observeSmokeRequests, openSmokeFileMenu, SmokeUploadFailure, smokeComposer, waitForSmokeSend } from './diagnostics.mjs'
import { StepTimeout, withStepDeadline } from './steps.mjs'

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')
const readRows = lines => lines.map(line => JSON.parse(line.slice('阶段诊断：'.length)))

test('stage timing retains the last awaited phase before cancellation and ignores late callbacks', () => {
  let now = 0
  const lines = []
  const trace = createStepTrace(7, 41000, line => lines.push(line), () => now)
  trace.stage('选择文件')
  now = 25
  trace.stage('等待附件完成和发送按钮可用')
  now = 41000
  trace.finish('取消')
  trace.stage('下一项')
  trace.response('上传附件', 1, 200, 42000)
  trace.finish('通过')
  const rows = readRows(lines)
  assert.equal(rows.length, 3)
  assert.equal(rows[1].previousMs, 25)
  assert.deepEqual(rows[2], { number: 7, at: '1970-01-01T00:00:41.000Z', elapsedMs: 41000,
    phase: '等待附件完成和发送按钮可用', event: '检查结束', outcome: '取消', workMs: 41000, phaseMs: 40975 })
})

test('request observations stay with their original check and detach fully on disposal', () => {
  const context = new EventEmitter()
  const first = []
  const second = []
  let current = createStepTrace(7, 1000, line => first.push(line))
  const dispose = observeSmokeRequests(context, 'http://fixture.invalid/app', () => current)
  const req = { method: () => 'POST', url: () => 'http://fixture.invalid/app/api/session/uploadFileBinary?secret=never-log' }
  context.emit('request', req)
  current.finish('取消')
  current = createStepTrace(3, 1000, line => second.push(line))
  context.emit('response', { request: () => req, status: () => 200 })
  context.emit('requestfinished', req)
  assert.deepEqual(second, [], 'late events cannot be reassigned to the next check')
  dispose()
  for (const event of ['request', 'response', 'requestfinished', 'requestfailed']) assert.equal(context.listenerCount(event), 0)
  context.emit('request', req)
  assert.deepEqual(second, [])
  assert.equal(first.join('').includes('never-log'), false)
})

test('real browser request timing logs only fixed route labels, status and durations', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext()
  const page = await context.newPage()
  const lines = []
  const trace = createStepTrace(7, 5000, line => lines.push(line))
  const dispose = observeSmokeRequests(context, 'http://fixture.invalid/app', () => trace)
  t.after(dispose)
  await context.route('http://fixture.invalid/**', route => route.fulfill({ status: 200,
    contentType: 'application/json', body: '{"secret":"response-must-stay-private"}' }))
  await page.goto('http://fixture.invalid/app/')
  let finish
  const finished = new Promise(resolve => { finish = resolve })
  const onFinished = req => { if (new URL(req.url()).pathname.endsWith('/uploadFileBinary')) finish() }
  context.on('requestfinished', onFinished)
  t.after(() => context.off('requestfinished', onFinished))
  await page.evaluate(async () => {
    const init = { method: 'POST', headers: { 'x-secret': 'header-must-stay-private' }, body: 'body-must-stay-private' }
    await (await fetch('/app/api/session/uploadFileBinary?token=query-must-stay-private', init)).text()
    await (await fetch('/app/api/session/uploadFileBinaryOther', init)).text()
    await (await fetch('/app/cloud/auth/sign-in/email', init)).text()
  })
  await finished
  const rows = readRows(lines)
  assert.deepEqual(rows.map(row => row.event), ['浏览器请求发出', '浏览器收到响应头', '浏览器响应结束'])
  assert.ok(rows.every(row => row.kind === '上传附件' && row.id === 1))
  assert.equal(rows[1].status, 200)
  assert.ok(rows[2].requestMs >= 0)
  for (const value of ['query-must', 'header-must', 'body-must', 'response-must', 'fixture.invalid', 'uploadFileBinary']) {
    assert.equal(lines.join('').includes(value), false)
  }
})

test('file selection targets the visible conversation even with other hidden file inputs', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<input type="file" id="settings"><div data-conversation-content hidden>
    <div data-composer-card><div data-composer-input contenteditable="true"></div><input type="file" id="old"></div></div>
    <div data-conversation-content><div data-composer-card><div data-composer-input contenteditable="true"></div>
    <input type="file" id="current" hidden></div></div>`)
  await assert.rejects(page.locator('input[type="file"]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('value') }),
    /strict mode violation/)
  await smokeComposer(page).locator('input[type="file"]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('value') })
  assert.deepEqual(await page.locator('input[type="file"]').evaluateAll(elements => elements.map(e => e.files.length)), [0, 0, 1])
})

function menuFixture(label, attributes = '') {
  return `<button aria-label="${label}" onclick="document.body.dataset.outside='clicked'">outside composer</button>
    <input type="file" id="settings" hidden>
    <div data-conversation-content data-content-phase="active"><div data-composer-card>
      <div data-composer-input contenteditable="true"></div>
      <button type="button" aria-label="${label}" aria-haspopup="listbox" aria-expanded="false" ${attributes}
        onclick="this.setAttribute('aria-expanded','true')">+</button>
      <input type="file" id="current" multiple hidden onchange="document.body.dataset.selected='current'">
    </div></div>`
}

for (const label of ['添加文件或调用指令', 'Add files or run commands', '添加文件或运行命令']) {
  test(`file menu opens through the fixed product label ${label} in the current composer`, { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.setContent(menuFixture(label))
    if (label === '添加文件或调用指令') {
      const previous = smokeComposer(page).getByRole('button', { name: /^(Add files or run commands|添加文件或运行命令)$/ })
      assert.equal(await previous.count(), 0, 'the previous matcher omits the Chinese label in the retained product')
      await assert.rejects(previous.click({ timeout: 50 }), { name: 'TimeoutError' })
    }
    const composer = await openSmokeFileMenu(page, 5000)
    assert.equal(await composer.getByRole('button').getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('body').getAttribute('data-outside'), null)
    await composer.locator('input[type="file"]').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('value') })
    assert.equal(await page.locator('body').getAttribute('data-selected'), 'current')
    assert.deepEqual(await page.locator('input[type="file"]').evaluateAll(elements => elements.map(e => e.files.length)), [0, 1])
  })
}

for (const state of ['disabled', 'covered', 'unrelated label']) {
  test(`file menu preserves the existing wait when its button is ${state}`, { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.setContent(menuFixture(state === 'unrelated label' ? 'unrelated menu' : '添加文件或调用指令', state === 'disabled' ? 'disabled' : '')
      + (state === 'covered' ? '<div role="dialog" style="position:fixed;inset:0;z-index:999"></div>' : ''))
    await assert.rejects(openSmokeFileMenu(page, 80), { name: 'TimeoutError' })
    assert.equal(await smokeComposer(page).getByRole('button').getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('body').getAttribute('data-outside'), null)
    assert.equal(await page.locator('body').getAttribute('data-selected'), null)
  })
}

// Mirrors FileCard's semantic elements: uploading/ready body, retry button, or unconfirmed status.
function fileCard(state, retryLabel = 'Retry uploading fixture.txt', name = 'fixture.txt') {
  const body = state === 'retry'
    ? `<button type="button" aria-label="${retryLabel}" onclick="document.body.dataset.retried='yes'">
        <span>${name}</span><span>private-server-error-and-path</span></button>`
    : `<span ${state === 'unconfirmed' ? '' : 'aria-label="Pending file"'}><span>${name}</span>
        <span ${state === 'unconfirmed' ? 'role="status"' : ''}>${state === 'unconfirmed' ? 'private-server-error-and-path' : state === 'uploading' ? 'Uploading…' : 'TXT 5 B'}</span></span>`
  return `<div title="${name}"><span aria-hidden="true">${state === 'uploading' ? '<span class="spinner"></span>' : 'TXT'}</span>
    ${body}<button type="button" aria-label="Remove file ${name}" onclick="document.body.dataset.removed='yes'">Remove</button>
    ${state === 'uploading' ? '<span aria-hidden="true"><span></span></span>' : ''}</div>`
}

for (const [state, label] of [['retry', 'Retry uploading fixture.txt'], ['retry', '重试上传 fixture.txt'], ['unconfirmed', undefined]]) {
  test(`the actual ${state} FileCard structure (${label ?? 'status'}) reports a fixed error without retrying`, { timeout: 30000 }, async t => {
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.setContent(`<div data-conversation-content><div data-composer-card>
      <div data-composer-input contenteditable="true"></div>${fileCard(state, label)}
      <button aria-label="Send message" disabled>Send</button></div></div>`)
    await assert.rejects(waitForSmokeSend(page, 'fixture.txt', 5000), error => {
      assert.ok(error instanceof SmokeUploadFailure)
      assert.equal(error.message, '附件卡报告上传失败，消息尚未发送')
      return true
    })
    assert.equal(await page.locator('body').getAttribute('data-retried'), null)
    assert.equal(await page.locator('body').getAttribute('data-removed'), null)
  })
}

test('unrelated notices and other file errors do not replace the required attachment or fail a ready attachment', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div role="status">unrelated page status</div><div data-conversation-content><div data-composer-card>
    <div role="status">composer notice</div><div data-composer-input contenteditable="true"></div>
    ${fileCard('unconfirmed', undefined, 'other.txt')}${fileCard('retry', 'Retry uploading another.txt', 'another.txt')}
    <button aria-label="发送消息">Send</button></div></div>`)
  await assert.rejects(waitForSmokeSend(page, 'fixture.txt', 50), { name: 'TimeoutError' })
  await page.locator('[data-composer-card]').evaluate((card, html) => card.insertAdjacentHTML('beforeend', html), fileCard('ready'))
  await waitForSmokeSend(page, 'fixture.txt', 5000)
  await waitForSmokeSend(page, undefined, 5000)
})

test('an uploading FileCard keeps waiting without treating its remove button as a retry', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div data-conversation-content><div data-composer-card>${fileCard('uploading')}
    <button aria-label="Send message" disabled>Send</button></div></div>`)
  await assert.rejects(waitForSmokeSend(page, 'fixture.txt', 50), { name: 'TimeoutError' })
  assert.equal(await page.locator('body').getAttribute('data-removed'), null)
})

test('a pending upload consumes the existing deadline and is joined before a new page is used', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div data-conversation-content><div data-composer-card>${fileCard('uploading')}
    <button aria-label="Send message" disabled>Send</button></div></div>`)
  let joined = false
  await assert.rejects(withStepDeadline(async () => {
    try { await waitForSmokeSend(page, 'fixture.txt', 0) } finally { joined = true }
  }, { timeoutMs: 50, cancel: () => page.close() }), StepTimeout)
  assert.equal(joined, true)
  const next = await browser.newPage()
  await next.setContent('<div data-conversation-content><div data-composer-card><button aria-label="Send message">Send</button></div></div>')
  await waitForSmokeSend(next, undefined, 5000)
})
