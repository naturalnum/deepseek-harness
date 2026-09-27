/** Built-profile integration: real PostgreSQL, native Agent/Session, deterministic Messages transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
test('slice 1: isolated users, durable acceptance, restart, fencing and native history', { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-slice1-'))
  const database = `pe_test_${randomBytes(10).toString('hex')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  let pool, host, platform, model, databaseCreated = false
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
  for (const [name, value] of Object.entries({ 'database-url': url.href, 'worker-token': workerToken, 'model-key': providerKey, 'users.json': JSON.stringify(users) })) await writeFile(join(temporary, name), value, { mode: 0o600 })
  const recorded = await recordedConversation()
  const calls = []
  let hold = Promise.withResolvers(), held = Promise.withResolvers()
  model = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['x-api-key'], providerKey)
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push(body)
      const prompt = body.messages.at(-1).content.filter(block => block.type === 'text').map(block => block.text).join('')
      if (prompt === 'HOLD') { held.resolve(); await hold.promise }
      const text = prompt === recorded.input ? recorded.output : `reply:${prompt}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
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

  async function start(name, platformUrl) {
    const home = join(temporary, name), profile = join(home, 'profiles', `power-evolve-${name}`)
    await mkdir(join(profile, 'node_modules/@power-evolve'), { recursive: true })
    try { await symlink(join(product, name), join(profile, 'node_modules/@power-evolve', name), 'dir') }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }))
    const bundle = yaml.load(await readFile(join(product, name, 'cordis.patch.yml'), 'utf8'), { schema: manifestSchema })
    const rows = bundle[0].insert
    const readyFile = join(home, 'ready.json')
    await rm(readyFile, { force: true })
    const update = (id, fields) => ({ id, config: { ...rows.find(row => row.id === id).config, ...fields } })
    const patch = [update('web-server', { port: 0 })]
    if (name === 'platform') patch.push(update('power-evolve-platform', {
      databaseUrlFile: join(temporary, 'database-url'), workerTokenFile: join(temporary, 'worker-token'), modelKeyFile: join(temporary, 'model-key'), seedUsersFile: join(temporary, 'users.json'),
      readyFile, modelUrl, leaseMs: 3000, loginAttemptsPerWindow: 100, maxPendingPerUser: 8,
    }))
    else patch.push(update('power-evolve-runtime', { platformUrl, workerTokenFile: join(temporary, 'worker-token') }), update('power-evolve-host', { platformOrigin: platformUrl, readyFile, renewMs: 500, operationTimeoutMs: 20000, pollMs: 50 }))
    await writeFile(join(profile, 'cordis.patch.yml'), yaml.dump(patch))
    const log = openSync(join(temporary, `${name}.log`), 'a', 0o600)
    const child = spawn(process.execPath, ['apps/cli/lib/bin.js', '--profile', `power-evolve-${name}`], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: home, PE_PRIVATE_DIR: temporary }, stdio: ['ignore', log, log] })
    closeSync(log); children.add(child)
    const ready = await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} exited before ready: ${await readFile(join(temporary, name+'.log'),'utf8')}`)
      try { return JSON.parse(await readFile(readyFile, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    }, `${name} ready`)
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
  const finished = async (user, id, state = 'completed') => eventually(async () => { const value = await page(user,id); return value.operations[0]?.state === state && value }, `${state} operation`)
  const send = (user, id, text, requestId = randomUUID()) => rpc(user, 'prompt', { sessionId: id, requestId, text })

  await t.test('two identities, strict fields and credentials restricted to platform', async () => {
    assert.equal((await rpc(0, 'me', {})).settings.maxTokens, 2048)
    assert.equal((await rpc(1, 'me', {})).settings.maxTokens, 1536)
    assert.equal((await rpcResponse(0, 'me', { userId: randomUUID() })).status, 400)
    assert.equal((await post(`${host.url}/api/settings/get`, tokens[0], {})).status, 404)
    assert.equal((await post(`${platform.url}/runtime/claim`, tokens[0], { workerId: randomUUID() })).status, 401)
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
    await send(0,alice,'followup')
    const restored=await finished(0,alice)
    assert.equal(restored.events.filter(event=>event.type==='user/message').length,2)
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
})
