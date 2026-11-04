/**
 * Live management acceptance against an operator-owned isolated deployment.
 * Uses real sign-in, bootstrap and Gateway HTTP routes; starts no fixture or server.
 * This does not qualify RootSDK, AccountFactory readiness, a model, approval or SSH.
 * Usage: node remote-live-management.mjs /private/config.json /private/new-report.json
 */
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function requireThat(condition, code) {
  if (!condition) throw new Error(code)
}

function validateConfig(input) {
  requireThat(input?.target === 'isolated-acceptance', 'config/isolated-target-required')
  const url = new URL(input.baseUrl)
  requireThat(url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 'config/origin')
  requireThat(Array.isArray(input.accounts) && input.accounts.length === 2
    && input.accounts.every(row => typeof row.email === 'string' && row.email.length > 0
      && typeof row.password === 'string' && row.password.length > 0)
    && input.accounts[0].email !== input.accounts[1].email, 'config/two-distinct-logins')
  for (const key of ['timeoutMs', 'maxReplyBytes', 'maxRequests']) {
    requireThat(Number.isSafeInteger(input[key]) && input[key] > 0 && input[key] <= 1048576, 'config/finite-bounds')
  }
  requireThat(input.maxRequests >= 40, 'config/request-budget')
  requireThat(typeof input.expectedRecipeVersion === 'string' && input.expectedRecipeVersion.length > 0, 'config/recipe-version')
  const fields = input.bindingHeaders
  requireThat(fields && typeof fields.account === 'string' && typeof fields.generation === 'string'
    && /^[a-z][a-z0-9-]+$/.test(fields.account) && /^[a-z][a-z0-9-]+$/.test(fields.generation)
    && fields.account !== fields.generation
    && !['cookie', 'authorization', 'origin', 'content-type', 'host'].includes(fields.account)
    && !['cookie', 'authorization', 'origin', 'content-type', 'host'].includes(fields.generation), 'config/binding-headers')
  return { ...input, baseUrl: url.origin }
}

function digest(value) { return createHash('sha256').update(value).digest('hex') }

/**
 * Exercise account-local CRUD and deny alternate caller/account selectors.
 * @param input Explicit isolated target, two existing test logins and carrier bounds.
 * @returns Sanitized live HTTP observations; execution and production qualification remain false.
 */
export async function runLiveManagement(input) {
  const config = validateConfig(input), runId = randomUUID(), checks = []
  const report = { schemaVersion: 1, runId, scope: 'live-management-http-only',
    startedAt: new Date().toISOString(), completed: false, cleanup: 'pending', checks,
    cleanupScope: 'owned-management-records-and-logins-only',
    productionRootQualified: false, remoteExecutionQualified: false, standardOnlyQualified: false }
  const clients = [], owned = [], secrets = config.accounts.map(row => row.password), uncertainWrites = new Set()
  let requests = 0, cleanupFailed = false
  const send = async (client, path, body, extra = {}) => {
    requireThat(++requests <= config.maxRequests, 'http/request-budget')
    const headers = { origin: config.baseUrl, ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...client?.cookie ? { cookie: client.cookie } : {}, ...extra }
    const response = await fetch(config.baseUrl + path, { method: body === undefined ? 'GET' : 'POST', headers,
      ...body === undefined ? {} : { body: JSON.stringify(body) }, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) })
    const cookies = response.headers.getSetCookie()
    if (client) for (const cookie of cookies) {
      const pair = cookie.split(';', 1)[0], at = pair.indexOf('=')
      requireThat(at > 0, 'http/cookie-invalid')
      client.cookies.set(pair.slice(0, at), pair.slice(at + 1))
      if (pair.slice(at + 1).length > 0) secrets.push(pair.slice(at + 1))
      client.cookie = [...client.cookies].map(([name, value]) => name + '=' + value).join('; ')
    }
    const reader = response.body?.getReader(), chunks = []
    let size = 0
    if (reader) try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        requireThat(size <= config.maxReplyBytes, 'http/reply-budget')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (path.startsWith('/api/')) {
      requireThat(!raw.includes('PRIVATE KEY') && !secrets.some(value => raw.includes(value)
        || raw.includes(JSON.stringify(value).slice(1, -1))), 'http/secret-in-reply')
    }
    let value
    try { value = JSON.parse(raw) } catch { throw new Error('http/non-json') }
    return { status: response.status, value, bytes: size, sha256: digest(raw) }
  }
  const rpc = (client, request, headers = {}) => send(client, '/api/cloudRemoteServers/action', {
    type: 'client-request', rpcId: randomUUID(), method: 'cloudRemoteServers/action', payload: { args: { request } },
  }, { [config.bindingHeaders.account]: client.accountId, [config.bindingHeaders.generation]: client.generation, ...headers })
  const note = (name, response) => checks.push({ name, status: response.status, bytes: response.bytes, sha256: response.sha256 })
  const accepted = (response) => response.status === 200 && response.value?.result?.ok === true
  const value = async (client, request, name) => {
    const write = request.action !== 'list' ? randomUUID() : undefined
    if (write) uncertainWrites.add(write)
    const result = await rpc(client, request)
    requireThat(accepted(result), 'rpc/expected-success')
    const reply = result.value.result.value
    requireThat(Array.isArray(reply?.servers) && reply.servers.every(row => row?.entry && typeof row.entry.id === 'string'
      && typeof row.reference === 'string' && typeof row.configured === 'boolean'), 'rpc/metadata-invalid')
    if (write) uncertainWrites.delete(write)
    note(name, result)
    return reply
  }
  const denied = async (client, request, name, headers, statuses = [400, 401, 403, 409]) => {
    const result = await rpc(client, request, headers)
    requireThat(statuses.includes(result.status) || result.status === 200 && result.value?.result?.ok === false, 'rpc/expected-denial')
    note(name, result)
  }
  try {
    const anonymous = await send(undefined, '/api/cloudRemoteServers/action', { type: 'client-request', rpcId: randomUUID(),
      method: 'cloudRemoteServers/action', payload: { args: { request: { action: 'list' } } } })
    requireThat([401, 403].includes(anonymous.status), 'auth/anonymous-accepted'); note('anonymous-denied', anonymous)
    for (const account of config.accounts) {
      const client = { cookies: new Map(), cookie: '', accountId: '', generation: '' }
      clients.push(client)
      const signedIn = await send(client, '/cloud/auth/sign-in/email', account)
      requireThat(signedIn.status === 200 && client.cookie.length > 0, 'auth/sign-in-failed')
      const bootstrap = await send(client, '/cloud/bootstrap')
      requireThat(bootstrap.status === 200 && bootstrap.value.recipeVersion === config.expectedRecipeVersion
        && bootstrap.value.capabilities?.configuration?.remoteServers?.manage === true, 'bootstrap/remote-unavailable')
      client.accountId = bootstrap.value.account?.id; client.generation = bootstrap.value.connectionGeneration
      requireThat(typeof client.accountId === 'string' && client.accountId.length > 0
        && typeof client.generation === 'string' && client.generation.length > 0, 'bootstrap/binding-invalid')
      note('real-login-bootstrap-' + clients.length, bootstrap)
    }
    const [a, b] = clients
    requireThat(a.accountId !== b.accountId, 'auth/same-account')
    const beforeA = await value(a, { action: 'list' }, 'baseline-a')
    const beforeB = await value(b, { action: 'list' }, 'baseline-b')
    const form = { alias: 'qa-' + runId.slice(0, 16), host: '192.0.2.1', user: 'remoteqa', port: 22,
      description: 'isolated management acceptance ' + runId, tags: ['acceptance'], alwaysAsk: true }
    const add = async (client, name) => {
      const unknownId = randomUUID(); uncertainWrites.add(unknownId)
      const reply = await value(client, { action: 'add', entry: form }, 'add-' + name)
      const row = reply.servers.find(item => item.entry.alias === form.alias)
      requireThat(row, 'rpc/new-server-invalid')
      owned.push({ client, id: row.entry.id })
      uncertainWrites.delete(unknownId)
      requireThat(!row.configured, 'rpc/new-server-invalid')
      return row
    }
    const rowA = await add(a, 'a'), rowB = await add(b, 'b')
    requireThat(rowA.entry.id !== rowB.entry.id && rowA.reference !== rowB.reference, 'rpc/shared-server-identity')
    requireThat(!(await value(b, { action: 'list' }, 'isolation-b')).servers.some(row => row.entry.id === rowA.entry.id), 'rpc/foreign-list')
    await denied(b, { action: 'remove', id: rowA.entry.id }, 'foreign-remove-denied')
    await denied(a, { action: 'list', accountId: b.accountId }, 'wire-account-selector-denied')
    await denied(a, { action: 'list', path: '/private/credentials' }, 'wire-path-selector-denied')
    await denied(a, { action: 'execute', command: 'id' }, 'management-execution-denied')
    await denied(a, { action: 'credential', id: rowA.entry.id, password: 'not-a-key' }, 'password-denied')
    await denied(a, { action: 'list' }, 'foreign-binding-denied', { [config.bindingHeaders.account]: b.accountId })
    await denied(a, { action: 'list' }, 'stale-generation-denied', { [config.bindingHeaders.generation]: randomUUID() })
    const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    secrets.push(key, key.split('\n')[1])
    const credential = await value(a, { action: 'credential', id: rowA.entry.id, privateKey: key,
      knownHosts: '192.0.2.1 ssh-ed25519 AAAA\n' }, 'private-key-write')
    const configured = credential.servers.find(row => row.entry.id === rowA.entry.id)
    requireThat(configured?.configured === true && configured.reference !== rowA.reference, 'rpc/key-reference-not-revoked')
    const changed = await value(a, { action: 'update', id: rowA.entry.id, entry: { ...form, description: form.description + ' updated' } }, 'update')
    requireThat(changed.servers.find(row => row.entry.id === rowA.entry.id)?.reference !== configured.reference, 'rpc/update-reference-not-revoked')
    await denied(a, { action: 'import', text: 'Include /private/ssh/*\n' }, 'ambient-config-denied')
    for (const { client, id } of owned) await value(client, { action: 'remove', id }, 'remove-owned')
    owned.length = 0
    const ids = (reply) => reply.servers.map(row => row.entry.id).sort().join('\n')
    requireThat(ids(await value(a, { action: 'list' }, 'restored-a')) === ids(beforeA)
      && ids(await value(b, { action: 'list' }, 'restored-b')) === ids(beforeB), 'rpc/baseline-not-restored')
    report.completed = true
  } catch (error) {
    report.failure = error instanceof Error && /^(config|http|auth|bootstrap|rpc)\/[a-z-]+$/.test(error.message)
      ? error.message : 'http/operation-failed'
  } finally {
    for (const { client, id } of owned) try { await value(client, { action: 'remove', id }, 'cleanup-owned') }
    catch { cleanupFailed = true }
    for (const client of clients) try {
      if (!client.cookie) continue
      const old = { ...client, cookies: new Map(client.cookies) }
      const result = await send(client, '/cloud/auth/sign-out', {})
      requireThat(result.status === 200, 'auth/sign-out-failed')
      if (old.accountId) await denied(old, { action: 'list' }, 'logged-out-cookie-denied', undefined, [401, 403])
    } catch { cleanupFailed = true }
    report.unconfirmedWrites = uncertainWrites.size
    report.cleanup = cleanupFailed || uncertainWrites.size > 0 ? 'unconfirmed' : 'confirmed'
    report.completed &&= report.cleanup === 'confirmed'
    report.requests = requests
    report.finishedAt = new Date().toISOString()
  }
  return report
}

async function main() {
  const [configPath, reportPath, ...rest] = process.argv.slice(2)
  requireThat(configPath && reportPath && rest.length === 0, 'config/arguments')
  const info = await stat(configPath)
  requireThat(info.isFile() && info.size <= 65536 && (info.mode & 0o077) === 0, 'config/private-file-required')
  const report = await runLiveManagement(JSON.parse(await readFile(configPath, 'utf8')))
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.stdout.write(JSON.stringify({ completed: report.completed, cleanup: report.cleanup,
    productionRootQualified: false, remoteExecutionQualified: false }) + '\n')
  if (!report.completed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Remote management acceptance failed; no credentials were printed.\n'); process.exitCode = 1 })
}
