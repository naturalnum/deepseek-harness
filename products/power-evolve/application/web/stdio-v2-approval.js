/** Independent Platform approval UI; logical inspection grants no executor start authority. */
export const stdioApprovalLabels = {
  title: 'STDIO 工具审批',
  note: '程序启动即可产生副作用。请核对完整程序、参数、目录和实际镜像，只批准本次发现或调用；这不授予后续调用权限。',
  inspect: '核对冻结任务', once: '批准本次', reject: '拒绝本次', reconcile: '核对原决定', next: '下一页', previous: '上一页',
  first: '返回第一页', empty: '暂无 STDIO 审批记录。', closed: 'STDIO 审批已关闭。',
  unavailable: '无法核对 STDIO 审批；未发送新的决定。',
  changed: '冻结内容或审批状态已变化；未发送决定，请重新核对。',
  uncertain: '发送结果尚不确定。只可核对原决定，不能据此认定程序未执行。',
  storage: '无法保存或读取原发送记录；未发送新的决定。',
  submitted: '原决定已保存。批准不代表程序已启动或执行完成。',
  checking: '正在独立核对冻结内容…', discover: '发现工具目录', call: '调用工具',
  phase: '阶段', action: '原动作编号', owner: '用户编号', session: '原会话编号', connection: '连接编号',
  revision: '配置版本', program: '原程序', argv: '原 argv（完整 JSON）', cwd: '原 cwd',
  tool: '原工具名', arguments: '完整工具参数（JSON）', workspace: '逻辑 Workspace', home: '逻辑 Home',
  image: '实际执行者镜像', pin: '冻结的可信部署映射', taskDigest: '任务摘要', preparedDigest: '准备摘要',
  fingerprint: '审批指纹', expires: '审批到期时间', state: '持久状态', decision: '持久决定',
  frozen: '完整冻结任务（JSON）', none: '无', original: '本次原发送记录', confirm: '我已核对上述完整冻结内容',
}

const ATTEMPTS_KEY = 'pe-stdio-v2-approval-attempts'
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
const viewKeys = ['task', 'actualExecutorImage', 'taskDigest', 'preparedDigest', 'fingerprint',
  'approvalEpoch', 'expiresAt', 'state', 'expired', 'decision']
const frozenKeys = ['task', 'actualExecutorImage', 'taskDigest', 'preparedDigest', 'fingerprint', 'approvalEpoch', 'expiresAt']

// Compare JSON values without hashing, projecting raw keys, or changing array order.
function sameJson(left, right) {
  const pairs = [[left, right]]
  while (pairs.length) {
    const [a, b] = pairs.pop()
    if (a === b) continue
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort()
    if (ak.length !== bk.length || ak.some((key, index) => key !== bk[index])) return false
    for (const key of ak) pairs.push([a[key], b[key]])
  }
  return true
}
const sameFrozen = (left, right) => frozenKeys.every(key => sameJson(left[key], right[key]))

/** Mount the existing trusted approval console using only independent approval endpoints.
 * @param options Injected DOM, storage, fetch, current approval credential and logout callback; optional clock is observational.
 * @returns Owner-bound refresh, immediate read invalidation, and visible-state teardown. Unconfirmed sending records survive teardown.
 */
export function createStdioV2Approval({ document, storage, fetch, credential, unauthorized, now = () => Date.now() }) {
  const labels = stdioApprovalLabels, area = document.getElementById('stdio-v2-actions')
  document.getElementById('stdio-v2-title').textContent = labels.title
  document.getElementById('stdio-v2-note').textContent = labels.note
  const list = document.createElement('div'), review = document.createElement('div'), message = document.createElement('p')
  message.setAttribute('role', 'status'); area.append(list, review, message)
  let owner, epoch = 0, readEpoch = 0, busy = false, selected, controller = new AbortController()
  const text = (tag, value) => { const element = document.createElement(tag); element.textContent = String(value); return element }
  const field = (card, label, value, json = false) => {
    card.append(text('p', label), text(json ? 'pre' : 'code', json ? JSON.stringify(value, null, 2) : value))
  }
  const context = () => ({ owner, token: credential(), epoch, signal: controller.signal })
  const active = ctx => ctx.epoch === epoch && ctx.owner === owner && ctx.token === credential()
    && Boolean(ctx.token) && !ctx.signal.aborted
  const current = (ctx, read) => active(ctx) && read === readEpoch
  const status = (value) => { message.textContent = value }
  const controls = () => {
    for (const control of area.querySelectorAll('button,input')) control.disabled = busy || !credential() || control.dataset.ready === 'false'
  }
  const button = (label, ctx, action) => {
    const control = text('button', label); control.type = 'button'
    control.addEventListener('click', () => {
      if (!active(ctx) || busy || control.disabled) return
      void action().catch(() => { if (active(ctx)) status(labels.unavailable) })
    })
    return control
  }
  const reject = () => { throw new Error(labels.unavailable) }
  const closed = (ctx) => {
    if (!active(ctx)) return
    selected = undefined; list.replaceChildren(); review.replaceChildren(); status(labels.closed)
  }
  async function post(ctx, suffix, input) {
    if (!active(ctx)) reject()
    const response = await fetch(`/approvals/stdio-v2/${suffix}`, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.token}` }, body: JSON.stringify(input), signal: ctx.signal })
    if (!active(ctx)) reject()
    if (response.status === 401) { reset(); unauthorized(); reject() }
    if (response.status === 503) { closed(ctx); reject() }
    if (!response.ok) reject()
    const value = await response.json()
    if (!active(ctx)) reject()
    return value
  }
  function entries() {
    const raw = storage.getItem(ATTEMPTS_KEY)
    if (raw === null) return []
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) throw new Error(labels.storage)
    const identities = new Set()
    for (const item of value) {
      if (!object(item) || Object.keys(item).sort().join() !== 'actionId,decision,fingerprint,owner'
        || !uuid(item.owner) || !uuid(item.actionId) || !digest(item.fingerprint) || !['once', 'reject'].includes(item.decision)
        || identities.has(`${item.owner}:${item.actionId}`)) throw new Error(labels.storage)
      identities.add(`${item.owner}:${item.actionId}`)
    }
    return value
  }
  const attempted = actionId => entries().find(item => item.owner === owner && item.actionId === actionId)
  function save(view, decision) {
    const items = entries()
    if (items.some(item => item.owner === owner && item.actionId === view.task.actionId)) throw new Error(labels.uncertain)
    const item = { owner, actionId: view.task.actionId, fingerprint: view.fingerprint, decision }
    try { storage.setItem(ATTEMPTS_KEY, JSON.stringify([...items, item])) }
    catch (_error) { throw new Error(labels.storage) }
    // Require the write-ahead record to survive readback before the one outbound decision.
    if (!sameJson(attempted(view.task.actionId), item)) throw new Error(labels.storage)
  }
  function summary(value) {
    if (!object(value) || value.formatVersion !== 2 || !uuid(value.actionId) || !uuid(value.sessionId)
      || !uuid(value.connectionId) || !positive(value.configRevision) || !['discover', 'call'].includes(value.phase)
      || !digest(value.taskDigest) || typeof value.state !== 'string' || !object(value.executionRef)
      || value.executionRef.kind !== 'cloud' || !uuid(value.executionRef.executionId)) reject()
    return value
  }
  function inspection(value, original, ctx) {
    if (!object(value) || Object.keys(value).sort().join() !== [...viewKeys].sort().join()
      || !object(value.task) || !object(value.actualExecutorImage) || value.actualExecutorImage.kind !== 'cloud'
      || !digest(value.taskDigest) || !digest(value.preparedDigest) || !digest(value.fingerprint)
      || value.approvalEpoch !== 1 || !date(value.expiresAt) || typeof value.state !== 'string'
      || typeof value.expired !== 'boolean' || ![null, 'once', 'reject'].includes(value.decision)) reject()
    const task = value.task, invocation = task.invocation, scope = task.scopeBinding, pin = task.expectedDeploymentPin
    if (task.formatVersion !== 2 || task.userId !== ctx.owner || task.actionId !== original.actionId
      || task.sessionId !== original.sessionId || task.connectionId !== original.connectionId
      || task.configRevision !== original.configRevision || task.phase !== original.phase || value.taskDigest !== original.taskDigest
      || !object(invocation) || typeof invocation.program !== 'string' || !invocation.program || typeof invocation.cwd !== 'string'
      || !Array.isArray(invocation.argv) || invocation.argv.some(arg => typeof arg !== 'string')
      || !object(scope) || scope.kind !== 'cloud' || scope.userId !== ctx.owner || !uuid(scope.workspaceId)
      || !object(scope.home) || scope.home.kind !== 'user' || scope.home.userId !== ctx.owner || !object(scope.target)
      || !object(pin) || pin.kind !== 'cloud' || !object(pin.platform) || !Array.isArray(pin.runtimeImageIds)
      || pin.imageReference !== value.actualExecutorImage.imageReference
      || !pin.runtimeImageIds.includes(value.actualExecutorImage.runtimeImageId)
      || !sameJson(pin.platform, value.actualExecutorImage.platform)
      || task.phase === 'call' && (!object(task.selection) || typeof task.selection.rawName !== 'string'
        || !object(task.selection.arguments))) reject()
    return value
  }
  const canDecide = view => view.state === 'pending' && view.decision === null && !view.expired && now() < Date.parse(view.expiresAt)
  function unknown(original, ctx) {
    let prior
    try { prior = attempted(original.actionId) } catch (_error) { status(labels.storage); return }
    status(prior ? labels.uncertain : labels.unavailable)
    if (prior) {
      const card = document.createElement('article'); card.className = 'approval-card'
      field(card, labels.original, { actionId: prior.actionId, fingerprint: prior.fingerprint, decision: prior.decision }, true)
      card.append(button(labels.reconcile, ctx, () => inspect(original, ctx))); review.append(card)
    }
  }
  function render(view, original, ctx) {
    selected = view; review.replaceChildren()
    const card = document.createElement('article'); card.className = 'approval-card'
    card.append(text('h3', view.task.phase === 'discover' ? labels.discover : labels.call))
    for (const [label, value] of [[labels.action, view.task.actionId], [labels.owner, view.task.userId],
      [labels.session, view.task.sessionId], [labels.connection, view.task.connectionId], [labels.revision, view.task.configRevision],
      [labels.program, view.task.invocation.program], [labels.cwd, view.task.invocation.cwd]]) field(card, label, value)
    field(card, labels.argv, view.task.invocation.argv, true)
    if (view.task.phase === 'call') {
      field(card, labels.tool, view.task.selection.rawName); field(card, labels.arguments, view.task.selection.arguments, true)
    }
    field(card, labels.workspace, { workspaceId: view.task.scopeBinding.workspaceId,
      bindingGeneration: view.task.scopeBinding.bindingGeneration, target: view.task.scopeBinding.target }, true)
    field(card, labels.home, view.task.scopeBinding.home, true)
    field(card, labels.image, view.actualExecutorImage, true); field(card, labels.pin, view.task.expectedDeploymentPin, true)
    for (const [label, value] of [[labels.taskDigest, view.taskDigest], [labels.preparedDigest, view.preparedDigest],
      [labels.fingerprint, view.fingerprint], [labels.expires, view.expiresAt], [labels.state, view.state],
      [labels.decision, view.decision ?? labels.none]]) field(card, label, value)
    const details = document.createElement('details'); details.append(text('summary', labels.frozen), text('pre', JSON.stringify(view.task, null, 2)))
    card.append(details); review.append(card)
    let prior
    try { prior = attempted(view.task.actionId) } catch (_error) { status(labels.storage); return }
    if (prior) {
      field(card, labels.original, { actionId: prior.actionId, fingerprint: prior.fingerprint, decision: prior.decision }, true)
      status(prior.fingerprint === view.fingerprint && prior.decision === view.decision ? labels.submitted : labels.uncertain)
      card.append(button(labels.reconcile, ctx, () => inspect(original, ctx)))
    } else if (canDecide(view)) {
      const check = document.createElement('input'); check.type = 'checkbox'
      const label = document.createElement('label'); label.append(check, document.createTextNode(labels.confirm)); card.append(label)
      const once = button(labels.once, ctx, () => decide(view, original, ctx, 'once'))
      const deny = button(labels.reject, ctx, () => decide(view, original, ctx, 'reject'))
      once.dataset.ready = deny.dataset.ready = 'false'
      check.addEventListener('change', () => { once.dataset.ready = deny.dataset.ready = String(check.checked); controls() })
      card.append(once, deny)
    }
    controls()
  }
  async function inspect(original, ctx) {
    const read = ++readEpoch
    busy = true; selected = undefined; review.replaceChildren(); status(labels.checking); controls()
    try {
      const value = inspection(await post(ctx, 'inspect', { actionId: original.actionId }), original, ctx)
      if (current(ctx, read)) { status(''); render(value, original, ctx) }
    } catch (_error) { if (current(ctx, read) && message.textContent !== labels.closed) unknown(original, ctx) }
    finally { if (current(ctx, read)) { busy = false; controls() } }
  }
  async function decide(view, original, ctx, decision) {
    if (selected !== view || !canDecide(view)) return
    const read = ++readEpoch
    busy = true; controls(); status(labels.checking)
    let sent = false
    try {
      const fresh = inspection(await post(ctx, 'inspect', { actionId: original.actionId }), original, ctx)
      if (!current(ctx, read)) return
      if (!sameFrozen(view, fresh) || !canDecide(fresh)) { selected = undefined; review.replaceChildren(); status(labels.changed); return }
      save(view, decision)
      if (!current(ctx, read)) return
      sent = true
      const reply = inspection(await post(ctx, 'decide', { actionId: view.task.actionId, fingerprint: view.fingerprint, decision }), original, ctx)
      if (!current(ctx, read)) return
      if (!sameFrozen(view, reply) || reply.decision !== decision) reject()
      render(reply, original, ctx)
    } catch (_error) {
      if (current(ctx, read) && message.textContent !== labels.closed) {
        if (sent) { render(view, original, ctx); status(labels.uncertain) }
        else {
          selected = undefined; review.replaceChildren(); status(labels.storage === _error.message ? labels.storage : labels.unavailable)
        }
      }
    } finally { if (current(ctx, read)) { busy = false; controls() } }
  }
  async function load(offset, ctx) {
    const read = ++readEpoch
    busy = true; selected = undefined; list.replaceChildren(); review.replaceChildren(); status(''); controls()
    try {
      // One visible candidate per page fits every positive operator page limit; no complete-list truncation.
      const page = await post(ctx, 'list', { offset, limit: 1 })
      if (!current(ctx, read)) return
      if (!object(page) || !Array.isArray(page.items) || page.items.length > 1
        || page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) reject()
      const items = page.items.map(summary)
      if (!items.length) list.append(text('p', labels.empty))
      for (const original of items) {
        const card = document.createElement('article'); card.className = 'approval-card'
        card.append(text('h3', original.phase === 'discover' ? labels.discover : labels.call))
        field(card, labels.action, original.actionId); field(card, labels.state, original.state)
        card.append(button(labels.inspect, ctx, () => inspect(original, ctx))); list.append(card)
      }
      if (offset) list.append(button(labels.previous, ctx, () => load(offset - 1, ctx)))
      if (offset > 1) list.append(button(labels.first, ctx, () => load(0, ctx)))
      if (page.nextOffset !== null) list.append(button(labels.next, ctx, () => load(page.nextOffset, ctx)))
    } catch (_error) { if (current(ctx, read) && message.textContent !== labels.closed) status(labels.unavailable) }
    finally { if (current(ctx, read)) { busy = false; controls() } }
  }
  /** Abort all old reads and immediately disable old controls without erasing sending records. */
  function invalidate() {
    epoch++; readEpoch++; controller.abort(); controller = new AbortController(); selected = undefined; busy = false
    list.replaceChildren(); review.replaceChildren(); status('')
  }
  /** Tear down the visible owner; immutable local sending records remain isolated by original owner. */
  function reset() { invalidate(); owner = undefined }
  /** Read a new owner's first page; authenticated identity is provided by the parent approval console.
   * @param nextOwner Current independently authenticated account UUID, never a username or Agent credential.
   * @returns Completion of the owner-bound read; failures close only this approval section.
   */
  async function refresh(nextOwner) {
    invalidate(); owner = nextOwner
    if (!uuid(owner) || !credential()) { status(labels.unavailable); return }
    await load(0, context())
  }
  return { refresh, invalidate, reset }
}
