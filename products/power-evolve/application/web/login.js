import { t } from './locale.js'
const element = id => document.getElementById(id)
element('brand').textContent = t.product
element('login-title').textContent = t.login
element('username-label').textContent = t.username
element('password-label').textContent = t.password
element('submit').textContent = t.login
element('login').addEventListener('submit', async (event) => {
  event.preventDefault()
  element('submit').disabled = true
  element('error').textContent = ''
  try {
    const response = await fetch('/identity/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: element('username').value, password: element('password').value }) })
    const result = await response.json()
    if (!response.ok) {
      if (response.status === 403 && result?.error === 'password_change_required') {
        element('password').value = ''
        location.replace('/account#password')
        return
      }
      throw new Error(t.loginError)
    }
    const { token } = result
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
