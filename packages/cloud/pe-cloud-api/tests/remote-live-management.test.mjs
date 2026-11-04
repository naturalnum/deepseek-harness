/** Runner regressions use a fake HTTP server; these are never deployment acceptance evidence. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { runLiveManagement } from './remote-live-management.mjs'

async function fixture(mode, consume) {
  const accounts = [{ email: 'a@example.test', password: 'private-password-alpha' },
    { email: 'b@example.test', password: 'private-password-beta' }]
  const rows = [[], []], sessions = new Map(), requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    const cookie = req.headers.cookie?.slice(2), index = sessions.get(cookie)
    requests.push(req.url)
    let status = 200, reply = { ok: true }
    if (req.url === '/cloud/auth/sign-in/email') {
      const selected = accounts.findIndex(row => row.email === body.email && row.password === body.password)
      assert.ok(selected >= 0)
      const token = randomUUID(); sessions.set(token, selected)
      res.setHeader('set-cookie', 's=' + token + '; HttpOnly; Path=/')
    } else if (req.url === '/cloud/auth/sign-out') sessions.delete(cookie)
    else if (index === undefined) { status = 401; reply = { code: 'denied' } }
    else if (req.url === '/cloud/bootstrap') reply = { account: { id: 'account-' + index }, recipeVersion: 'test-recipe',
      connectionGeneration: 'generation-' + index, capabilities: { configuration: { remoteServers: { manage: true } } } }
    else if (req.url === '/api/cloudRemoteServers/action') {
      const request = body.payload.args.request, list = rows[index]
      const row = list.find(item => item.entry.id === request.id)
      const bound = req.headers['x-pe-account'] === 'account-' + index && req.headers['x-pe-generation'] === 'generation-' + index
      const deny = () => {
        if (mode === 'error-denials') status = 500
        reply = { result: { ok: false, error: { code: 'denied' } } }
      }
      reply = { result: { ok: true, value: { servers: list } } }
      if (!bound || request.accountId || request.path || !['list', 'add', 'update', 'remove', 'credential'].includes(request.action)) deny()
      else if (request.action === 'add') list.push({ entry: { ...request.entry, id: randomUUID() }, reference: randomUUID(), configured: false })
      else if (request.action !== 'list' && !row) deny()
      else if (request.action === 'remove') list.splice(list.indexOf(row), 1)
      else if (request.action === 'update') { row.entry = { ...request.entry, id: row.entry.id }; row.reference = randomUUID() }
      else if (request.action === 'credential') {
        if (!request.privateKey) deny()
        else {
          row.configured = true; row.reference = randomUUID()
          if (mode === 'leak-key') reply.result.value.privateKey = request.privateKey
        }
      }
      if (mode === 'oversize') reply.padding = 'x'.repeat(5000)
    } else { status = 404; reply = { code: 'missing' } }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await consume({ target: 'isolated-acceptance', baseUrl: 'http://127.0.0.1:' + server.address().port,
      expectedRecipeVersion: 'test-recipe', bindingHeaders: { account: 'x-pe-account', generation: 'x-pe-generation' },
      accounts, timeoutMs: 5000, maxReplyBytes: mode === 'oversize' ? 4096 : 65536, maxRequests: 64 })
    return { result, rows, requests, sessions }
  } finally {
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  }
}

test('restores both accounts and records only management observations without execution qualification', async () => {
  const { result, rows, sessions } = await fixture('normal', runLiveManagement)
  assert.equal(result.completed, true)
  assert.equal(result.cleanup, 'confirmed')
  assert.equal(result.productionRootQualified, false)
  assert.equal(result.remoteExecutionQualified, false)
  assert.equal(result.standardOnlyQualified, false)
  assert.ok(result.checks.some(row => row.name === 'foreign-remove-denied'))
  assert.equal(result.checks.filter(row => row.name === 'logged-out-cookie-denied').length, 2)
  assert.deepEqual(rows, [[], []]); assert.equal(sessions.size, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-password|PRIVATE KEY|account-0|account-1/)
})

test('a leaked key fails with a fixed diagnostic and retains an unconfirmed write', async () => {
  const { result, rows, sessions } = await fixture('leak-key', runLiveManagement)
  assert.equal(result.completed, false)
  assert.equal(result.failure, 'http/secret-in-reply')
  assert.equal(result.cleanup, 'unconfirmed')
  assert.equal(result.unconfirmedWrites, 1)
  assert.deepEqual(rows, [[], []]); assert.equal(sessions.size, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-password|PRIVATE KEY/)
})

test('rejects a complete response above the explicit byte budget', async () => {
  const { result } = await fixture('oversize', runLiveManagement)
  assert.equal(result.completed, false)
  assert.equal(result.failure, 'http/reply-budget')
  assert.equal(result.remoteExecutionQualified, false)
})

test('does not count a server error as an authorization denial', async () => {
  const { result, rows, sessions } = await fixture('error-denials', runLiveManagement)
  assert.equal(result.completed, false)
  assert.equal(result.failure, 'rpc/expected-denial')
  assert.deepEqual(rows, [[], []]); assert.equal(sessions.size, 0)
})

test('rejects non-isolated configuration before starting HTTP work', async () => {
  await assert.rejects(runLiveManagement({ target: 'production' }), { message: 'config/isolated-target-required' })
})
