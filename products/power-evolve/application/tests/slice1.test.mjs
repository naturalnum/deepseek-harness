/** Built-profile integration: real PostgreSQL, native Agent/Session, deterministic Messages transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'
import { recordedConversation, compareRecordedSession } from './session-snapshot.mjs'
const require = createRequire(new URL('../package.json', import.meta.url))
const { Pool } = require('pg')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const product = join(root, 'products/power-evolve')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
const databaseUrl = (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
const manifestSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))

async function eventually(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25) }
  throw new Error(`Timed out: ${label}`)
}
async function post(url, token, body, signal) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(10000) })
}

// Named database + mkdtemp + listen(0) allow independent test processes to overlap.
test('shared host: isolated conversations, files, skills and approved remote actions', { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-slice1-'))
  const database = `pe_test_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool, host, hostB, balancer, platform, model, connectorTarget, databaseCreated = false
  const children = new Set()
  const stop = async (process, signal = 'SIGTERM') => {
    if (!process || process.exitCode !== null || process.signalCode !== null) return
    const exited = once(process, 'exit')
    process.kill(signal)
    const deadline = setTimeout(() => process.kill('SIGKILL'), 10000)
    try { await exited } finally { clearTimeout(deadline); children.delete(process) }
  }
  t.after(async () => {
    for (const process of children) await stop(process)
    if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) }
    if (connectorTarget) { connectorTarget.closeAllConnections(); await new Promise(resolve => connectorTarget.close(resolve)) }
    await pool?.end()
    if (databaseCreated) {
      await eventually(async()=>Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count)===0,'database connections closed')
      await admin.query(`DROP DATABASE "${database}"`)
    }
    await admin.end()
    await rm(temporary, { recursive: true, force: true })
  })
  await admin.query(`CREATE DATABASE "${database}"`); databaseCreated = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`
  pool = new Pool({ connectionString: url.href, max: 5 })
  const users = ['alice', 'bob'].map((username, index) => ({ username, password: randomBytes(20).toString('base64url'), settings: { model: 'deepseek-flash', maxTokens: index ? 1536 : 2048, revision: 1 } }))
  const workerToken = randomBytes(32).toString('base64url')
  const providerKey = randomBytes(32).toString('base64url')
  const connectorKey = randomBytes(32).toString('base64url')
  for (const [name, value] of Object.entries({ 'database-url': url.href, 'worker-token': workerToken, 'model-key': providerKey,
    'connector-key': connectorKey, 'users.json': JSON.stringify(users) })) await writeFile(join(temporary, name), value, { mode: 0o600 })
  const recorded = await recordedConversation()
  const calls = []
  const remoteNotes = []
  let dropNextRemoteResponse = false
  connectorTarget = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${connectorKey}`) { res.writeHead(401).end(); return }
      const target = new URL(req.url, 'http://127.0.0.1')
      const answer = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.method === 'GET' && target.pathname === '/v1/notes') {
        answer(200, { items: remoteNotes.filter(note => note.owner === target.searchParams.get('owner')) }); return
      }
      const action = /^\/v1\/actions\/([a-f0-9-]{36})$/.exec(target.pathname)
      if (req.method === 'GET' && action) {
        const note = remoteNotes.find(note => note.actionId === action[1]); answer(note ? 200 : 404, note ?? { error: 'not_found' }); return
      }
      if (req.method === 'POST' && target.pathname === '/v1/notes') {
        const payload = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
        const actionId = req.headers['idempotency-key']
        const prior = remoteNotes.find(note => note.actionId === actionId)
        if (prior && (prior.owner !== payload.owner || prior.text !== payload.text)) { answer(409, { error: 'conflict' }); return }
        const note = prior ?? { actionId, owner: payload.owner, text: payload.text, createdAt: new Date().toISOString() }
        if (!prior) remoteNotes.push(note)
        if (dropNextRemoteResponse) { dropNextRemoteResponse = false; res.destroy(); return }
        answer(prior ? 200 : 201, note); return
      }
      answer(404, { error: 'not_found' })
    } catch (_error) { res.writeHead(500).end() }
  })
  await new Promise(resolve => connectorTarget.listen(0, '127.0.0.1', resolve))
  const connectorUrl = `http://127.0.0.1:${connectorTarget.address().port}`
  let hold = Promise.withResolvers(), held = Promise.withResolvers()
  model = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-api-key'], providerKey)
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push(body)
      const prompt = body.messages.at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (prompt === 'HOLD') { held.resolve(); await hold.promise }
      const toolName = prompt.startsWith('TOOL_APPEND:') ? 'trial_notes_append' : prompt === 'TOOL_LIST' ? 'trial_notes_list' : null
      const text = prompt === recorded.input ? recorded.output : `reply:${prompt}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of toolName ? [
        { type: 'message_start', message: { id: 'fixture-message', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${randomUUID()}`, name: toolName,
          input: toolName === 'trial_notes_append' ? { text: prompt.slice('TOOL_APPEND:'.length) } : {} } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ] : [
        { type: 'message_start', message: { id: 'fixture-message', model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    } catch (_closedOrInvalidRequest) { res.destroy() }
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1/messages`

  async function start(name, platformUrl, instance = name, listenPort = 0) {
    const home = join(temporary, instance), profile = join(home, 'profiles', `power-evolve-${instance}`)
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    try { await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir') }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
    const bundle = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'), { schema: manifestSchema })
    const rows = bundle[0].insert
    const readyFile = join(home, 'ready.json')
    await rm(readyFile, { force: true })
    const update = (id, fields) => ({ id, config: { ...rows.find(row => row.id === id).config, ...fields } })
    const patch = [update('web-server', { port: listenPort })]
    if (name === 'platform') patch.push(update('power-evolve-platform', {
      databaseUrlFile: join(temporary, 'database-url'), workerTokenFile: join(temporary, 'worker-token'),
      modelKeyFile: join(temporary, 'model-key'), connectorKeyFile: join(temporary, 'connector-key'), seedUsersFile: join(temporary, 'users.json'),
      readyFile, modelUrl, connectorUrl, connectorTimeoutMs: 1000, connectorPollMs: 200,
      leaseMs: 3000, loginAttemptsPerWindow: 100, maxPendingPerUser: 8, workspaceRoot: join(temporary, 'workspaces'),
      sandboxKubeconfigFile: '', sandboxKeyFile: '', sandboxNamespace: '', sandboxImage: '',
      sandboxLocalRoot: '', sandboxNodeRoot: '',
    }))
    else patch.push(update('power-evolve-runtime', { platformUrl, workerTokenFile: join(temporary, 'worker-token') }), update('power-evolve-host', { platformOrigin: platformUrl, readyFile, renewMs: 500, operationTimeoutMs: 20000, pollMs: 50, maxRequestBytes: 3145728 }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const log = openSync(join(temporary, `${instance}.log`), 'a', 0o600)
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', `power-evolve-${instance}`], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: temporary }, stdio: ['ignore', log, log] })
    closeSync(log); children.add(child)
    const ready = await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${instance} exited before ready: ${await readFile(join(temporary, instance+'.log'),'utf8')}`)
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    }, `${instance} ready`).catch(async error => { throw new Error(`${error.message}: ${await readFile(join(temporary, instance+'.log'),'utf8')}`) })
    assert.equal((await fetch(`${ready.url}/health`)).status, 200)
    return { process: child, url: ready.url }
  }
  platform = await start('platform')
  host = await start('host', platform.url)
  const tokens = []
  for (const user of users) {
    const response = await post(`${platform.url}/identity/login`, null, { username: user.username, password: user.password })
    assert.equal(response.status, 200); tokens.push((await response.json()).token)
  }
  const rpcResponse = (user, method, request, signal) => post(`${host.url}/api/powerEvolve/${method}`, tokens[user], { request }, signal)
  const rpc = async (user, method, request) => { const response = await rpcResponse(user, method, request); assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); return response.json() }
  const create = async user => (await rpc(user, 'create', { requestId: randomUUID() })).sessionId
  const page = (user, id) => rpc(user, 'page', { sessionId: id, after: -1, limit: 200 })
  const finished = async (user, id, state = 'completed') => eventually(async () => {
    const value = await page(user,id)
    if (state === 'completed' && value.operations[0]?.state === 'failed') {
      const ends = value.events.filter(event => event.type === 'turn/end' || event.type === 'request/error').slice(-2)
      throw new Error(`Operation failed: ${value.operations[0]?.errorCode} ${JSON.stringify(ends).slice(0, 1000)}`)
    }
    return value.operations[0]?.state === state && value
  }, `${state} operation`)
  const send = (user, id, text, requestId = randomUUID()) => rpc(user, 'prompt', { sessionId: id, requestId, text })

  await t.test('two identities, strict fields and credentials restricted to platform', async () => {
    assert.equal((await rpc(0, 'me', {})).settings.maxTokens, 2048)
    assert.equal((await rpc(1, 'me', {})).settings.maxTokens, 1536)
    assert.equal((await rpcResponse(0, 'me', { userId: randomUUID() })).status, 400)
    assert.equal((await post(`${host.url}/api/settings/get`, tokens[0], {})).status, 404)
    assert.equal((await post(`${platform.url}/runtime/claim`, tokens[0], { workerId: randomUUID() })).status, 401)
  })
  await t.test('browser exchange uses a scoped cookie, platform revocation and exact origins', async () => {
    const hostOrigin = 'http://127.0.0.1:18880' // External origin configured in the Host Profile.
    const loginPage = await fetch(`${platform.url}/login`)
    assert.equal(loginPage.status, 200)
    assert(loginPage.headers.get('content-security-policy').includes(`connect-src 'self' ${hostOrigin}`))
    const loginScript = await (await fetch(`${platform.url}/app.js`)).text()
    assert(loginScript.includes('/auth/exchange'))
    assert(loginScript.includes('/native/'))
    assert(!loginScript.includes('#token='))
    const login = await post(`${platform.url}/identity/login`, null,
      { username: users[0].username, password: users[0].password })
    assert.equal(login.status, 200)
    const { token } = await login.json()
    const preflight = await fetch(`${host.url}/auth/exchange`, { method: 'OPTIONS', headers: {
      origin: platform.url, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
    } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), platform.url)
    const exchange = (origin, value = token) => fetch(`${host.url}/auth/exchange`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: value }),
    })
    assert.equal((await exchange('https://attacker.example')).status, 403)
    const exchanged = await exchange(platform.url)
    assert.equal(exchanged.status, 200)
    assert.equal((await post(`${platform.url}/identity/me`, token, {})).status, 401)
    assert.equal((await exchange(platform.url)).status, 401)
    const setCookies = exchanged.headers.getSetCookie()
    assert.equal(setCookies.length, 2)
    assert(setCookies.some(value => /^pe_agent=[A-Za-z0-9_-]+; Path=\/native\/api; HttpOnly; SameSite=Strict/.test(value)))
    const productCookie = setCookies.find(value => value.includes('Path=/api/powerEvolve'))
    assert.match(productCookie, /^pe_agent=[A-Za-z0-9_-]+; Path=\/api\/powerEvolve; HttpOnly; SameSite=Strict/)
    const cookie = productCookie.split(';')[0]
    const browserRpc = (origin, method = 'me') => fetch(`${host.url}/api/powerEvolve/${method}`, {
      method: 'POST', headers: { ...(origin ? { origin } : {}), cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ request: {} }),
    })
    assert.equal((await browserRpc('https://attacker.example')).status, 403)
    assert.equal((await browserRpc(undefined)).status, 403)
    assert.equal((await browserRpc(hostOrigin)).status, 200)
    assert.equal((await (await browserRpc(hostOrigin)).json()).userId.length, 36)
    const approval = await post(`${platform.url}/identity/approval-login`, null,
      { username: users[0].username, password: users[0].password })
    assert.equal(approval.status, 200)
    assert.equal((await exchange(platform.url, (await approval.json()).token)).status, 401)
    assert.equal((await fetch(`${host.url}/api/powerEvolve/me`, { method: 'POST', headers: {
      origin: hostOrigin, cookie, authorization: `Bearer ${tokens[1]}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ request: {} }) })).status, 401)
    await stop(host.process)
    host = await start('host', platform.url)
    assert.equal((await browserRpc(hostOrigin)).status, 200)
    const logout = await browserRpc(hostOrigin, 'logout')
    assert.equal(logout.status, 200)
    assert.equal(logout.headers.getSetCookie().length, 2)
    assert(logout.headers.getSetCookie().every(value => value.includes('Max-Age=0')))
    assert.equal((await browserRpc(hostOrigin)).status, 401)
    assert.equal((await exchange(platform.url)).status, 401)
  })
  const alice = await create(0), bob = await create(1)
  await t.test('cross-user history, writes and subscription are refused', async () => {
    assert.equal((await rpcResponse(1, 'page', { sessionId: alice, after:-1,limit:20 })).status,404)
    assert.equal((await rpcResponse(1, 'prompt', { sessionId:alice,requestId:randomUUID(),text:'intrusion' })).status,404)
    assert.equal((await rpcResponse(1, 'follow', {sessionId:alice,after:-1,limit:20})).status,404)
    assert.deepEqual((await rpc(1,'list',{offset:0,limit:100})).items.map(item=>item.sessionId),[bob])
  })
  await t.test('concurrent users, event streams and duplicate acceptance', async () => {
    const requestId = randomUUID()
    const [first, repeat] = await Promise.all([send(0,alice,recorded.input,requestId),send(0,alice,recorded.input,requestId),send(1,bob,'beta')])
    assert.equal(first.operationId,repeat.operationId)
    assert.equal((await rpcResponse(0,'prompt',{sessionId:alice,requestId,text:'different'})).status,409)
    const [a,b] = await Promise.all([finished(0,alice),finished(1,bob)])
    assert.equal(a.events.filter(event=>event.type==='user/message').length,1)
    assert.equal(b.events.filter(event=>event.type==='user/message').length,1)
    assert(!JSON.stringify(a).includes('beta')); assert(!JSON.stringify(b).includes('alpha'))
    const cancel = new AbortController()
    const stream = await rpcResponse(0,'follow',{sessionId:alice,after:-1,limit:200},cancel.signal)
    assert.equal(stream.status,200)
    const reader = stream.body.getReader()
    try { const item=await reader.read(); const text=Buffer.from(item.value).toString(); assert(text.includes('reply:alpha')); assert(!text.includes('reply:beta')) }
    finally { cancel.abort(); await reader.cancel().catch(()=>{}) }
    const transcript = [a,b].map(value=>value.events.flatMap(event=>event.type==='user/message'?[{role:'user',text:event.data.content[0].text}]:event.type==='assistant/message'?[{role:'assistant',text:event.data.message.content[0].text}]:[]))
    assert.deepEqual(transcript,JSON.parse(await readFile(new URL('./expected/conversations.json',import.meta.url),'utf8')))
    assert.deepEqual(calls.map(call=>call.max_tokens).sort((a,b)=>a-b),[1536,2048])
  })
  await t.test('recorded native Session is both replay input and complete output oracle',async()=> {
    await compareRecordedSession(await page(0,alice), recorded)
  })
  await t.test('native Web reads preserve tenant ownership and DSH history framing', async () => {
    const native = (user, path, body) => post(`${platform.url}/native/sessions/${path}`, tokens[user], body)
    const [aliceList, bobList] = await Promise.all([
      native(0, 'list', {}), native(1, 'list', {}),
    ])
    assert.equal(aliceList.status, 200); assert.equal(bobList.status, 200)
    assert.deepEqual((await aliceList.json()).items.map(item => item.sessionId), [alice])
    assert.deepEqual((await bobList.json()).items.map(item => item.sessionId), [bob])
    const address = { kind: 'session', sessionId: alice }
    assert.equal((await native(1, 'snapshot', { address, assistantStream: true })).status, 404)
    assert.equal((await native(1, 'page', { address, throughSeq: 0 })).status, 404)
    const response = await native(0, 'snapshot', { address, assistantStream: true })
    assert.equal(response.status, 200)
    const snapshot = await response.json()
    assert.equal(snapshot.type, 'snapshot')
    assert.equal(snapshot.header.id, alice)
    assert.equal(snapshot.header.cwd, '/workspace')
    assert.equal(snapshot.cursor, snapshot.records.at(-1).event.seq)
    assert.deepEqual(snapshot.assistantStream, { revision: 0 })
    assert(snapshot.records.some(record => record.event.type === 'user/message'))
    assert(snapshot.records.some(record => record.event.type === 'assistant/message'))
    const older = await native(0, 'page', { address, throughSeq: snapshot.cursor, beforeSeq: snapshot.cursor + 1 })
    assert.equal(older.status, 200)
    assert.deepEqual((await older.json()).records, snapshot.records)
    const after = await native(0, 'after', { sessionId: alice, cursor: snapshot.cursor })
    assert.equal(after.status, 200)
    assert.deepEqual((await after.json()).events, [])
    const short = await native(0, 'snapshot', { address, maxMessages: 1 })
    assert.equal(short.status, 200)
    const recent = await short.json()
    assert.equal(recent.hasMore, true)
    const earlier = await native(0, 'page', {
      address, throughSeq: recent.cursor, beforeSeq: recent.records[0].event.seq, maxMessages: 1,
    })
    assert.equal(earlier.status, 200)
    const history = await earlier.json()
    assert(history.records.some(record => record.event.type === 'user/message'))
    assert(history.records.at(-1).event.seq < recent.records[0].event.seq)
  })
  await t.test('native DSH Host Remote routes authenticate and preserve tenant-scoped Session history', async () => {
    const nativeRemote = async (user, method, args, rpcId = randomUUID()) => {
      const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
      const value = await new Promise((resolve, reject) => {
        const request = httpRequest(`${host.url}/native/api/${method}`, { method: 'POST',
          headers: { authorization: `Bearer ${tokens[user]}`, host: '127.0.0.1:18880',
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
          const chunks = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => {
            assert.equal(response.statusCode, 200)
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          })
        })
        request.on('error', reject)
        request.end(body)
      })
      assert.equal(value.type, 'server-response')
      assert.equal(value.rpcId, rpcId)
      return value.result
    }
    const aliceList = await nativeRemote(0, 'session/list', {})
    const bobList = await nativeRemote(1, 'session/list', {})
    assert.equal((await post(`${host.url}/native/api/session/list`, tokens[0],
      { type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: {} } })).status, 403)
    assert.equal(aliceList.ok, true)
    assert.equal(bobList.ok, true)
    assert(aliceList.value.items.some(item => item.sessionId === alice))
    assert(bobList.value.items.every(item => item.sessionId !== alice))
    const foreignPage = await nativeRemote(1, 'session/page',
      { address: { kind: 'session', sessionId: alice }, throughSeq: 0 })
    assert.equal(foreignPage.ok, false)
    assert.equal(foreignPage.error.code, 'session/not-found')
    const fixedId = randomUUID()
    const first = await nativeRemote(0, 'session/create', {}, fixedId)
    const repeated = await nativeRemote(0, 'session/create', {}, fixedId)
    assert.equal(first.ok, true)
    assert.deepEqual(repeated, first)
    const newSession = first.value.sessionId
    const request = { sessionId: newSession, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'native transport trial' }] }
    const accepted = await nativeRemote(0, 'session/prompt', request)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.value.accepted, true)
    const answered = await finished(0, newSession)
    assert(answered.events.some(event => event.type === 'assistant/message'))
    const opened = await nativeRemote(0, 'session/projections', { sessionId: newSession })
    assert.equal(opened.ok, true)
    const old = await nativeRemote(0, 'session/page',
      { address: { kind: 'session', sessionId: newSession }, throughSeq: answered.watermark })
    assert.equal(old.ok, true)
    assert(old.value.records.some(record => record.event.type === 'assistant/message'))
    const denied = await nativeRemote(0, 'settings/update', {})
    assert.equal(denied.ok, false)
    const WebSocket = createRequire(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))('ws')
    const connect = async user => {
      const login = await post(`${platform.url}/identity/login`, null,
        { username: users[user].username, password: users[user].password })
      const credential = (await login.json()).token
      const exchange = await fetch(`${host.url}/auth/exchange`, { method: 'POST',
        headers: { origin: platform.url, 'content-type': 'application/json' }, body: JSON.stringify({ token: credential }) })
      assert.equal(exchange.status, 200)
      const cookie = exchange.headers.getSetCookie().find(value => value.includes('Path=/native/api')).split(';')[0]
      const socket = new WebSocket(`${host.url.replace('http:', 'ws:')}/native/api/remote.mux`,
        { headers: { host: '127.0.0.1:18880', origin: 'http://127.0.0.1:18880', cookie } })
      await once(socket, 'open')
      return socket
    }
    const streamFirst = async (socket, endpoint, args) => {
      const streamId = randomUUID()
      const incoming = once(socket, 'message')
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      const [frame] = await incoming
      return JSON.parse(frame.toString())
    }
    const aliceSocket = await connect(0)
    const bobSocket = await connect(1)
    try {
      const generation = await streamFirst(aliceSocket, '$events', {})
      assert.equal(generation.type, 'item')
      assert.equal(generation.value.type, 'ready')
      assert.equal(generation.value.host.home, '/workspace')
      const opened = await streamFirst(aliceSocket, 'session/follow',
        { address: { kind: 'session', sessionId: newSession }, assistantStream: true })
      assert.equal(opened.type, 'item')
      assert.equal(opened.value.type, 'snapshot')
      assert.equal(opened.value.header.id, newSession)
      const deniedFollow = await streamFirst(bobSocket, 'session/follow',
        { address: { kind: 'session', sessionId: newSession }, assistantStream: true })
      assert.equal(deniedFollow.type, 'error')
      assert.equal(deniedFollow.error.code, 'session/not-found')
    } finally {
      aliceSocket.close()
      bobSocket.close()
    }
  })
  await t.test('POSIX files preserve bytes and reject cross-user paths, links and stale writes', async () => {
    const firstBytes = Buffer.from([0,1,2,255,32,10])
    const id = randomUUID(), path = 'notes/probe.bin'
    const input = { requestId:id,path,baseRevision:null,data:firstBytes.toString('base64') }
    const first = await rpc(0,'filePut',input)
    assert.equal((await rpc(0,'filePut',input)).revision,first.revision)
    assert.equal((await rpcResponse(0,'filePut',{...input,data:Buffer.from('different').toString('base64')})).status,409)
    assert.equal((await rpcResponse(0,'filePut',{...input,requestId:randomUUID()})).status,409)
    assert.deepEqual(Buffer.from((await rpc(0,'fileRead',{path})).data,'base64'),firstBytes)
    assert.equal((await rpcResponse(1,'fileRead',{path})).status,404)
    assert.equal((await rpcResponse(1,'filePut',{...input,requestId:randomUUID(),path:'../escape'})).status,400)
    const mine=await rpc(0,'filesList',{directory:'notes'})
    const theirs=await rpc(1,'filesList',{directory:'notes'})
    assert.deepEqual(mine.items.map(item=>item.name),['probe.bin'])
    assert.deepEqual(theirs.items,[])
    const updated=await rpc(0,'filePut',{requestId:randomUUID(),path,baseRevision:first.revision,data:Buffer.from('edited').toString('base64')})
    assert.equal((await rpc(0,'fileRead',{path})).revision,updated.revision)
    assert.equal((await rpcResponse(0,'filePut',{requestId:randomUUID(),path,baseRevision:first.revision,data:Buffer.from('lost update').toString('base64')})).status,409)
    await symlink(join(temporary,'worker-token'),join(temporary,'workspaces',mine.workspace,'notes','link.txt'))
    assert.equal((await rpcResponse(0,'fileRead',{path:'notes/link.txt'})).status,400)
    assert.equal((await rpcResponse(1,'fileRead',{path:'notes/link.txt'})).status,404)
    await stop(host.process); await stop(platform.process)
    platform=await start('platform'); host=await start('host',platform.url)
    assert.deepEqual(Buffer.from((await rpc(0,'fileRead',{path})).data,'base64'),Buffer.from('edited'))
    assert.equal((await pool.query('SELECT count(*) FROM pe_workspaces')).rows[0].count,'2')
  })
  await t.test('personal skill bytes, ownership, toggle and task-time snapshot', async () => {
    const marker='ALICE_SKILL_MARKER_ONLY'
    const aliceSkill=await rpc(0,'skillsInstall',{requestId:randomUUID(),name:'文稿校对',description:'检查术语与错别字',instructions:`遇到校对任务先核对术语。${marker}`})
    await rpc(1,'skillsInstall',{requestId:randomUUID(),name:'代码梳理',description:'整理代码结构',instructions:'先理解模块边界。'})
    assert.deepEqual((await rpc(0,'skillsList',{})).items.map(skill=>skill.name),['文稿校对'])
    assert.deepEqual((await rpc(1,'skillsList',{})).items.map(skill=>skill.name),['代码梳理'])
    assert((await rpc(0,'skillsRead',{skillId:aliceSkill.skillId})).instructions.includes(marker))
    assert.equal((await rpcResponse(1,'skillsRead',{skillId:aliceSkill.skillId})).status,404)
    assert.equal((await rpcResponse(1,'skillsToggle',{skillId:aliceSkill.skillId,enabled:false})).status,404)
    const aliceSkillRoot=join(temporary,'workspaces','extensions')
    const aliceUser=(await pool.query("SELECT id FROM pe_users WHERE username='alice'")).rows[0].id
    assert((await readFile(join(aliceSkillRoot,aliceUser,aliceSkill.skillId+'.md'),'utf8')).includes(marker))
    await send(0,alice,'ALICE_SKILL_Q'); await send(1,bob,'BOB_SKILL_Q')
    await Promise.all([finished(0,alice),finished(1,bob)])
    const aliceCall=calls.find(call=>JSON.stringify(call).includes('ALICE_SKILL_Q'))
    const bobCall=calls.find(call=>JSON.stringify(call).includes('BOB_SKILL_Q'))
    assert(JSON.stringify(aliceCall).includes(marker));assert(!JSON.stringify(bobCall).includes(marker))
    await stop(host.process)
    const acceptedResponse=await post(`${platform.url}/sessions/prompt`,tokens[0],{sessionId:alice,requestId:randomUUID(),text:'SELECTED_BEFORE_TOGGLE'})
    assert.equal(acceptedResponse.status,200)
    const queued=await acceptedResponse.json()
    assert.equal(queued.accepted,true)
    const disabledResponse=await post(`${platform.url}/skills/toggle`,tokens[0],{skillId:aliceSkill.skillId,enabled:false})
    assert.equal(disabledResponse.status,200)
    const disabled=await disabledResponse.json()
    assert.equal(disabled.enabled,false)
    host=await start('host',platform.url)
    await finished(0,alice)
    const selectedCall=calls.find(call=>JSON.stringify(call).includes('SELECTED_BEFORE_TOGGLE'))
    assert(JSON.stringify(selectedCall).includes(marker))
    await send(0,alice,'AFTER_TOGGLE'); await finished(0,alice)
    const nextCall=calls.find(call=>JSON.stringify(call).includes('AFTER_TOGGLE'))
    const latestSystem=nextCall.messages.filter(message=>message.role==='system').at(-1)
    assert(latestSystem)
    assert(!JSON.stringify(latestSystem).includes(marker))
  })
  await t.test('accepted before execution survives SIGKILL and completed history resumes', async () => {
    const id = await create(0)
    const blocker = await pool.connect()
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM pe_sessions WHERE id=$1 FOR NO KEY UPDATE',[id])
    try {
      const accepted=await send(0,id,'after-restart');assert.equal(accepted.accepted,true)
      assert.equal((await pool.query('SELECT attempts FROM pe_operations WHERE id=$1',[accepted.operationId])).rows[0].attempts,0)
      await stop(host.process,'SIGKILL')
    } finally { await blocker.query('ROLLBACK');blocker.release() }
    host=await start('host',platform.url)
    await finished(0,id)
    assert.equal(calls.filter(call=>JSON.stringify(call).includes('after-restart')).length,1)
    const priorCount=(await page(0,alice)).events.filter(event=>event.type==='user/message').length
    await send(0,alice,'followup')
    const restored=await finished(0,alice)
    assert.equal(restored.events.filter(event=>event.type==='user/message').length,priorCount+1)
    const request=calls.find(call=>JSON.stringify(call).includes('followup'))
    assert(JSON.stringify(request).includes('reply:alpha'))
    assert(!JSON.stringify(request).includes('beta'))
  })
  await t.test('consumed input is not blindly replayed after interrupted inference', async () => {
    const id=await create(0)
    await send(0,id,'HOLD')
    await held.promise
    await stop(host.process,'SIGKILL')
    hold.resolve()
    await pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",[id])
    host=await start('host',platform.url)
    const result=await finished(0,id,'failed')
    assert.equal(result.operations[0].errorCode,'turn_interrupted')
    assert.equal(calls.filter(call=>JSON.stringify(call).includes('HOLD')).length,1)
    assert.equal(result.events.filter(event=>event.type==='user/message').length,1)
  })
  await t.test('expired grants cannot append or renew; replacement has a new epoch', async () => {
    await stop(host.process)
    const response=await post(`${platform.url}/sessions/create`,tokens[1],{requestId:randomUUID()});const {sessionId}=await response.json()
    await post(`${platform.url}/sessions/prompt`,tokens[1],{sessionId,requestId:randomUUID(),text:'fence'})
    const claim=async()=> (await post(`${platform.url}/runtime/claim`,workerToken,{workerId:randomUUID()})).json()
    const grants=await Promise.all([claim(),claim()]);const initial=grants.find(Boolean);assert.equal(grants.filter(Boolean).length,1)
    const endSeed={seq:0,time:1,type:'session/end-seed',data:{}}
    for(let i=0;i<2;i++) assert.equal((await post(`${platform.url}/runtime/append`,initial.token,{events:[endSeed]})).status,200)
    assert.equal((await pool.query('SELECT count(*) FROM pe_events WHERE session_id=$1',[sessionId])).rows[0].count,'1')
    await pool.query("UPDATE pe_sessions SET lease_until=now()-interval '1 second' WHERE id=$1",[sessionId])
    const replacement=await claim();assert.equal(replacement.epoch,initial.epoch+1)
    assert.equal((await post(`${platform.url}/runtime/renew`,initial.token,{})).status,409)
    assert.equal((await post(`${platform.url}/runtime/append`,initial.token,{events:[endSeed]})).status,409)
    assert.equal((await post(`${platform.url}/runtime/append`,replacement.token,{events:[{...endSeed,time:2}]})).status,409)
    assert.equal((await post(`${platform.url}/runtime/finish`,replacement.token,{outcome:'failed',errorCode:'test_release'})).status,200)
    host=await start('host',platform.url)
  })
  await t.test('logout revokes the credential and inactive Agents are released', async () => {
    assert.equal((await rpc(0,'logout',{})).ok,true)
    assert.equal((await rpcResponse(0,'me',{})).status,401)
    await eventually(async()=> {
      const status=await (await fetch(host.url+'/health')).json()
      return status.activeAgents===0 && status.loadedSessions===0 && status.activeGrants===0
    },'idle Agent and Session release')
    const count=await pool.query("SELECT count(*) FROM pe_events WHERE event->>'type'='tool/call'")
    assert.equal(count.rows[0].count,'0')
    for(const name of ['host','platform']) {
      const manifest=JSON.parse(await readFile(join(product,name,'package.json'),'utf8'))
      assert(!Object.keys(manifest.dependencies).some(name=>/sandbox|subprocess|terminal|fs-local|mcp-server/.test(name)))
    }
  })
  await t.test('connector approval uses a separate audience, exact action and remote reconciliation', async () => {
    const agentLogin = await post(`${platform.url}/identity/login`, null, { username: users[0].username, password: users[0].password })
    assert.equal(agentLogin.status, 200); tokens[0] = (await agentLogin.json()).token
    const approvalLogin = async index => {
      const response = await post(`${platform.url}/identity/approval-login`, null,
        { username: users[index].username, password: users[index].password })
      assert.equal(response.status, 200); return (await response.json()).token
    }
    const approvalAlice = await approvalLogin(0), approvalBob = await approvalLogin(1)
    assert.equal((await post(`${platform.url}/approvals/list`, tokens[0], {})).status, 401)
    assert.equal((await post(`${platform.url}/sessions/list`, approvalAlice, { offset: 0, limit: 10 })).status, 401)
    assert.equal((await post(`${host.url}/api/powerEvolve/me`, approvalAlice, { request: {} })).status, 401)
    const approvals = async token => (await (await post(`${platform.url}/approvals/list`, token, {})).json()).items
    const id = await create(0)
    await send(0, id, 'TOOL_APPEND:approved note'); await finished(0, id)
    const proposed = (await approvals(approvalAlice))[0]
    assert.equal(proposed.text, 'approved note'); assert.equal(proposed.state, 'pending')
    assert.equal((await rpc(0, 'actionsList', {})).items[0].actionId, proposed.actionId)
    assert.deepEqual((await rpc(1, 'actionsList', {})).items, [])
    assert.equal(remoteNotes.length, 0)
    assert.deepEqual(await approvals(approvalBob), [])
    await stop(host.process); await stop(platform.process)
    platform = await start('platform'); host = await start('host', platform.url)
    assert.equal((await approvals(approvalAlice))[0].state, 'pending')
    assert.equal(remoteNotes.length, 0)
    const decide = (token, action, fingerprint, approve) => post(`${platform.url}/approvals/decide`, token,
      { actionId: action.actionId, fingerprint, approve })
    const continued = async action => {
      const operation = await eventually(async () => {
        const result = await pool.query(
          'SELECT request_id,state FROM pe_operations WHERE source_action_id=$1', [action.actionId])
        return result.rows[0]?.state === 'completed' && result.rows[0]
      }, `continuation for ${action.actionId}`)
      const events = (await page(0, id)).events
      assert(events.some(event => event.type === 'user/message'
        && event.data.id === operation.request_id
        && event.data.source?.kind === 'power-evolve-action'
        && event.data.source.actionId === action.actionId))
      assert(calls.some(call => JSON.stringify(call.messages).includes(`操作 ${action.actionId}`)))
    }
    assert.equal((await decide(approvalBob, proposed, proposed.fingerprint, true)).status, 404)
    assert.equal((await decide(approvalAlice, proposed, '0'.repeat(64), true)).status, 409)
    assert.equal((await decide(approvalAlice, proposed, proposed.fingerprint, true)).status, 200)
    assert.equal((await decide(approvalAlice, proposed, proposed.fingerprint, true)).status, 200)
    await eventually(async () => (await approvals(approvalAlice))[0]?.state === 'succeeded', 'approved remote action')
    await continued(proposed)
    assert.deepEqual(remoteNotes.map(note => note.text), ['approved note'])
    await send(0, id, 'TOOL_LIST'); await finished(0, id)
    assert(calls.some(call => JSON.stringify(call.messages).includes('approved note')))

    await send(0, id, 'TOOL_APPEND:rejected note'); await finished(0, id)
    const rejected = (await approvals(approvalAlice))[0]
    assert.equal((await decide(approvalAlice, rejected, rejected.fingerprint, false)).status, 200)
    assert.equal((await approvals(approvalAlice))[0].state, 'rejected')
    await continued(rejected)
    assert.equal(remoteNotes.length, 1)
    assert.equal((await post(`${platform.url}/approvals/permission`, approvalAlice,
      { capability: 'trial_note_append', enabled: false })).status, 200)
    await send(0, id, 'TOOL_APPEND:blocked note'); await finished(0, id)
    assert.equal((await approvals(approvalAlice)).length, 2)
    assert.equal(remoteNotes.length, 1)
    assert.equal((await post(`${platform.url}/approvals/permission`, approvalAlice,
      { capability: 'trial_note_append', enabled: true })).status, 200)

    dropNextRemoteResponse = true
    await send(0, id, 'TOOL_APPEND:uncertain note'); await finished(0, id)
    const uncertain = (await approvals(approvalAlice))[0]
    assert.equal((await decide(approvalAlice, uncertain, uncertain.fingerprint, true)).status, 200)
    await eventually(async () => (await approvals(approvalAlice))[0]?.state === 'uncertain', 'uncertain remote response')
    assert.equal(remoteNotes.filter(note => note.text === 'uncertain note').length, 1)
    await stop(host.process); await stop(platform.process)
    platform = await start('platform'); host = await start('host', platform.url)
    await eventually(async () => (await approvals(approvalAlice))[0]?.state === 'succeeded', 'reconciled remote response', 15000)
    await continued(uncertain)
    assert.equal(remoteNotes.filter(note => note.text === 'uncertain note').length, 1)
    const attempts = await pool.query('SELECT attempts FROM pe_connector_actions WHERE id=$1', [uncertain.actionId])
    assert(Number(attempts.rows[0].attempts) >= 2)
  })
  await t.test('two native hosts behind a balancer preserve a Session across host loss', async () => {
    hostB = await start('host', platform.url, 'host-b')
    const socket = createServer()
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
    const balancerPort = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    const log = openSync(join(temporary, 'balancer.log'), 'a', 0o600)
    const balancerProcess = spawn(process.execPath, ['products/power-evolve/scripts/trial-lb.mjs'], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME,
        PE_HOST_PORT: new URL(host.url).port, PE_HOST_SECOND_PORT: new URL(hostB.url).port,
        PE_LOAD_BALANCER_PORT: String(balancerPort), PE_READY_FILE: join(temporary, 'balancer.json') },
      stdio: ['ignore', log, log],
    })
    closeSync(log); children.add(balancerProcess)
    balancer = { process: balancerProcess, url: `http://127.0.0.1:${balancerPort}` }
    const health = () => fetch(`${balancer.url}/health`).then(response => response.json())
    await eventually(async () => {
      if (balancerProcess.exitCode !== null) throw new Error(await readFile(join(temporary, 'balancer.log'), 'utf8'))
      return (await health().catch(() => null))?.backends.every(backend => backend.healthy)
    }, 'both hosts behind balancer')
    const request = async (method, value, user = 1) => {
      const response = await post(`${balancer.url}/api/powerEvolve/${method}`, tokens[user], { request: value })
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      return response.json()
    }
    const sessionId = (await request('create', { requestId: randomUUID() })).sessionId
    for (let index = 0; index < 4; index++) await request('me', {})
    const balanced = await health()
    assert(balanced.backends.every(backend => backend.served > 0))
    await request('prompt', { sessionId, requestId: randomUUID(), text: 'before-host-loss' })
    await eventually(async () => (await request('page', { sessionId, after: -1, limit: 100 }))
      .operations.at(-1)?.state === 'completed', 'balanced conversation')
    const hostPort = Number(new URL(host.url).port)
    await stop(host.process, 'SIGKILL')
    await eventually(async () => {
      const state = await health()
      return !state.backends[0].healthy && state.backends[1].healthy
    }, 'remaining host healthy')
    await request('prompt', { sessionId, requestId: randomUUID(), text: 'after-host-loss' })
    const recovered = await eventually(async () => {
      const page = await request('page', { sessionId, after: -1, limit: 200 })
      return page.operations.length === 2 && page.operations.every(operation => operation.state === 'completed') && page
    }, 'conversation on second host')
    assert.deepEqual(recovered.events.filter(event => event.type === 'user/message')
      .map(event => event.data.content[0].text), ['before-host-loss', 'after-host-loss'])
    host = await start('host', platform.url, 'host', hostPort)
    await eventually(async () => (await health()).backends.every(backend => backend.healthy), 'first host rejoined')
    const burst = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const user = index % 2
      const sessionId = (await request('create', { requestId: randomUUID() }, user)).sessionId
      await request('prompt', { sessionId, requestId: randomUUID(), text: `burst-${index}` }, user)
      return { user, sessionId }
    }))
    await eventually(async () => {
      const pages = await Promise.all(burst.map(({ user, sessionId }) =>
        request('page', { sessionId, after: -1, limit: 100 }, user)))
      return pages.every(page => page.operations[0]?.state === 'completed') && pages
    }, '16 concurrent conversations on two hosts')
    await eventually(async () => {
      const statuses = await Promise.all([host.url, hostB.url].map(url => fetch(`${url}/health`).then(response => response.json())))
      return statuses.every(value => value.activeAgents === 0 && value.loadedSessions === 0 && value.activeGrants === 0)
    }, 'idle resources released after burst')
  })
})
