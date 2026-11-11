import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createBudget, readDownload, StepTimeout, stopPendingTurn, waitForPreviousReply, withStepDeadline } from './steps.mjs'

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')

test('previous reply waits for history after its conversation container and composer arrive', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div data-conversation-content data-conversation-session="previous" data-content-phase="active">
    <div data-composer-input contenteditable="true">fixture composer</div>
  </div>
  <script>addEventListener('fixture-history-ready',()=>{
    const reply=document.createElement('div');
    reply.dataset.chatFlowKind='assistant-step';reply.dataset.chatGroupPart='response';
    reply.textContent='retained-reply-marker';
    document.querySelector('[data-conversation-session="previous"]').append(reply);
  },{once:true})</script>`)
  const content = page.locator('[data-conversation-session="previous"]')
  await content.waitFor({ state: 'visible' })
  await content.locator('[data-composer-input]').waitFor({ state: 'visible' })
  assert.deepEqual(await content.locator('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]').allTextContents(), [],
    'the old immediate read runs before history arrives')
  const waiting = waitForPreviousReply(content, 'retained-reply-marker', 1000)
  const result = assert.doesNotReject(waiting)
  await page.evaluate(() => dispatchEvent(new Event('fixture-history-ready')))
  await result
})

test('a user prompt or another conversation cannot satisfy the previous assistant reply check', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div data-conversation-content data-conversation-session="previous">
    <div data-chat-flow-kind="user">retained-reply-marker</div>
  </div>
  <div data-conversation-content data-conversation-session="other">
    <div data-chat-flow-kind="assistant-step" data-chat-group-part="response">retained-reply-marker</div>
  </div>`)
  await assert.rejects(waitForPreviousReply(page.locator('[data-conversation-session="previous"]'), 'retained-reply-marker', 30),
    { name: 'TimeoutError' })
})

for (const [label, pages] of [['加载更早', 1], ['Load earlier', 2]]) {
  test(`previous reply loads ${pages} earlier history page(s) through the ${label} button`, async t => {
    const browser = await chromium.launch({ headless: true })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.setContent(`<div data-conversation-content data-conversation-session="previous">
      <button type="button">${label}</button>
      <div data-chat-flow-kind="assistant-step" data-chat-group-part="response" data-chat-flow-key="recent">recent reply</div>
    </div>
    <div data-conversation-content data-conversation-session="other">
      <button type="button" onclick="throw Error('wrong conversation')">${label}</button>
      <div data-chat-flow-kind="assistant-step" data-chat-group-part="response">retained-reply-marker</div>
    </div>
    <script>
      const content=document.querySelector('[data-conversation-session="previous"]');
      const button=content.querySelector('button');let requested=0;
      button.addEventListener('click',()=>{
        button.disabled=true;button.textContent='Loading…';content.dataset.requested=String(++requested);
      });
      addEventListener('fixture-page-ready',()=>{
        const reply=document.createElement('div');
        reply.dataset.chatFlowKind='assistant-step';reply.dataset.chatGroupPart='response';
        reply.dataset.chatFlowKey='older-'+requested;
        reply.textContent=requested===${pages}?'retained-reply-marker':'older reply';
        content.insertBefore(reply,button.nextSibling);
        if(requested===${pages})button.remove();
        else {button.disabled=false;button.textContent=${JSON.stringify(label)}}
      });
    </script>`)
    const content = page.locator('[data-conversation-session="previous"]')
    const outcome = waitForPreviousReply(content, 'retained-reply-marker', 1000)
      .then(() => undefined, error => error)
    for (let requested = 1; requested <= pages; requested++) {
      await page.waitForFunction(value => document.querySelector('[data-conversation-session="previous"]')
        ?.getAttribute('data-requested') === String(value), requested, { timeout: 1000 })
      await page.evaluate(() => dispatchEvent(new Event('fixture-page-ready')))
    }
    assert.equal(await outcome, undefined)
    assert.equal(await content.getAttribute('data-requested'), String(pages))
  })
}

test('exhausted earlier history reports a missing marker even when the final page adds no messages', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div data-conversation-content data-conversation-session="previous">
    <button type="button" onclick="this.disabled=true;this.textContent='Loading…';this.parentElement.dataset.requested='1'">Load earlier</button>
    <div data-chat-flow-kind="assistant-step" data-chat-group-part="response" data-chat-flow-key="recent">recent reply</div>
  </div>`)
  const content = page.locator('[data-conversation-session="previous"]')
  const result = assert.rejects(waitForPreviousReply(content, 'retained-reply-marker', 1000), error => {
    assert.equal(error.name, 'PreviousReplyNotFound')
    assert.equal(error.message, '更新前对话的模型回复中没有找到指定标记')
    return true
  })
  await page.waitForFunction(() => document.querySelector('[data-conversation-session="previous"]')
    ?.getAttribute('data-requested') === '1', undefined, { timeout: 1000 })
  await content.locator('button').evaluate(button => button.remove())
  await result
})

test('a timed-out real browser entry is cancelled and joined before an independent page action starts', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent('<div>local timeout fixture</div>')
  const events = []
  let settled = false
  await assert.rejects(withStepDeadline(async () => {
    try {
      events.push('started')
      await page.waitForFunction(() => false, undefined, { timeout: 0 })
      events.push('late action')
    } finally { settled = true; events.push('settled') }
  }, { timeoutMs: 30, cancel: async () => { events.push('cancel'); await page.close() } }), StepTimeout)
  assert.equal(settled, true, 'returning from the step must join its asynchronous action')
  const next = await browser.newPage()
  await next.setContent('<div>independent action</div>')
  events.push('next')
  assert.equal(await next.locator('div').innerText(), 'independent action')
  assert.deepEqual(events, ['started', 'cancel', 'settled', 'next'])
})

test('each deadline aborts its scope and waits for the actual delayed cleanup', async () => {
  const events = []
  await assert.rejects(withStepDeadline(async signal => {
    await new Promise(resolve => signal.addEventListener('abort', () => { events.push('abort'); resolve() }, { once: true }))
    await Promise.resolve()
    events.push('joined')
  }, { timeoutMs: 5, cancel: async () => { events.push('cancel') } }), StepTimeout)
  events.push('next')
  assert.deepEqual(events, ['abort', 'cancel', 'joined', 'next'])
})

test('budget keeps time for relogin and final logout after an earlier step uses all its work allowance', () => {
  let now = 0
  const budget = createBudget(300000, [1, 2, 3, 4, 5, 6, 7, 8, 9], () => now)
  for (const number of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const step = budget.step(number)
    assert.ok(step.workMs > 0)
    now = step.deadline
  }
  const relogin = budget.step(9)
  assert.ok(relogin.workMs > 0)
  assert.ok(relogin.deadline < budget.deadline)
  now = relogin.deadline
  assert.ok(budget.deadline - now > 0, 'the final logout budget remains even after relogin times out')
})

test('local UI cancellation requires a newly settled turn and cannot mistake button disappearance for completion', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setContent(`<div data-turn-process="old"></div><button aria-label="Stop generating"
    onclick="this.remove();queueMicrotask(()=>{const turn=document.createElement('div');turn.dataset.turnProcess='new';document.body.append(turn)})">Stop</button>`)
  await stopPendingTurn(page, ['old'], 1000)
  await page.setContent('<div data-turn-process="old"></div>')
  await assert.rejects(stopPendingTurn(page, ['old'], 30), /Timeout/)
})

test('a delayed real download is cancelled and joined before createReadStream can finish', async t => {
  const server = createServer((request, response) => {
    if (request.url !== '/download') { response.end('<a href="/download" download>Download</a>'); return }
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture.txt"',
      'Content-Type': 'application/octet-stream', 'Content-Length': 1000000 })
    response.write(Buffer.alloc(65536, 'x'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true })
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link').click()])
  let cancelled = false
  let joined = false
  let watchdogUsed = false
  const watchdog = setTimeout(() => { watchdogUsed = true; void download.cancel() }, 1000)
  try {
    await assert.rejects(withStepDeadline(async signal => {
      try {
        await readDownload({ createReadStream: () => download.createReadStream(),
          cancel: async () => { await download.cancel(); cancelled = true } }, signal)
      } finally { joined = true }
    }, { timeoutMs: 30, cancel: () => page.close() }), StepTimeout)
    assert.equal(watchdogUsed, false, 'the step must finish without the test watchdog cancelling its download')
    assert.equal(cancelled, true, 'abort must cancel and await the Download before returning')
    assert.equal(joined, true)
    const next = await browser.newPage()
    await next.setContent('<p>next</p>')
    assert.equal(await next.locator('p').innerText(), 'next')
  } finally { clearTimeout(watchdog) }
})
