import { t } from './locale.js'
import { initWorkspace } from './workspace.js'
const element = id => document.getElementById(id)
const params = new URLSearchParams(location.hash.slice(1))
if (params.has('token')) { sessionStorage.setItem('pe-token', params.get('token')); history.replaceState(null, '', '/') }
const token = sessionStorage.getItem('pe-token')
let sessionId = sessionStorage.getItem('pe-session')
let events = new Map(), stream, request, generation = 0
for (const [id, key] of Object.entries({ trial: 'trial', 'new-chat': 'newChat', 'history-label': 'history', signout: 'signout', send: 'send' })) element(id).textContent = t[key]
element('prompt').placeholder = t.placeholder
element('approvals-link').textContent = t.approvals
element('approvals-link').hidden = true
void fetch('/config').then(response => response.json()).then(config => {
  element('approvals-link').href = config.approvalUrl; element('approvals-link').hidden = false
}).catch(() => {})
async function login() { const config = await (await fetch('/config')).json(); location.replace(config.loginUrl) }
async function rpc(method, value, signal) {
  const response = await fetch(`/api/powerEvolve/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ request: value }), signal })
  if (response.status === 401) { await login(); throw new Error(t.loginError) }
  if (!response.ok) { const body = await response.json(); throw new Error(`${t.error} (${body.error})`) }
  return method === 'follow' ? response : response.json()
}
function showError(error) { element('error').textContent = error.message }
function message(role, content) {
  const article = document.createElement('article'); article.className = role
  const label = document.createElement('h3'); label.textContent = t[role]
  const text = document.createElement('div'); text.className = 'message-text'; text.textContent = content
  article.append(label, text); return article
}
function render() {
  const target = element('messages'); target.replaceChildren()
  for (const event of [...events.values()].sort((a,b) => a.seq-b.seq)) {
    const value = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : null
    if (value) {
      const text = value.content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (text) target.append(message(event.type === 'user/message'
        ? value.source?.kind === 'power-evolve-action' ? 'platform' : 'user' : 'assistant', text))
    }
  }
  if (!target.children.length) {
    const welcome = document.createElement('div'); welcome.className = 'welcome'
    const heading = document.createElement('h1'); heading.textContent = t.welcome
    const hint = document.createElement('p'); hint.textContent = t.intro
    welcome.append(heading, hint); target.append(welcome)
  }
  target.scrollTop = target.scrollHeight
}
function consume(page) {
  let changed = false
  for (const event of page.events) { if (!events.has(event.seq)) changed = true; events.set(event.seq, event) }
  const latest = page.operations[0]
  element('status').textContent = latest ? t[latest.state] + (latest.errorCode ? ` (${latest.errorCode})` : '') : t.ready
  if (changed) render()
}
async function follow(id, epoch) {
  while (epoch === generation) {
    try {
      stream = new AbortController()
      const response = await rpc('follow', { sessionId: id, after: Math.max(-1,...events.keys()), limit: 100 }, stream.signal)
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      try {
        while (epoch === generation) {
          const { value, done } = await reader.read(); if (done) break
          buffer += value
          let newline
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline+1)
            if (epoch === generation && line) consume(JSON.parse(line))
          }
        }
      } finally { await reader.cancel() }
    } catch (error) { if (epoch !== generation) return; element('status').textContent = t.reconnecting }
    if (epoch === generation) await new Promise(resolve => setTimeout(resolve, 1000))
  }
}
async function select(id) {
  generation++; stream?.abort(); sessionId = id; request = undefined
  sessionStorage.setItem('pe-session', id); events = new Map(); element('error').textContent = ''; render()
  element('title').textContent = t.untitled
  const epoch = generation
  try {
    const page = await rpc('page', { sessionId: id, after: -1, limit: 100 })
    if (epoch !== generation) return
    consume(page); void follow(id, epoch)
  }
  catch (error) { showError(error) }
  for (const button of element('sessions').children) button.classList.toggle('selected', button.dataset.id === id)
}
async function refreshList() {
  const result = await rpc('list', { offset: 0, limit: 100 })
  const items = Array.isArray(result) ? result : result.items
  element('sessions').replaceChildren()
  for (const session of items) {
    const button = document.createElement('button'); button.className = 'session quiet'; button.dataset.id = session.sessionId
    button.textContent = session.title || t.untitled; button.classList.toggle('selected', session.sessionId === sessionId)
    button.addEventListener('click', () => void select(session.sessionId)); element('sessions').append(button)
  }
  return items
}
element('new-chat').addEventListener('click', async () => {
  try { const result = await rpc('create', { requestId: crypto.randomUUID() }); await refreshList(); await select(result.sessionId) }
  catch (error) { showError(error) }
})
element('signout').addEventListener('click', async () => {
  try { await rpc('logout', {}); sessionStorage.clear(); generation++; stream?.abort(); await login() }
  catch (error) { showError(error) }
})
element('composer').addEventListener('submit', async event => {
  event.preventDefault(); element('send').disabled = true; element('error').textContent = ''
  try {
    if (!sessionId) { const result = await rpc('create', { requestId: crypto.randomUUID() }); await select(result.sessionId) }
    const text = element('prompt').value.trim(); if (!text) return
    if (!request || request.text !== text || request.sessionId !== sessionId) request = { requestId: crypto.randomUUID(), text, sessionId }
    element('status').textContent = t.sending
    await rpc('prompt', request); request = undefined; element('prompt').value = ''; element('status').textContent = t.queued
    await refreshList()
  } catch (error) { showError(error); element('status').textContent = t.uncertain }
  finally { element('send').disabled = false }
})
element('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); element('composer').requestSubmit() } })
render()
initWorkspace({ rpc, t })
if (!token) await login()
else {
  try {
    const me = await rpc('me', {}); element('identity').textContent = me.username
    element('model').textContent = me.settings.model
    const sessions = await refreshList()
    if (sessions.some(value => value.sessionId === sessionId)) await select(sessionId)
    else { sessionId = null; sessionStorage.removeItem('pe-session'); element('status').textContent = t.ready }
  } catch (error) { showError(error) }
}
