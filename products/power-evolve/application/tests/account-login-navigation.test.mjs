/** Login-entry behavior with DOM and HTTP fixtures; real browser acceptance is separate. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

async function loginPage(t, reply) {
  const elements = new Map()
  const requests = [], destinations = []
  let submit
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false,
      addEventListener(name, handler) { assert.equal(name, 'submit'); submit = handler } })
    return elements.get(id)
  } }
  for (const [name, value] of Object.entries({ document, location: { replace(url) { destinations.push(url) } } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else delete globalThis[name]
    })
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return reply(url, options)
  })
  await import(`../web/login.js?case=${randomUUID()}`)
  document.getElementById('username').value = 'new-user'
  document.getElementById('password').value = 'fixture-temporary-password'
  assert.equal(typeof submit, 'function')
  return { elements, requests, destinations, submit: () => submit({ preventDefault() {} }) }
}

test('forced password change stays on the trusted origin and never exchanges an Agent token', async t => {
  const page = await loginPage(t, () => Response.json({ error: 'password_change_required' }, { status: 403 }))
  await page.submit()
  assert.deepEqual(page.requests.map(call => call.url), ['/identity/login'])
  assert.deepEqual(page.destinations, ['/account#password'])
  assert.equal(page.elements.get('password').value, '')
  assert.equal(page.elements.get('submit').disabled, false)
})

test('other login denials stay on the form even with a forced-change error field', async t => {
  const page = await loginPage(t, () => Response.json({ error: 'password_change_required' }, { status: 401 }))
  await page.submit()
  assert.equal(page.requests.length, 1)
  assert.deepEqual(page.destinations, [])
  assert.notEqual(page.elements.get('error').textContent, '')
  assert.equal(page.elements.get('submit').disabled, false)
})

test('ordinary login exchanges only the Agent credential and opens native DSH', async t => {
  const host = 'http://127.0.0.1:19001'
  const page = await loginPage(t, url => {
    if (url === '/identity/login') return Response.json({ token: 'fixture-agent-token' })
    if (url === '/config') return Response.json({ hostUrl: host })
    assert.equal(url, `${host}/auth/exchange`)
    return Response.json({ ok: true })
  })
  await page.submit()
  assert.deepEqual(page.destinations, [`${host}/native/`])
  assert.equal(page.requests.length, 3)
  const exchange = page.requests[2].options
  assert.equal(exchange.credentials, 'include')
  assert.deepEqual(JSON.parse(exchange.body), { token: 'fixture-agent-token' })
  assert.equal(page.elements.get('password').value, '')
})
