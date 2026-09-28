import { t } from './locale.js'
const element = id => document.getElementById(id)
element('note').textContent = t.loginNote
element('username-label').textContent = t.username
element('password-label').textContent = t.password
element('submit').textContent = t.login
element('login').addEventListener('submit', async event => {
  event.preventDefault()
  element('submit').disabled = true
  element('error').textContent = ''
  try {
    const response = await fetch('/identity/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: element('username').value, password: element('password').value }) })
    if (!response.ok) throw new Error(t.loginError)
    const { token } = await response.json()
    const { hostUrl } = await (await fetch('/config')).json()
    element('password').value = ''
    const exchange = await fetch(`${hostUrl}/auth/exchange`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!exchange.ok) throw new Error(t.loginError)
    location.replace(`${hostUrl}/native/`)
  } catch (error) { element('error').textContent = error.message }
  finally { element('submit').disabled = false }
})
