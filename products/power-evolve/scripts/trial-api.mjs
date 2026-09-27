/** Loopback-only remote API fixture with durable idempotency for product trials. */
import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile, rename, open, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const directory = process.env.PE_PRIVATE_DIR
const port = Number(process.env.PE_TARGET_PORT ?? 18884)
const readyFile = process.env.PE_READY_FILE
if (!directory || !readyFile || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid trial API configuration')
const key = (await readFile(`${directory}/connector-key`, 'utf8')).trim()
const dataFile = `${directory}/trial-api-notes.json`
const instanceId = randomUUID()
let notes
try { notes = JSON.parse(await readFile(dataFile, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error; notes = [] }
if (!Array.isArray(notes)) throw new Error('Invalid trial API data')
let writes = Promise.resolve()

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}
async function body(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4096) throw new Error('request_too_large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function authorized(req) {
  const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''))
  const expected = Buffer.from(key)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
async function persist() {
  const temporary = `${dataFile}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(notes)); await file.sync() }
  finally { await file.close() }
  await rename(temporary, dataFile)
  const parent = await open(dirname(dataFile), 'r')
  try { await parent.sync() } finally { await parent.close() }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/health') { send(res, 200, { ready: true, service: 'trial-api', instanceId }); return }
    if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }); return }
    if (req.method === 'GET' && url.pathname === '/v1/notes') {
      const owner = url.searchParams.get('owner')
      if (!owner || !/^[a-f0-9-]{36}$/.test(owner)) { send(res, 400, { error: 'invalid_owner' }); return }
      send(res, 200, { items: notes.filter(item => item.owner === owner).slice(-100) }); return
    }
    const action = /^\/v1\/actions\/([a-f0-9-]{36})$/.exec(url.pathname)
    if (req.method === 'GET' && action) {
      const found = notes.find(item => item.actionId === action[1])
      send(res, found ? 200 : 404, found ?? { error: 'not_found' }); return
    }
    if (req.method === 'POST' && url.pathname === '/v1/notes') {
      const actionId = req.headers['idempotency-key']
      const input = await body(req)
      if (typeof actionId !== 'string' || !/^[a-f0-9-]{36}$/.test(actionId)
        || typeof input.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(input.owner)
        || typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 1000) {
        send(res, 400, { error: 'invalid_action' }); return
      }
      const operation = writes.then(async () => {
        const previous = notes.find(item => item.actionId === actionId)
        if (previous) return { status: previous.owner === input.owner && previous.text === input.text ? 200 : 409,
          value: previous.owner === input.owner && previous.text === input.text ? previous : { error: 'idempotency_conflict' } }
        const value = { actionId, owner: input.owner, text: input.text, createdAt: new Date().toISOString() }
        notes.push(value)
        try { await persist() } catch (error) { notes.pop(); throw error }
        return { status: 201, value }
      })
      writes = operation.then(() => undefined, () => undefined)
      const result = await operation
      send(res, result.status, result.value); return
    }
    send(res, 404, { error: 'not_found' })
  } catch (_error) { send(res, 500, { error: 'trial_api_error' }) }
})

await mkdir(dirname(readyFile), { recursive: true, mode: 0o700 })
server.listen(port, '127.0.0.1', async () => {
  await writeFile(readyFile, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}`, instanceId }), { mode: 0o600 })
})
process.on('SIGTERM', () => server.close())
