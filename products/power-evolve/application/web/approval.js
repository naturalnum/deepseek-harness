/** Dedicated platform-origin approval surface; its credential never enters the host origin. */
import { t } from './locale.js'
import { createExecutionResolutionApproval } from './execution-resolution.js'
import { createStdioV2Approval } from './stdio-v2-approval.js'
// This approval surface uses the same Chinese-only copy as locale.js.
const mcpLabels = {
  title: 'MCP 工具调用审批', action: '调用远端 MCP 工具',
  note: '请核对冻结目标、工具版本和完整参数，并明确选择授权范围。撤销许可会阻止新的调用；已发出的远端动作不能撤回，可能仍会完成。',
  target: '冻结目标', original: '原工具名', description: '远端提供的说明', alias: '任务中的工具名',
  connection: '连接编号', connectionRevision: '连接版本', configurationRevision: '配置版本',
  credentialRevision: '凭据版本', catalog: '目录版本编号', tool: '工具编号', descriptor: '工具描述摘要',
  authentication: '认证方式', headers: '请求头名称', none: '无', arguments: '确切参数',
  created: '创建时间', expires: '审批到期时间', error: '状态代码', preparing: '正在准备调用',
  intent: '已记录发送意图', expired: '已过期', once: '批准本次调用',
  session: '允许本操作所在会话使用此工具版本', persistent: '持续授权此工具版本（跨会话）',
  reject: '拒绝本次调用', cancel: '取消调用', permission: '许可编号', revoke: '撤销此许可', revoked: '已撤销此许可',
  submitted: '本次变更已经提交；请刷新状态核对结果，不会重复提交。',
  uncertain: '提交结果尚不确定；请刷新状态核对，不能据此认定远端动作未执行。',
  revokeUncertain: '撤销结果尚不确定；当前列表没有许可撤销状态，不能据此认定已撤销。',
  changed: '操作状态或冻结内容已变化。请重新核对；本次没有提交变更。',
  unavailable: '无法读取 MCP 操作，请刷新状态。',
}
const get = id => document.getElementById(id)
let token = sessionStorage.getItem('pe-approval-token')
const executions = createExecutionResolutionApproval({ document, storage: sessionStorage,
  fetch: (...args) => fetch(...args), credential: () => token,
  unauthorized: () => { token = null; sessionStorage.removeItem('pe-approval-token'); showLogin() } })
const stdio = createStdioV2Approval({ document, storage: sessionStorage,
  fetch: (...args) => fetch(...args), credential: () => token,
  unauthorized: () => { token = null; sessionStorage.removeItem('pe-approval-token'); showLogin() } })
let refreshEpoch = 0, mcpReadEpoch = 0, mcpMutationEpoch = 0, mcpBusy = false, mcpOwner
const mcpActions = new Map(), mcpAttempts = new Map()
const MCP_ATTEMPTS_KEY = 'pe-mcp-approval-attempts'
const stateLabels = { pending: t.approvalPending, rejected: t.approvalRejected, approved: t.approvalApproved,
  dispatching: t.approvalDispatching, succeeded: t.approvalSucceeded, failed: t.approvalFailed,
  uncertain: t.approvalUncertain, cancelled: t.approvalCancelled,
  preparing: mcpLabels.preparing, 'dispatch-intent': mcpLabels.intent, expired: mcpLabels.expired }
for (const [id, value] of Object.entries({ title: t.approvalTitle, note: t.approvalNote, 'username-label': t.username,
  'password-label': t.password, 'login-button': t.approvalLogin, refresh: t.approvalRefresh,
  logout: t.approvalLogout, 'ssh-actions-title': t.approvalSshTitle,
  'actions-title': t.approvals, 'permissions-title': t.approvalPermissions, back: t.approvalBack,
  'mcp-actions-title': mcpLabels.title, 'mcp-note': mcpLabels.note })) get(id).textContent = value
void fetch('/config').then(response => response.json()).then(config => { get('back').href = config.hostUrl }).catch(() => {})
function showError(error) { get('error').textContent = error.message }
async function rpc(path, body = {}, credential = token) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(body) })
  if (response.status === 401) {
    if (credential === token) { token = null; sessionStorage.removeItem('pe-approval-token'); showLogin() }
    throw new Error(t.loginError)
  }
  if (!response.ok) throw new Error(`${t.approvalError} (${(await response.json()).error})`)
  return response.json()
}
function invalidateMcpReview() {
  refreshEpoch++; mcpReadEpoch++; mcpActions.clear()
  for (const control of get('mcp-actions').querySelectorAll('button')) control.disabled = true
}
function showLogin() {
  stdio.reset()
  executions.reset(); sessionStorage.removeItem('pe-execution-resolution-attempts')
  invalidateMcpReview(); mcpOwner = undefined; mcpAttempts.clear(); sessionStorage.removeItem(MCP_ATTEMPTS_KEY)
  mcpMutationEpoch++; mcpBusy = false
  get('approval-login').hidden = false; get('approval-console').hidden = true
}
function showConsole() { get('approval-login').hidden = true; get('approval-console').hidden = false }
function button(label, action, quiet = false) {
  const control = document.createElement('button'); control.type = 'button'; control.textContent = label
  if (quiet) control.className = 'quiet'
  control.addEventListener('click', () => { control.disabled = true; void action().catch(showError).finally(() => { control.disabled = false }) })
  return control
}

function mcpText(tag, value, className) {
  const element = document.createElement(tag)
  element.textContent = String(value ?? mcpLabels.none)
  if (className) element.className = className
  return element
}
function mcpField(label, value) { return mcpText('p', `${label}: ${value ?? mcpLabels.none}`) }
function mcpTime(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value)
}
function mcpFrozenContent(action) {
  const canonical = value => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    return JSON.stringify(value)
  }
  return canonical([action.fingerprint, action.tool, action.arguments, action.configuration, action.expiresAt])
}
function restoreMcpAttempts(owner) {
  if (mcpOwner === owner) return
  mcpOwner = owner; mcpAttempts.clear()
  let saved
  try { saved = JSON.parse(sessionStorage.getItem(MCP_ATTEMPTS_KEY) ?? 'null') }
  catch (_error) { /* An invalid local record grants no permission. */ }
  if (saved?.owner !== owner || !Array.isArray(saved.items)) return
  for (const item of saved.items) {
    if (Array.isArray(item) && typeof item[0] === 'string' && item[0].length <= 200
      && (item[1] === 'submitted' || item[1] === 'revoked')) mcpAttempts.set(item[0], item[1])
  }
}
function rememberMcpAttempt(key, status = 'submitted') {
  const prior = mcpAttempts.get(key)
  mcpAttempts.set(key, status)
  try { sessionStorage.setItem(MCP_ATTEMPTS_KEY, JSON.stringify({ owner: mcpOwner, items: [...mcpAttempts] })) }
  catch (error) {
    if (prior === undefined) mcpAttempts.delete(key); else mcpAttempts.set(key, prior)
    throw error
  }
}
function updateMcpControls() {
  for (const control of get('mcp-actions').querySelectorAll('button[data-mcp-attempt]')) {
    control.disabled = mcpBusy || !mcpActions.has(control.dataset.mcpAction)
      || mcpAttempts.has(control.dataset.mcpAttempt)
  }
}
function mcpButton(label, entry, kind, decision) {
  const key = `${kind}:${kind === 'revoke' ? entry.action.permissionId : entry.action.actionId}`
  const control = document.createElement('button')
  control.type = 'button'; control.textContent = label
  if (kind !== 'decide' || decision === 'reject') control.className = 'quiet'
  control.dataset.mcpAttempt = key; control.dataset.mcpAction = entry.action.actionId
  control.addEventListener('click', () => { void changeMcpAction(entry, kind, decision) })
  return control
}
function mcpEligible(action, kind) {
  if (kind === 'revoke') return typeof action.permissionId === 'string'
  if (kind === 'cancel') return ['approved', 'preparing', 'dispatch-intent'].includes(action.state)
  return action.state === 'pending' && Date.parse(action.expiresAt) > Date.now()
}
function renderMcpActions(items) {
  const area = get('mcp-actions'); area.replaceChildren(); mcpActions.clear()
  if (!items.length) area.append(mcpText('p', t.approvalEmpty, 'muted'))
  for (const action of items) {
    const entry = { action, content: mcpFrozenContent(action) }
    mcpActions.set(action.actionId, entry)
    const tool = action.tool, configuration = action.configuration
    const card = document.createElement('article'); card.className = 'approval-card'
    card.dataset.mcpAction = action.actionId
    card.append(mcpText('strong', `${mcpLabels.action} · ${stateLabels[action.state] ?? action.state}`),
      mcpField(mcpLabels.target, `${configuration.displayName} · ${configuration.serverUrl}`),
      mcpField(mcpLabels.original, tool.raw.name), mcpField(mcpLabels.alias, tool.model.name))
    if (tool.raw.description !== undefined) card.append(mcpField(mcpLabels.description, tool.raw.description))
    for (const [label, value] of [
      [mcpLabels.connection, tool.connectionId], [mcpLabels.connectionRevision, tool.connectionRevision],
      [mcpLabels.configurationRevision, tool.configurationRevision], [mcpLabels.credentialRevision, tool.credentialRevision],
      [mcpLabels.catalog, tool.catalogId], [mcpLabels.tool, tool.toolId], [mcpLabels.descriptor, tool.descriptorDigest],
      [mcpLabels.authentication, configuration.authentication], [mcpLabels.headers, configuration.headerNames.join(', ')],
    ]) card.append(mcpField(label, value))
    card.append(mcpText('p', mcpLabels.arguments), mcpText('pre', JSON.stringify(action.arguments, null, 2)),
      mcpText('code', `${t.approvalFingerprint}: ${action.fingerprint}`),
      mcpField(mcpLabels.created, mcpTime(action.createdAt)), mcpField(mcpLabels.expires, mcpTime(action.expiresAt)))
    if (action.errorCode !== null) card.append(mcpField(mcpLabels.error, action.errorCode))
    if (mcpEligible(action, 'decide')) {
      const controls = document.createElement('div'); controls.className = 'approval-actions'
      for (const decision of ['once', 'session', 'persistent', 'reject']) {
        controls.append(mcpButton(mcpLabels[decision], entry, 'decide', decision))
      }
      card.append(controls)
    } else if (action.state === 'pending') card.append(mcpText('p', mcpLabels.expired, 'muted'))
    if (mcpEligible(action, 'cancel')) {
      const controls = document.createElement('div'); controls.className = 'approval-actions'
      controls.append(mcpButton(mcpLabels.cancel, entry, 'cancel')); card.append(controls)
    }
    if (mcpAttempts.has(`decide:${action.actionId}`) && action.state === 'pending'
      || mcpAttempts.has(`cancel:${action.actionId}`) && mcpEligible(action, 'cancel')) {
      card.append(mcpText('p', mcpLabels.submitted, 'muted'))
    }
    if (action.permissionId !== null) {
      const key = `revoke:${action.permissionId}`, status = mcpAttempts.get(key)
      card.append(mcpText('code', `${mcpLabels.permission}: ${action.permissionId}`))
      const controls = document.createElement('div'); controls.className = 'approval-actions'
      controls.append(mcpButton(status === 'revoked' ? mcpLabels.revoked : mcpLabels.revoke, entry, 'revoke'))
      card.append(controls)
      if (status === 'submitted') card.append(mcpText('p', mcpLabels.revokeUncertain, 'muted'))
    }
    area.append(card)
  }
  updateMcpControls()
}
async function readMcpActions(credential) {
  const epoch = ++mcpReadEpoch
  const result = await rpc('/approvals/mcp/list', {}, credential)
  return epoch === mcpReadEpoch && credential === token && token ? result.items : undefined
}
/** One explicit click can send at most one mutation; later reads never resubmit it. */
async function changeMcpAction(entry, kind, decision) {
  const action = entry.action, key = `${kind}:${kind === 'revoke' ? action.permissionId : action.actionId}`
  if (mcpBusy || !token || mcpActions.get(action.actionId) !== entry || mcpAttempts.has(key) || !mcpEligible(action, kind)) return
  const credential = token, epoch = refreshEpoch, owner = mcpOwner
  const mutationEpoch = ++mcpMutationEpoch
  let submitted = false
  mcpBusy = true; updateMcpControls(); get('error').textContent = ''
  try {
    const items = await readMcpActions(credential)
    if (credential !== token || epoch !== refreshEpoch) return
    const latest = items?.find(item => item.actionId === action.actionId)
    if (!latest || mcpFrozenContent(latest) !== entry.content || latest.state !== action.state
      || latest.permissionId !== action.permissionId || !mcpEligible(latest, kind)) {
      if (items) renderMcpActions(items)
      throw new Error(mcpLabels.changed)
    }
    renderMcpActions(items)
    rememberMcpAttempt(key); submitted = true
    const body = kind === 'decide' ? { actionId: action.actionId, fingerprint: action.fingerprint, decision }
      : kind === 'cancel' ? { actionId: action.actionId } : { permissionId: action.permissionId }
    const receipt = await rpc(`/approvals/mcp/${kind}`, body, credential)
    if (kind === 'revoke' && receipt.ok !== true) throw new Error(mcpLabels.revokeUncertain)
    if (kind === 'revoke' && credential === token && owner === mcpOwner) rememberMcpAttempt(key, 'revoked')
  } catch (error) {
    if (credential === token) showError(new Error(submitted
      ? kind === 'revoke' ? mcpLabels.revokeUncertain : mcpLabels.uncertain
      : error.message === mcpLabels.changed ? mcpLabels.changed : mcpLabels.unavailable))
  } finally {
    if (submitted && credential === token && owner === mcpOwner) {
      try {
        const items = await readMcpActions(credential)
        if (items) renderMcpActions(items)
      } catch (_error) {
        if (credential === token && owner === mcpOwner) {
          renderMcpActions([...mcpActions.values()].map(entry => entry.action))
          showError(new Error(kind === 'revoke' ? mcpLabels.revokeUncertain : mcpLabels.uncertain))
        }
      }
    }
    if (mutationEpoch === mcpMutationEpoch) { mcpBusy = false; updateMcpControls() }
  }
}
async function refresh() {
  stdio.invalidate()
  invalidateMcpReview()
  const epoch = refreshEpoch, readEpoch = mcpReadEpoch, credential = token
  const [user, actions, permissions, sshActions, mcp] = await Promise.all([
    rpc('/approvals/me'), rpc('/approvals/list'), rpc('/approvals/permissions'),
    rpc('/approvals/ssh-execute/list'), rpc('/approvals/mcp/list').then(value => ({ value }), error => ({ error }))])
  if (epoch !== refreshEpoch || credential !== token || !token) return
  get('identity').textContent = user.username
  restoreMcpAttempts(user.userId ?? user.username)
  if (readEpoch === mcpReadEpoch) {
    if (mcp.value) renderMcpActions(mcp.value.items)
    else { get('mcp-actions').replaceChildren(mcpText('p', mcpLabels.unavailable)); mcpActions.clear() }
  }
  const sshList = get('ssh-actions'); sshList.replaceChildren()
  if (!sshActions.items.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.approvalEmpty
    sshList.append(empty)
  }
  for (const action of sshActions.items) {
    const card = document.createElement('article'); card.className = 'approval-card'
    const heading = document.createElement('strong')
    heading.textContent = `${t.approvalSshAction} · ${stateLabels[action.state] ?? action.state}`
    const target = document.createElement('p')
    target.textContent = `${t.approvalSshTarget}: ${action.displayName} · ${action.username}@${action.host}:${action.port}`
    const location = document.createElement('p')
    location.textContent = `${t.approvalSshDirectory}: ${action.workingDirectory ?? t.approvalSshDefaultDirectory}`
    const identity = document.createElement('p')
    identity.textContent = `${t.approvalSshHostKey}: ${action.hostKeySha256} · ${t.approvalSshConfiguration}: ${action.connectionRevision} · ${t.approvalSshCredential}: ${action.credentialRevision}`
    const label = document.createElement('p'); label.textContent = t.approvalSshCommand
    const command = document.createElement('pre'); command.textContent = action.command
    const fingerprint = document.createElement('code')
    fingerprint.textContent = `${t.approvalFingerprint}: ${action.fingerprint}`
    const time = document.createElement('small')
    time.textContent = ` ${new Date(action.createdAt).toLocaleString()}`
    card.append(heading, target, location, identity, label, command, fingerprint, time)
    if (action.state === 'pending') {
      const controls = document.createElement('div'); controls.className = 'approval-actions'
      controls.append(button(t.approvalSshApprove, async () => {
        await rpc('/approvals/ssh-execute/decide', { actionId: action.actionId,
          fingerprint: action.fingerprint, approve: true }); await refresh()
      }), button(t.approvalDeny, async () => {
        await rpc('/approvals/ssh-execute/decide', { actionId: action.actionId,
          fingerprint: action.fingerprint, approve: false }); await refresh()
      }, true))
      card.append(controls)
    } else if (action.state === 'approved' || action.state === 'uncertain') {
      const controls = document.createElement('div'); controls.className = 'approval-actions'
      controls.append(button(t.approvalSshCancel, async () => {
        await rpc('/approvals/ssh-execute/cancel', { actionId: action.actionId }); await refresh()
      }, true))
      card.append(controls)
    }
    sshList.append(card)
  }
  const list = get('actions'); list.replaceChildren()
  if (!actions.items.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t.approvalEmpty; list.append(empty) }
  for (const action of actions.items) {
    const card = document.createElement('article'); card.className = 'approval-card'
    const heading = document.createElement('strong'); heading.textContent = `${t.approvalAction} · ${stateLabels[action.state] ?? action.state}`
    const detail = document.createElement('p'); detail.textContent = action.text
    const fingerprint = document.createElement('code'); fingerprint.textContent = `${t.approvalFingerprint}: ${action.fingerprint}`
    const time = document.createElement('small'); time.textContent = ` ${new Date(action.createdAt).toLocaleString()}`
    card.append(heading, detail, fingerprint, time)
    if (action.state === 'pending') {
      const controls = document.createElement('div'); controls.className = 'approval-actions'
      controls.append(button(t.approvalApprove, async () => {
        await rpc('/approvals/decide', { actionId: action.actionId, fingerprint: action.fingerprint, approve: true }); await refresh()
      }), button(t.approvalDeny, async () => {
        await rpc('/approvals/decide', { actionId: action.actionId, fingerprint: action.fingerprint, approve: false }); await refresh()
      }, true))
      card.append(controls)
    }
    list.append(card)
  }
  const area = get('permissions'); area.replaceChildren()
  for (const permission of permissions.items) {
    const row = document.createElement('div'); row.className = 'approval-permission'
    const label = document.createElement('span'); label.textContent = permission.capability === 'trial_note_query' ? t.approvalQuery : t.approvalAppend
    row.append(label, button(permission.enabled ? t.disable : t.enable, async () => {
      await rpc('/approvals/permission', { capability: permission.capability, enabled: !permission.enabled }); await refresh()
    }, true)); area.append(row)
  }
  await executions.refresh(user.userId ?? user.username).catch(error => { if (token) showError(error) })
  if (epoch === refreshEpoch && credential === token && token) await stdio.refresh(user.userId)
}
get('approval-login').addEventListener('submit', event => {
  event.preventDefault(); get('login-button').disabled = true; get('error').textContent = ''
  void (async () => {
    const response = await fetch('/identity/approval-login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: get('username').value, password: get('password').value }) })
    if (!response.ok) throw new Error(t.loginError)
    const result = await response.json(); token = result.token
    sessionStorage.setItem('pe-approval-token', token); get('password').value = ''; get('identity').textContent = result.user.username
    showConsole(); await refresh()
  })().catch(showError).finally(() => { get('login-button').disabled = false })
})
get('refresh').addEventListener('click', () => { void refresh().catch(showError) })
get('logout').addEventListener('click', () => {
  stdio.reset()
  executions.reset()
  invalidateMcpReview()
  void rpc('/approvals/logout').catch(() => {}).finally(() => { token = null; sessionStorage.removeItem('pe-approval-token'); showLogin() })
})
if (token) { showConsole(); void refresh().catch(showError) } else showLogin()
