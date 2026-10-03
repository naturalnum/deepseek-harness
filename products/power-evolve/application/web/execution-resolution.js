/** Trusted Platform approval component. Host clients receive only read-only APIs and a page link. */
import {
  executionResolutionsList, executionResolutionInspection, executionResolutionReceipt,
  executionResolutionStatus, executionResolutionRequest, executionResolutionInspectRequest,
  executionResolutionStatusRequest,
} from './execution-resolution-contract.js'

// This existing trial approval page uses Chinese copy, as does locale.js; it has no language switch.
export const executionLabels = {
  title: '云端不确定执行对账',
  help: '核对原命令后，只能确认停止旧执行者并对账。这里使用独立审批凭据，不接收停止证明或替代命令。',
  empty: '没有不确定执行或已有结案回执', unavailable: '无法核对执行状态，不能据此认定已结案。',
  inspect: '检查原执行', command: '原命令', directory: '原工作目录', execution: '原执行编号',
  session: '原会话', fingerprint: '实时身份指纹', note: '备注（最多 500 字）', reason: '原因代码',
  confirm: '我已核对以下确切命令，确认停止旧执行者并对账', resolve: '停止旧执行者并对账',
  uncertain: '副作用结果不明，不能直接重放原命令。', accepted: '已受理停止与对账意图',
  stopping: '正在停止旧执行者并对账', completed: '对账已结案', blocked: '结案受阻',
  succeeded: '已核验原执行成功', failed: '已核验原执行失败', cancelled: '已核验原执行取消',
  closed_unknown: '已停止，结果不明',
  unknown: '停止旧执行者已确认，但副作用结果仍不明；这不表示成功或失败，不能直接重放原命令。',
  changed: '原执行身份或命令已变化，请重新检查并明确确认；本次没有提交。',
  pending: '提交响应或回执尚不确定，正在查询原请求状态；不会自动重发。',
  missing: '尚未查到原请求的受理回执；不能据此断言旧命令未执行。',
  retry: '核对状态后重试相同请求', pollEnded: '本轮自动查询已停止，可刷新继续核对；停止查询不表示结案。',
  request: '结案请求编号', frozenNote: '本次固定备注', observation: 'Runner 观察',
}

const ATTEMPTS_KEY = 'pe-execution-resolution-attempts'

/** Mount into the existing trusted approval console; storage contains no credentials.
 * @param options - DOM, independent credential accessor, auth-expiry callback and testable clock.
 * @returns refresh and reset hooks owned by the existing approval-page lifecycle.
 */
export function createExecutionResolutionApproval({ document, storage, fetch, credential, unauthorized,
  delay = (callback, ms) => setTimeout(callback, ms), cancelDelay = handle => clearTimeout(handle),
  uuid = () => crypto.randomUUID() }) {
  const area = document.getElementById('execution-resolutions')
  const title = document.getElementById('execution-resolutions-title')
  const help = document.getElementById('execution-resolutions-note')
  title.textContent = executionLabels.title; help.textContent = executionLabels.help
  const list = document.createElement('div'), review = document.createElement('div')
  const message = document.createElement('p'); message.setAttribute('role', 'status')
  area.append(list, review, message)
  let owner, epoch = 0, selected, busy = false, timer, pollCount = 0, readEpoch = 0, reviewEpoch = 0
  let controller = new AbortController()
  const attempts = new Map(), receipts = new Map()
  const text = (tag, value) => { const element = document.createElement(tag); element.textContent = String(value); return element }
  const field = (label, value) => text('p', `${label}: ${value}`)
  const active = (generation, token) => generation === epoch && token === credential() && Boolean(token)
  const stopTimer = () => { if (timer !== undefined) cancelDelay(timer); timer = undefined }
  const statusMessage = label => { message.textContent = label }
  const button = (label, action) => {
    const element = text('button', label); element.type = 'button'
    element.addEventListener('click', () => { void action().catch(error => {
      if (credential()) statusMessage(error.message === executionLabels.changed ? error.message : executionLabels.unavailable)
    }) })
    return element
  }
  const updateControls = () => {
    for (const element of area.querySelectorAll('button,input,textarea')) {
      if (element.dataset.frozen === 'true') element.disabled = true
      else element.disabled = busy || !credential() || element.dataset.ready === 'false'
    }
  }
  const save = () => storage.setItem(ATTEMPTS_KEY, JSON.stringify({ owner,
    items: [...attempts.values()].map(attempt => ({ bytes: attempt.bytes })) }))
  const restore = () => {
    let saved
    try { saved = JSON.parse(storage.getItem(ATTEMPTS_KEY) ?? 'null') }
    catch (_error) { /* An invalid local record cannot authorize an execution. */ }
    if (saved?.owner !== owner || !Array.isArray(saved.items) || saved.items.length > 100) return
    for (const item of saved.items) {
      try {
        if (typeof item?.bytes !== 'string' || item.bytes.length > 1500) continue
        const request = executionResolutionRequest.parse(JSON.parse(item.bytes))
        if (JSON.stringify(request) !== item.bytes || attempts.has(request.executionId)) continue
        attempts.set(request.executionId, { request, bytes: item.bytes })
      } catch (_error) { /* A malformed retry record is never submitted. */ }
    }
  }
  async function post(path, body, bytes) {
    const generation = epoch, token = credential(), signal = controller.signal
    if (!token) throw new Error(executionLabels.unavailable)
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: bytes ?? JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (!active(generation, token)) throw new Error(executionLabels.unavailable)
    if (response.status === 401) { reset(); unauthorized(); throw new Error(executionLabels.unavailable) }
    if (!response.ok) throw new Error(executionLabels.unavailable)
    const raw = await response.text()
    if (!active(generation, token) || raw.length > 2 * 1024 * 1024) throw new Error(executionLabels.unavailable)
    return JSON.parse(raw)
  }
  function matchedReceipt(value, request, sessionId) {
    const receipt = executionResolutionReceipt.parse(value)
    if (receipt.requestId !== request.requestId || receipt.executionId !== request.executionId
      || sessionId !== undefined && receipt.sessionId !== sessionId) throw new Error(executionLabels.unavailable)
    return receipt
  }
  function rememberReceipt(receipt) {
    const prior = receipts.get(receipt.executionId)
    if (prior) {
      if (prior.requestId !== receipt.requestId || prior.sessionId !== receipt.sessionId) throw new Error(executionLabels.unavailable)
      const rank = { accepted: 0, stopping: 1, completed: 2, blocked: 2 }
      if (rank[receipt.state] < rank[prior.state]) return
      if (rank[prior.state] === 2 && (prior.state !== receipt.state || prior.finalState !== receipt.finalState)) {
        throw new Error(executionLabels.unavailable)
      }
    }
    receipts.set(receipt.executionId, receipt)
  }
  const receiptText = receipt => {
    const result = document.createElement('div')
    result.append(field(executionLabels.request, receipt.requestId), text('strong', executionLabels[receipt.state]))
    if (receipt.state === 'completed') {
      result.append(text('p', executionLabels[receipt.finalState]))
      if (receipt.finalState === 'closed_unknown') result.append(text('p', executionLabels.unknown))
    }
    if (receipt.errorCode !== null) result.append(field(executionLabels.reason, receipt.errorCode))
    return result
  }
  async function queryAttempt(attempt, sessionId) {
    const result = executionResolutionStatus.parse(await post('/approvals/executions/status',
      executionResolutionStatusRequest.parse({ requestId: attempt.request.requestId })))
    if (result.receipt === null) return null
    const receipt = matchedReceipt(result.receipt, attempt.request, sessionId)
    rememberReceipt(receipt)
    return receipt
  }
  function renderList(items) {
    list.replaceChildren()
    if (!items.length) list.append(text('p', executionLabels.empty))
    for (const item of items) {
      const card = document.createElement('article'); card.className = 'approval-card'
      card.dataset.executionId = item.executionId
      card.append(text('strong', item.executionState === 'uncertain' ? executionLabels.uncertain
        : executionLabels[item.executionState] ?? item.executionState),
      field(executionLabels.execution, item.executionId), field(executionLabels.session, item.sessionId),
      field(executionLabels.directory, item.cwd), text('pre', item.command))
      const receipt = receipts.get(item.executionId) ?? item.resolution
      if (receipt) card.append(receiptText(receipt))
      else if (attempts.has(item.executionId)) card.append(text('p', executionLabels.pending))
      if (item.executionState === 'closed_unknown' && receipt?.finalState !== 'closed_unknown') card.append(text('p', executionLabels.unknown))
      if (item.errorCode !== null) card.append(field(executionLabels.reason, item.errorCode))
      card.append(button(executionLabels.inspect, () => inspect(item.executionId)))
      list.append(card)
    }
    updateControls()
  }
  function renderReview(entry) {
    review.replaceChildren()
    const item = entry.item, attempt = attempts.get(item.executionId), receipt = receipts.get(item.executionId) ?? item.resolution
    review.append(field(executionLabels.execution, item.executionId), field(executionLabels.session, item.sessionId),
      field(executionLabels.directory, item.cwd), text('p', executionLabels.command), text('pre', item.command),
      field(executionLabels.observation, entry.runnerObservation))
    if (entry.fingerprint !== null) review.append(field(executionLabels.fingerprint, entry.fingerprint))
    if (attempt) review.append(field(executionLabels.frozenNote, attempt.request.note))
    if (receipt) { review.append(receiptText(receipt)); return }
    if (!entry.canStop) review.append(field(executionLabels.reason, entry.blockedReason))
    if (attempt) {
      review.append(field(executionLabels.request, attempt.request.requestId),
        text('p', executionLabels.missing))
      if (entry.canStop) review.append(button(executionLabels.retry, () => submit(entry, attempt)))
      return
    }
    if (!entry.canStop) return
    const note = document.createElement('textarea'); note.maxLength = 500; note.setAttribute('aria-label', executionLabels.note)
    const label = document.createElement('label'), checked = document.createElement('input'); checked.type = 'checkbox'
    label.append(checked, text('span', executionLabels.confirm))
    const control = button(executionLabels.resolve, async () => {
      if (!checked.checked) return
      await submit(entry, undefined, note.value)
    })
    control.dataset.ready = 'false'
    checked.addEventListener('change', () => { control.dataset.ready = String(checked.checked); updateControls() })
    review.append(text('p', executionLabels.note), note, label, text('pre', item.command), control)
    updateControls()
  }
  async function inspect(executionId) {
    if (busy || !credential()) return
    const generation = epoch, read = ++reviewEpoch
    selected = undefined; review.replaceChildren()
    const result = executionResolutionInspection.parse(await post('/approvals/executions/inspect',
      executionResolutionInspectRequest.parse({ executionId })))
    if (generation !== epoch || read !== reviewEpoch) return
    if (result.item.executionId !== executionId) throw new Error(executionLabels.unavailable)
    selected = result
    const attempt = attempts.get(executionId)
    if (attempt) await queryAttempt(attempt, result.item.sessionId)
    if (generation === epoch && read === reviewEpoch) renderReview(result)
  }
  async function submit(entry, retry, note = '') {
    if (busy || !credential() || selected !== entry) return
    const generation = epoch, executionId = entry.item.executionId
    if (!retry && attempts.has(executionId)) return
    busy = true; updateControls(); statusMessage('')
    let attempt = retry, sent = false
    try {
      // A lost response is reconciled before an explicit byte-identical retry.
      if (attempt) {
        const receipt = await queryAttempt(attempt, entry.item.sessionId)
        if (receipt) { if (generation === epoch) renderReview(entry); return }
      }
      const latest = executionResolutionInspection.parse(await post('/approvals/executions/inspect', { executionId }))
      if (generation !== epoch || selected !== entry) return
      if (latest.item.executionId !== executionId || latest.item.sessionId !== entry.item.sessionId) {
        selected = undefined; review.replaceChildren(); throw new Error(executionLabels.unavailable)
      }
      if (!latest.canStop || latest.fingerprint !== (attempt?.request.fingerprint ?? entry.fingerprint)
        || latest.item.command !== entry.item.command || latest.item.cwd !== entry.item.cwd) {
        selected = latest; renderReview(latest); throw new Error(executionLabels.changed)
      }
      if (!attempt) {
        if (attempts.size >= 100) throw new Error(executionLabels.unavailable)
        const request = executionResolutionRequest.parse({ requestId: uuid(), executionId, target: 'cloud',
          fingerprint: latest.fingerprint, note })
        attempt = { request, bytes: JSON.stringify(request) }
        attempts.set(executionId, attempt)
        try { save() } catch (error) { attempts.delete(executionId); throw error }
      }
      renderReview(entry); updateControls(); sent = true
      const value = await post('/approvals/executions/resolve', undefined, attempt.bytes)
      rememberReceipt(matchedReceipt(value, attempt.request, entry.item.sessionId))
    } catch (error) {
      if (generation !== epoch) return
      if (!sent) throw error
      statusMessage(executionLabels.pending)
      // Neither status errors nor missing receipts permit automatic resubmission.
      try { await queryAttempt(attempt, entry.item.sessionId) }
      catch (_error) { if (generation === epoch) statusMessage(executionLabels.pending) }
    } finally {
      if (generation === epoch) {
        busy = false; updateControls()
        if (attempt) {
          if (selected === entry) renderReview(entry)
          void load(false).catch(() => { if (generation === epoch) statusMessage(executionLabels.unavailable) })
        }
      }
    }
  }
  async function load(manual) {
    if (!credential() || owner === undefined) return
    const generation = epoch, read = ++readEpoch
    if (manual) { stopTimer(); pollCount = 0; reviewEpoch++; selected = undefined; review.replaceChildren(); statusMessage('') }
    const result = executionResolutionsList.parse(await post('/approvals/executions/list', {}))
    if (generation !== epoch || read !== readEpoch) return
    if (!result.available || new Set(result.items.map(item => item.executionId)).size !== result.items.length) throw new Error(executionLabels.unavailable)
    for (const item of result.items) {
      if (item.resolution) rememberReceipt(item.resolution)
      else if (attempts.has(item.executionId)) await queryAttempt(attempts.get(item.executionId), item.sessionId)
      if (generation !== epoch || read !== readEpoch) return
    }
    renderList(result.items)
    const requested = /^#execution=([a-f0-9-]{36})$/iu.exec(document.defaultView.location.hash)?.[1]
    if (manual && requested && result.items.some(item => item.executionId === requested)) await inspect(requested)
    if (generation !== epoch || read !== readEpoch) return
    stopTimer()
    if (result.items.some(item => {
      const receipt = receipts.get(item.executionId) ?? item.resolution
      return receipt?.state === 'accepted' || receipt?.state === 'stopping'
    })) {
      if (++pollCount >= 15) statusMessage(executionLabels.pollEnded)
      else timer = delay(() => { timer = undefined; void load(false).catch(() => {
        if (generation === epoch) statusMessage(executionLabels.unavailable)
      }) }, 2000)
    }
    if (selected && (attempts.has(selected.item.executionId) || receipts.has(selected.item.executionId))) renderReview(selected)
  }
  function reset() {
    epoch++; readEpoch++; reviewEpoch++; controller.abort(); controller = new AbortController(); stopTimer()
    owner = undefined; selected = undefined; busy = false; attempts.clear(); receipts.clear()
    list.replaceChildren(); review.replaceChildren(); statusMessage('')
  }
  return {
    /** Bind local retry bytes to the independently authenticated owner, then read current facts. */
    async refresh(identity) {
      if (owner !== identity) { reset(); owner = identity; restore() }
      try { await load(true) } catch (error) {
        if (credential()) statusMessage(executionLabels.unavailable)
        throw error
      }
    },
    reset,
  }
}
