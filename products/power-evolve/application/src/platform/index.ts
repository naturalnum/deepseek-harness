/** Trusted platform profile: identity, durable tasks/events, and credentialed model egress. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Pool } from 'pg'
import { createRequest, listRequest, loginRequest, pageRequest, promptRequest, settings, PlatformError } from '../contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../http.ts'
import { initializeDatabase } from './database.ts'
import { hashPassword, IdentityService } from './identity.ts'
import { TaskStore } from './tasks.ts'
import { EventStore } from './events.ts'
import { proxyModel } from './model.ts'
import { serveUi } from '../ui.ts'

export const name = 'power-evolve-platform'
export const inject = ['webServer']

/** Platform settings contain file references; profile dumps do not contain secret values. */
export const Config = schema.object({
  databaseUrlFile: schema.string().required(), workerTokenFile: schema.string().required(),
  modelKeyFile: schema.string().required(), seedUsersFile: schema.string().required(),
  modelUrl: schema.string().required(), hostOrigin: schema.string().required(), platformOrigin: schema.string().required(),
  leaseMs: schema.number().min(1000).required(), tokenLifetimeMs: schema.number().min(1000).required(),
  maxPendingPerUser: schema.number().step(1).min(1).required(), maxActivePerUser: schema.number().step(1).min(1).required(),
  maxHistoryBytes: schema.number().step(1).min(1024).required(), maxHistoryEvents: schema.number().step(1).min(1).required(),
  maxEventBytes: schema.number().step(1).min(1024).required(), maxRequestBytes: schema.number().step(1).min(1024).required(),
  modelTimeoutMs: schema.number().min(1000).required(), maxModelResponseBytes: schema.number().min(1024).required(),
  readyFile: schema.string().required(), databasePoolSize: schema.number().step(1).min(1).required(),
  databaseTimeoutMs: schema.number().min(100).required(), loginWindowMs: schema.number().min(1000).required(),
  loginAttemptsPerWindow: schema.number().step(1).min(1).required(), loginTrackedAddresses: schema.number().step(1).min(1).required(),
})
export type Config = ReturnType<typeof Config>

const seedUsers = z.array(z.object({
  username: z.string().min(1).max(80), password: z.string().min(16).max(256), settings,
}).strict()).min(2).max(100)

/** Register the platform only after its schema and configured users are ready. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const instanceId = randomUUID()
  const [databaseUrl, workerToken, modelKey, seeds] = await Promise.all([
    readFile(config.databaseUrlFile, 'utf8'), readFile(config.workerTokenFile, 'utf8'),
    readFile(config.modelKeyFile, 'utf8'), readFile(config.seedUsersFile, 'utf8'),
  ])
  const pool = new Pool({ connectionString: databaseUrl.trim(), max: config.databasePoolSize, statement_timeout: config.databaseTimeoutMs })
  ctx.effect(() => () => pool.end())
  await initializeDatabase(pool)
  for (const user of seedUsers.parse(JSON.parse(seeds))) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING',
      [randomUUID(), user.username, await hashPassword(user.password), user.settings])
  }
  const identities = new IdentityService(pool, config.tokenLifetimeMs)
  const tasks = new TaskStore(pool, config)
  const events = new EventStore(tasks, config)
  const loginAttempts = new Map<string, { since: number; count: number }>()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', config.platformOrigin).pathname
    if (req.method === 'GET' && path === '/health') { sendJson(res, { ready: true, service: 'platform', schema: 1, instanceId }); return }
    if (req.method === 'GET' && path === '/config') { sendJson(res, { hostUrl: config.hostOrigin }); return }
    if (req.method === 'GET' && await serveUi(path, 'login', res)) return
    if (req.method !== 'POST') throw new PlatformError(404, 'not_found')
    if (path === '/model/v1/messages') {
      await proxyModel(tasks, {
        url: config.modelUrl, apiKey: modelKey.trim(), timeoutMs: config.modelTimeoutMs,
        maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxModelResponseBytes,
      }, req, res)
      return
    }
    if (path === '/identity/login') {
      if (req.headers.origin !== undefined && req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      const now = Date.now()
      for (const [key, value] of loginAttempts) if (now - value.since > config.loginWindowMs) loginAttempts.delete(key)
      const key = req.socket.remoteAddress ?? 'unknown'
      const attempt = loginAttempts.get(key) ?? { since: now, count: 0 }
      if (attempt.count >= config.loginAttemptsPerWindow || (!loginAttempts.has(key) && loginAttempts.size >= config.loginTrackedAddresses)) throw new PlatformError(429, 'login_rate_limit')
      attempt.count++
      loginAttempts.set(key, attempt)
      const input = loginRequest.parse(await readJson(req, 4096))
      sendJson(res, await identities.login(input.username, input.password))
      return
    }
    const token = bearer(req)
    if (path === '/runtime/claim') {
      const expected = Buffer.from(workerToken.trim())
      const supplied = Buffer.from(token)
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new PlatformError(401, 'unauthorized_worker')
      const input = z.object({ workerId: z.uuid() }).strict().parse(await readJson(req, 4096))
      sendJson(res, await tasks.claim(input.workerId))
      return
    }
    if (path.startsWith('/runtime/')) {
      const input = await readJson(req, config.maxRequestBytes)
      switch (path) {
        case '/runtime/snapshot': z.object({}).strict().parse(input); sendJson(res, await events.runtimeSnapshot(token)); return
        case '/runtime/append': sendJson(res, await events.append(token, z.object({ events: z.array(z.json()).max(256) }).strict().parse(input).events)); return
        case '/runtime/renew': z.object({}).strict().parse(input); await tasks.renew(token); sendJson(res, { ok: true }); return
        case '/runtime/finish': {
          const result = z.object({ outcome: z.enum(['completed', 'failed']), errorCode: z.string().max(80).nullable() }).strict().parse(input)
          await tasks.finish(token, result.outcome, result.errorCode)
          sendJson(res, { ok: true }); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    }
    const user = await identities.authenticate(token)
    const input = await readJson(req, config.maxRequestBytes)
    switch (path) {
      case '/identity/me': z.object({}).strict().parse(input); sendJson(res, user); return
      case '/identity/logout': z.object({}).strict().parse(input); await identities.logout(token); sendJson(res, { ok: true }); return
      case '/sessions/create': sendJson(res, await tasks.create(user, createRequest.parse(input).requestId)); return
      case '/sessions/list': {
        const { offset, limit } = listRequest.parse(input)
        sendJson(res, await tasks.list(user, offset, limit)); return
      }
      case '/sessions/prompt': {
        const { sessionId, requestId, text } = promptRequest.parse(input)
        sendJson(res, await tasks.accept(user, sessionId, requestId, text, user.settings)); return
      }
      case '/sessions/page': {
        const { sessionId, after, limit } = pageRequest.parse(input)
        sendJson(res, await events.page(user, sessionId, after, limit)); return
      }
      default: throw new PlatformError(404, 'not_found')
    }
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    try { await handle(req, res) }
    catch (error) {
      if (!(error instanceof PlatformError || error instanceof z.ZodError)) ctx.logger.warn('Platform request failed (%s)', error instanceof Error ? error.name : 'unknown')
      sendFailure(res, error)
    }
  }))
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid, url: `http://${ctx.webServer.host}:${ctx.webServer.port}`, instanceId }), { mode: 0o600 })
}
