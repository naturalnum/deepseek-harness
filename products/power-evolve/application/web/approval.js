/** Dedicated platform-origin approval surface; its credential never enters the host origin. */
import { t } from './locale.js'
const get = id => document.getElementById(id)
let token = sessionStorage.getItem('pe-approval-token')
const stateLabels = { pending: t.approvalPending, rejected: t.approvalRejected, approved: t.approvalApproved,
  dispatching: t.approvalDispatching, succeeded: t.approvalSucceeded, failed: t.approvalFailed,
  uncertain: t.approvalUncertain, cancelled: t.approvalCancelled }
for (const [id, value] of Object.entries({ title: t.approvalTitle, note: t.approvalNote, 'username-label': t.username,
  'password-label': t.password, 'login-button': t.approvalLogin, refresh: t.approvalRefresh,
  logout: t.approvalLogout, 'ssh-actions-title': t.approvalSshTitle,
  'actions-title': t.approvals, 'permissions-title': t.approvalPermissions, back: t.approvalBack })) get(id).textContent = value
void fetch('/config').then(response => response.json()).then(config => { get('back').href = config.hostUrl }).catch(() => {})
function showError(error) { get('error').textContent = error.message }
async function rpc(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  if (response.status === 401) { token = null; sessionStorage.removeItem('pe-approval-token'); showLogin(); throw new Error(t.loginError) }
  if (!response.ok) throw new Error(`${t.approvalError} (${(await response.json()).error})`)
  return response.json()
}
function showLogin() { get('approval-login').hidden = false; get('approval-console').hidden = true }
function showConsole() { get('approval-login').hidden = true; get('approval-console').hidden = false }
function button(label, action, quiet = false) {
  const control = document.createElement('button'); control.type = 'button'; control.textContent = label
  if (quiet) control.className = 'quiet'
  control.addEventListener('click', () => { control.disabled = true; void action().catch(showError).finally(() => { control.disabled = false }) })
  return control
}
async function refresh() {
  const [user, actions, permissions, sshActions] = await Promise.all([
    rpc('/approvals/me'), rpc('/approvals/list'), rpc('/approvals/permissions'),
    rpc('/approvals/ssh-execute/list')])
  get('identity').textContent = user.username
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
    const label = document.createElement('p'); label.textContent = t.approvalSshCommand
    const command = document.createElement('pre'); command.textContent = action.command
    const fingerprint = document.createElement('code')
    fingerprint.textContent = `${t.approvalFingerprint}: ${action.fingerprint}`
    const time = document.createElement('small')
    time.textContent = ` ${new Date(action.createdAt).toLocaleString()}`
    card.append(heading, target, label, command, fingerprint, time)
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
  void rpc('/approvals/logout').catch(() => {}).finally(() => { token = null; sessionStorage.removeItem('pe-approval-token'); showLogin() })
})
if (token) { showConsole(); void refresh().catch(showError) } else showLogin()
