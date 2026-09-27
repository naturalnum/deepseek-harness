/** Trusted platform profile: identity, durable tasks/events, and credentialed model egress. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Pool } from 'pg'
import { createRequest, filesListRequest, fileReadRequest, filePutRequest, listRequest, loginRequest, pageRequest, promptRequest, skillInstallRequest, skillRequest, skillToggleRequest, settings, PlatformError } from '../contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../http.ts'
import { initializeDatabase } from './database.ts'
import { hashPassword, IdentityService } from './identity.ts'
import { TaskStore } from './tasks.ts'
import { EventStore } from './events.ts'
import { FileService } from './files.ts'
import { SkillService } from './skills.ts'
import { ConnectorService } from './connectors.ts'
import { proxyModel } from './model.ts'
import { serveUi } from '../ui.ts'

export const name = 'power-evolve-platform'
export const inject = ['webServer']

/** Platform settings contain file references; profile dumps do not contain secret values. */
export const Config = schema.object({
  databaseUrlFile: schema.string().required(), workerTokenFile: schema.string().required(),
  workspaceRoot: schema.string().required(),
  modelKeyFile: schema.string().required(), connectorKeyFile: schema.string().required(), seedUsersFile: schema.string().required(),
  modelUrl: schema.string().required(), hostOrigin: schema.string().required(), platformOrigin: schema.string().required(),
  connectorUrl: schema.string().required(), connectorTimeoutMs: schema.number().min(1000).required(),
  connectorPollMs: schema.number().min(100).required(),
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
  const [databaseUrl, workerToken, modelKey, connectorKey, seeds] = await Promise.all([
    readFile(config.databaseUrlFile, 'utf8'), readFile(config.workerTokenFile, 'utf8'),
    readFile(config.modelKeyFile, 'utf8'), readFile(config.connectorKeyFile, 'utf8'), readFile(config.seedUsersFile, 'utf8'),
  ])
  const pool = new Pool({ connectionString: databaseUrl.trim(), max: config.databasePoolSize, statement_timeout: config.databaseTimeoutMs })
  ctx.effect(() => () => pool.end())
  await initializeDatabase(pool)
  const files = new FileService(pool, config.workspaceRoot)
  await files.init()
  const skills = new SkillService(pool, config.workspaceRoot)
  await skills.init()
  const users = seedUsers.parse(JSON.parse(seeds))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING',
      [randomUUID(), user.username, await hashPassword(user.password), user.settings])
  }
  const identities = new IdentityService(pool, config.tokenLifetimeMs)
  const tasks = new TaskStore(pool, config)
  const events = new EventStore(tasks, config)
  const connectors = new ConnectorService(tasks, config.connectorUrl, connectorKey.trim(), config.connectorTimeoutMs, config.connectorPollMs)
  await connectors.seedPermissions(users.map(user => user.username))
  connectors.start()
  ctx.effect(() => () => connectors.close())
  const loginAttempts = new Map<string, { since: number; count: number }>()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', config.platformOrigin).pathname
    if (req.method === 'GET' && path === '/health') { sendJson(res, { ready: true, service: 'platform', schema: 4, instanceId }); return }
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
    if (path === '/identity/login' || path === '/identity/approval-login') {
      if (req.headers.origin !== undefined && req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      const now = Date.now()
      for (const [key, value] of loginAttempts) if (now - value.since > config.loginWindowMs) loginAttempts.delete(key)
      const key = req.socket.remoteAddress ?? 'unknown'
      const attempt = loginAttempts.get(key) ?? { since: now, count: 0 }
      if (attempt.count >= config.loginAttemptsPerWindow || (!loginAttempts.has(key) && loginAttempts.size >= config.loginTrackedAddresses)) throw new PlatformError(429, 'login_rate_limit')
      attempt.count++
      loginAttempts.set(key, attempt)
      const input = loginRequest.parse(await readJson(req, 4096))
      sendJson(res, await identities.login(input.username, input.password, path === '/identity/approval-login' ? 'approval' : 'agent'))
      return
    }
    const token = bearer(req)
    if (path.startsWith('/approvals/')) {
      if (req.headers.origin !== undefined && req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      const user = await identities.authenticate(token, 'approval')
      const input = await readJson(req, 4096)
      switch (path) {
        case '/approvals/me': z.object({}).strict().parse(input); sendJson(res, user); return
        case '/approvals/list': z.object({}).strict().parse(input); sendJson(res, await connectors.list(user)); return
        case '/approvals/permissions': z.object({}).strict().parse(input); sendJson(res, await connectors.permissions(user)); return
        case '/approvals/permission': {
          const value = z.object({ capability: z.enum(['trial_note_query', 'trial_note_append']), enabled: z.boolean() }).strict().parse(input)
          sendJson(res, await connectors.setPermission(user, value.capability, value.enabled)); return
        }
        case '/approvals/decide': {
          const value = z.object({ actionId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), approve: z.boolean() }).strict().parse(input)
          sendJson(res, await connectors.decide(user, value.actionId, value.fingerprint, value.approve)); return
        }
        case '/approvals/logout': z.object({}).strict().parse(input); await identities.logout(token); sendJson(res, { ok: true }); return
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path === '/runtime/claim') {
      const expected = Buffer.from(workerToken.trim())
      const supplied = Buffer.from(token)
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new PlatformError(401, 'unauthorized_worker')
      const input = z.object({ workerId: z.uuid() }).strict().parse(await readJson(req, 4096))
      const claimed = await tasks.claim(input.workerId)
      if (!claimed) { sendJson(res, null); return }
      try { sendJson(res, { ...claimed, skills: await skills.snapshot(claimed.userId, claimed.selection) }) }
      catch (_unavailableSkill) {
        await tasks.finish(claimed.token, 'failed', 'skill_unavailable')
        sendJson(res, null)
      }
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
        case '/runtime/connectors/notes': z.object({}).strict().parse(input); sendJson(res, await connectors.notes(token)); return
        case '/runtime/connectors/prepare': {
          const value = z.object({ callId: z.string().min(1).max(100), text: z.string().trim().min(1).max(1000) }).strict().parse(input)
          sendJson(res, await connectors.prepare(token, value.callId, value.text)); return
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
      case '/files/list': sendJson(res, await files.list(user, filesListRequest.parse(input).directory)); return
      case '/files/read': sendJson(res, await files.read(user, fileReadRequest.parse(input).path)); return
      case '/files/put': {
        const value = filePutRequest.parse(input)
        sendJson(res, await files.put(user, value.requestId, value.path, value.baseRevision, value.data)); return
      }
      case '/skills/list': z.object({}).strict().parse(input); sendJson(res, await skills.list(user)); return
      case '/skills/read': sendJson(res, await skills.read(user, skillRequest.parse(input).skillId)); return
      case '/skills/install': {
        const value = skillInstallRequest.parse(input)
        sendJson(res, await skills.install(user, value.requestId, value.name, value.description, value.instructions)); return
      }
      case '/skills/toggle': {
        const value = skillToggleRequest.parse(input)
        sendJson(res, await skills.toggle(user, value.skillId, value.enabled)); return
      }
      case '/connectors/actions': z.object({}).strict().parse(input); sendJson(res, await connectors.list(user)); return
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
