/** Divide the existing run budget and join each cancelled browser action before the next check. */
export class StepTimeout extends Error {
  constructor() { super('本项检查超时'); this.name = 'StepTimeout' }
}

const weights = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 5, 6: 3, 7: 1, 8: 2, 9: 2, 12: 2 }

/** Derive per-check work/recovery deadlines while reserving the relogin and final sign-out shares. */
export function createBudget(totalMs, numbers, now = Date.now) {
  const deadline = now() + totalMs
  const pending = new Set(numbers)
  const unit = totalMs / (numbers.reduce((sum, number) => sum + weights[number], 0) + 3)
  const finalReserve = unit * 2
  return {
    deadline,
    startupMs: unit,
    remaining: () => Math.max(1, deadline - now()),
    step(number) {
      const reserve = finalReserve + (number !== 9 && pending.has(9) ? unit * weights[9] : 0)
      const available = Math.max(0, deadline - now() - reserve)
      const denominator = [...pending].filter(value => value !== 9 || number === 9)
        .reduce((sum, value) => sum + weights[value], 0)
      const allowance = denominator === 0 ? 0 : available * weights[number] / denominator
      pending.delete(number)
      return { workMs: Math.max(1, allowance * 3 / 4), deadline: now() + allowance }
    },
  }
}

/** Run one asynchronous entry under its own deadline and cancellation boundary. */
export async function withStepDeadline(action, { timeoutMs, cancel }) {
  const controller = new AbortController()
  let timer
  const expired = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new StepTimeout()), timeoutMs) })
  const task = Promise.resolve().then(() => action(controller.signal))
  try { return await Promise.race([task, expired]) }
  catch (error) {
    controller.abort(error)
    try { await cancel() } finally { await Promise.allSettled([task]) }
    throw error
  }
  finally { clearTimeout(timer) }
}

/** Read the preview download within the current step's cancellation scope. */
export async function readDownload(download, signal) {
  let stream
  let cancellation
  const stop = () => {
    stream?.destroy()
    cancellation ??= download.cancel()
    void cancellation.catch(() => { /* The finally block joins the original cancellation. */ })
  }
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  const chunks = []
  try {
    signal.throwIfAborted()
    stream = await download.createReadStream()
    if (signal.aborted) { stream?.destroy(); signal.throwIfAborted() }
    if (!stream) throw new Error('Download stream unavailable')
    for await (const chunk of stream) chunks.push(chunk)
  } finally {
    signal.removeEventListener('abort', stop)
    if (cancellation) await cancellation
  }
  return Buffer.concat(chunks)
}

/** Stop through the existing UI and require a newly settled turn rather than only a vanished button. */
export async function stopPendingTurn(page, before, timeoutMs) {
  await page.waitForFunction(previous => [...document.querySelectorAll('[data-turn-process]')]
    .some(element => !previous.includes(element.getAttribute('data-turn-process')))
    || [...document.querySelectorAll('button')].some(element =>
      /^(Stop generating|停止生成)$/.test(element.getAttribute('aria-label') ?? '') && !element.disabled),
  before, { timeout: timeoutMs })
  const stop = page.getByRole('button', { name: /^(Stop generating|停止生成)$/ })
  if (await stop.isVisible()) await stop.click()
  await page.waitForFunction(previous => {
    const closed = [...document.querySelectorAll('[data-turn-process]')]
      .some(element => !previous.includes(element.getAttribute('data-turn-process')))
    const running = [...document.querySelectorAll('button')].some(element =>
      /^(Stop generating|停止生成)$/.test(element.getAttribute('aria-label') ?? '') && !element.disabled)
    return closed && !running
  }, before, { timeout: timeoutMs })
}

/**
 * Wait for the retained assistant reply inside the selected conversation.
 * @param content Selected conversation content locator.
 * @param marker Expected text from its previous assistant reply.
 * @param timeoutMs Remaining work time for this check.
 * @returns Settlement after the matching reply is attached.
 */
export async function waitForPreviousReply(content, marker, timeoutMs) {
  await content.locator('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]')
    .filter({ hasText: marker }).first().waitFor({ state: 'attached', timeout: timeoutMs })
}
