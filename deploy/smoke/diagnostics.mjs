/** Fixed smoke stages and same-origin request timings; never retain URL queries, bodies or errors. */
export function createStepTrace(number, workMs, write = console.log, now = Date.now) {
  const started = now()
  let phase = '开始'
  let phaseStarted = started
  let closed = false
  function emit(event, fields = {}) {
    if (closed) return
    write(`阶段诊断：${JSON.stringify({ number, at: new Date(now()).toISOString(), elapsedMs: now() - started,
      phase, event, ...fields })}`)
  }
  return {
    stage(next) {
      if (closed) return
      const previousMs = now() - phaseStarted
      phase = next
      phaseStarted = now()
      emit('阶段开始', { previousMs })
    },
    request(kind, id) { emit('浏览器请求发出', { kind, id }) },
    response(kind, id, status, elapsedMs) { emit('浏览器收到响应头', { kind, id, status, requestMs: elapsedMs }) },
    settled(kind, id, outcome, elapsedMs) { emit(outcome, { kind, id, requestMs: elapsedMs }) },
    finish(outcome) {
      emit('检查结束', { outcome, workMs: Math.floor(workMs), phaseMs: now() - phaseStarted })
      closed = true
    },
  }
}

/** Observe only known smoke routes, binding each request to its original check across cancellation/recovery. */
export function observeSmokeRequests(context, baseUrl, currentTrace, now = Date.now) {
  const base = new URL(`${baseUrl.replace(/\/$/, '')}/`)
  const routes = new Map([
    [new URL('api/session/create', base).pathname, '新建对话'],
    [new URL('api/session/prompt', base).pathname, '提交消息'],
    [new URL('api/session/uploadFileBinary', base).pathname, '上传附件'],
  ])
  const pending = new Map()
  let serial = 0
  const request = req => {
    const trace = currentTrace()
    if (!trace || req.method() !== 'POST') return
    const url = new URL(req.url())
    const kind = url.origin === base.origin ? routes.get(url.pathname) : undefined
    if (kind === undefined) return
    const row = { trace, kind, id: ++serial, started: now() }
    pending.set(req, row)
    trace.request(kind, row.id)
  }
  const response = res => {
    const row = pending.get(res.request())
    if (row) row.trace.response(row.kind, row.id, res.status(), now() - row.started)
  }
  const settle = (req, outcome) => {
    const row = pending.get(req)
    if (!row) return
    pending.delete(req)
    row.trace.settled(row.kind, row.id, outcome, now() - row.started)
  }
  const finished = req => settle(req, '浏览器响应结束')
  const failed = req => settle(req, '浏览器请求失败或被取消')
  context.on('request', request)
  context.on('response', response)
  context.on('requestfinished', finished)
  context.on('requestfailed', failed)
  return () => {
    context.off('request', request)
    context.off('response', response)
    context.off('requestfinished', finished)
    context.off('requestfailed', failed)
    pending.clear()
  }
}

/** Resolve the current visible composer instead of any hidden file input elsewhere on the page. */
export function smokeComposer(page) {
  return page.locator('[data-conversation-content]:visible [data-composer-card]')
    .filter({ has: page.locator('[data-composer-input][contenteditable="true"]') })
}

/** Open the current composer's file menu using shipped Chinese/English labels and the earlier Chinese variant. */
export async function openSmokeFileMenu(page, timeoutMs) {
  const composer = smokeComposer(page)
  await composer.getByRole('button', { name: /^(Add files or run commands|添加文件或调用指令|添加文件或运行命令)$/ })
    .click({ timeout: timeoutMs })
  return composer
}

/** A draft attachment visibly failed; its untrusted server/browser message is never printed. */
export class SmokeUploadFailure extends Error {
  constructor() { super('附件卡报告上传失败，消息尚未发送'); this.name = 'SmokeUploadFailure' }
}

/** Wait within the existing check deadline; surface a failed attachment instead of waiting on its disabled send button. */
export async function waitForSmokeSend(page, uploadFile, timeoutMs) {
  const handle = await page.waitForFunction(name => {
    const cards = [...document.querySelectorAll('[data-conversation-content] [data-composer-card]')]
      .filter(card => card.getClientRects().length > 0)
    if (cards.length !== 1) return false
    const card = cards[0]
    const attachment = name === undefined ? undefined
      : [...card.querySelectorAll('[title]')].find(element => element.getAttribute('title') === name)
    const retry = attachment && [...attachment.querySelectorAll('button')].some(button => {
      const label = button.getAttribute('aria-label')
      return label === `Retry uploading ${name}` || label === `重试上传 ${name}`
    })
    if (attachment?.querySelector('[role="status"]') || retry) return 'upload-error'
    const send = [...card.querySelectorAll('button')].find(button =>
      /^(Send message|发送消息)$/.test(button.getAttribute('aria-label') ?? ''))
    return (name === undefined || attachment !== undefined) && send && !send.disabled ? 'ready' : false
  }, uploadFile, { timeout: timeoutMs })
  try {
    if (await handle.jsonValue() === 'upload-error') throw new SmokeUploadFailure()
  } finally { await handle.dispose() }
}
