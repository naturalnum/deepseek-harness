/** Owned loopback passthrough; one armed rule withholds a real Platform reply. Importing starts no server. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { compareRetainedRequest, retainedIdentity } from './identity-evidence.mjs'

/** Create an explicit bounded proxy for one Host's actual configured Platform transport.
 * @param options Loopback upstream origin, optional owned port, watched POST paths and explicit budgets.
 * @returns Owned origin, single-fault controls, tokenless observations and awaited teardown.
 */
export async function createFaultProxy(options) {
  const { targetOrigin, port = 0, watchedPaths,
    maxRequestBytes, maxFaultResponseBytes, requestTimeoutMs } = options
  const target = new URL(targetOrigin)
  assert.equal(target.origin, targetOrigin)
  assert(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert(!target.username && !target.password && Number.isInteger(port) && port >= 0 && port <= 65535)
  assert(Array.isArray(watchedPaths) && watchedPaths.length > 0
    && watchedPaths.every(path => typeof path === 'string' && /^\/[A-Za-z0-9_/-]+$/.test(path)))
  for (const limit of [maxRequestBytes, maxFaultResponseBytes, requestTimeoutMs]) assert(Number.isInteger(limit) && limit > 0)
  const watched = new Set(watchedPaths), observations = [], originals = new Map(), originalHeaders = new Map()
  const families = new Set(['publication', 'admission', 'claim', 'queue', 'step',
      'prepared-cancel', 'archive-cancel', 'turn-transition']), intentFamilies = new Map()
  const requests = new Set(), sockets = new Set(), held = new Map(), inFlight = new Set()
  let pending, activeRule, closing = false, nextRule = 0, closedPromise
  const server = createServer((req, res) => {
    const task = forward(req, res).catch((error) => {
      observations.push({ at: new Date().toISOString(), action: 'proxy-error', errorName: error?.name ?? 'Error',
        errorCode: typeof error?.code === 'string' ? error.code : undefined })
      res.destroy()
    }).finally(() => inFlight.delete(task))
    inFlight.add(task)
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })

  async function forward(req, res) {
    assert(!closing && typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//'))
    const path = new URL(req.url, targetOrigin).pathname
    const chunks = []; let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      assert(bytes <= maxRequestBytes, 'Owned proxy request budget exceeded')
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks, bytes)
    const observed = req.method === 'POST' && watched.has(path)
    const parsed = observed ? JSON.parse(body.toString('utf8')) : undefined
    const family = parsed?.mutation?.family ?? parsed?.family ?? intentFamilies.get(parsed?.intentId)
    const rule = pending?.path === path && pending.method === req.method
      && (pending.family === undefined || pending.family === family)
      && (pending.intentId === undefined || pending.intentId === parsed?.intentId) ? pending : undefined
    if (rule) pending = undefined
    let entry
    if (observed) {
      const original = originals.get(path)
      entry = { at: new Date().toISOString(), action: 'actual-request', path, bytes, family,
        identity: retainedIdentity(parsed), comparisonWithFirst: original ? compareRetainedRequest(original, body) : undefined,
        authorizationEqualToFirst: original ? req.headers.authorization === originalHeaders.get(path) : undefined,
        ruleId: rule?.id }
      if (!original) { originals.set(path, Buffer.from(body)); originalHeaders.set(path, req.headers.authorization) }
      observations.push(entry)
    }
    const upstream = httpRequest(new URL(req.url, targetOrigin), { method: req.method,
      headers: { ...req.headers, host: target.host } })
    requests.add(upstream)
    upstream.once('close', () => requests.delete(upstream))
    upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new Error('Owned proxy upstream timeout')))
    const reply = once(upstream, 'response')
    upstream.end(body)
    const [actual] = await reply
    if (!rule && !observed) {
      res.once('close', () => { if (!res.writableEnded) actual.destroy() })
      res.writeHead(actual.statusCode, actual.headers)
      await pipeline(actual, res)
      return
    }
    const replyChunks = []; let replyBytes = 0
    for await (const chunk of actual) {
      replyBytes += chunk.length
      assert(replyBytes <= maxFaultResponseBytes, 'Owned proxy fault-response budget exceeded')
      replyChunks.push(chunk)
    }
    const replyBody = Buffer.concat(replyChunks, replyBytes)
    const replyJson = actual.headers['content-type']?.startsWith('application/json')
      ? JSON.parse(replyBody.toString('utf8')) : undefined
    if (actual.statusCode === 200 && typeof replyJson?.intentId === 'string' && families.has(replyJson.family)) {
      intentFamilies.set(replyJson.intentId, replyJson.family)
    }
    observations.push({ at: new Date().toISOString(), action: 'actual-upstream-response-complete',
      ruleId: rule?.id, path, family, status: actual.statusCode, bytes: replyBytes,
      responseIdentity: retainedIdentity(replyJson),
      durableCommitVerified: false })
    if (!rule) { res.writeHead(actual.statusCode, actual.headers); res.end(replyBody); return }
    let disposition = rule.mode
    if (rule.mode === 'hold-response' && !closing) {
      disposition = await new Promise(resolve => held.set(rule.id, resolve))
      held.delete(rule.id)
    }
    if (disposition === 'pass') {
      res.writeHead(actual.statusCode, actual.headers); res.end(replyBody)
    } else {
      observations.push({ at: new Date().toISOString(), action: 'actual-reply-dropped', ruleId: rule.id, path })
      res.destroy()
    }
    activeRule = undefined
  }

  server.listen(port, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  return {
    origin: 'http://127.0.0.1:' + address.port,
    arm({ path, mode, method = 'POST', family, intentId }) {
      assert(!closing && activeRule === undefined && watched.has(path) && method === 'POST')
      assert(['drop-response', 'hold-response'].includes(mode))
      assert(family === undefined || families.has(family))
      assert(intentId === undefined || (typeof intentId === 'string' && /^[a-f0-9]{64}$/u.test(intentId)))
      const id = ++nextRule; activeRule = id; pending = { id, path, mode, method, family, intentId }; return id
    },
    release(id, disposition) {
      assert(['pass', 'drop'].includes(disposition))
      const resolve = held.get(id); assert(resolve, 'Only an actual completed held reply may be released')
      resolve(disposition)
    },
    snapshot() { return structuredClone(observations) },
    close() {
      closedPromise ??= (async () => {
        closing = true; pending = undefined
        for (const resolve of held.values()) resolve('drop')
        for (const req of requests) req.destroy()
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        for (const socket of sockets) socket.destroy()
        await closed
        await Promise.allSettled([...inFlight])
        for (const body of originals.values()) body.fill(0)
        originals.clear(); originalHeaders.clear(); intentFamilies.clear()
      })()
      return closedPromise
    },
  }
}
