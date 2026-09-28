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
import { ExecutionService } from './executions.ts'
import { DeviceService } from './devices.ts'
import { KubernetesClient } from './kubernetes.ts'
import { SandboxManager } from './sandbox.ts'
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
  sandboxKubeconfigFile: schema.string().default(''), sandboxKeyFile: schema.string().default(''),
  sandboxNamespace: schema.string().default(''), sandboxImage: schema.string().default(''),
  sandboxLocalRoot: schema.string().default(''), sandboxNodeRoot: schema.string().default(''),
  sandboxReadyTimeoutMs: schema.number().min(1000).default(60000),
  sandboxConcurrency: schema.number().step(1).min(1).default(4),
  sandboxPollMs: schema.number().min(100).default(500), sandboxIdleMs: schema.number().min(1000).default(300000),
  sandboxCommandTimeoutMs: schema.number().min(1000).default(60000),
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
  const executionEnabled = config.sandboxKubeconfigFile.length > 0
  if (executionEnabled && (!config.sandboxKeyFile || !config.sandboxNamespace || !config.sandboxImage
    || !config.sandboxLocalRoot || !config.sandboxNodeRoot)) throw new Error('Incomplete Agent Sandbox configuration')
  const files = new FileService(pool, config.workspaceRoot, executionEnabled ? { uid: 1000, gid: 1000 } : undefined)
  await files.init()
  const skills = new SkillService(pool, config.workspaceRoot)
  await skills.init()
  const users = seedUsers.parse(JSON.parse(seeds))
  for (const user of users) {
    await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING',
      [randomUUID(), user.username, await hashPassword(user.password), user.settings])
  }
  const identities = new IdentityService(pool, config.tokenLifetimeMs)
  const tasks = new TaskStore(pool, { ...config, executionEnabled })
  const events = new EventStore(tasks, config)
  const connectors = new ConnectorService(tasks, config.connectorUrl, connectorKey.trim(), config.connectorTimeoutMs, config.connectorPollMs)
  await connectors.seedPermissions(users.map(user => user.username))
  connectors.start()
  ctx.effect(() => () => connectors.close())
  const executions = executionEnabled ? new ExecutionService(tasks, new SandboxManager(
    await KubernetesClient.fromFile(config.sandboxKubeconfigFile), files, pool,
    (await readFile(config.sandboxKeyFile, 'utf8')).trim(), {
      namespace: config.sandboxNamespace, image: config.sandboxImage,
      localRoot: config.sandboxLocalRoot, nodeRoot: config.sandboxNodeRoot,
      readyTimeoutMs: config.sandboxReadyTimeoutMs,
    }), config.sandboxConcurrency, config.sandboxPollMs, config.sandboxIdleMs, config.sandboxCommandTimeoutMs) : null
  if (executions) { executions.start(); ctx.effect(() => () => executions.close()) }
  const devices = new DeviceService(tasks, config.sandboxCommandTimeoutMs, files)
  const loginAttempts = new Map<string, { since: number; count: number }>()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', config.platformOrigin).pathname
    if (req.method === 'GET' && path === '/health') { sendJson(res, { ready: true, service: 'platform', schema: 7, executionEnabled, instanceId }); return }
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
    if (path === '/devices/enroll') {
      const input = z.object({ code: z.string().min(24).max(128), name: z.string().trim().min(1).max(80),
        instanceId: z.uuid() }).strict().parse(await readJson(req, 4096))
      sendJson(res, await devices.enroll(input.code, input.name, input.instanceId)); return
    }
    const token = bearer(req)
    if (path.startsWith('/devices/agent/')) {
      const input = await readJson(req, config.maxRequestBytes)
      switch (path) {
        case '/devices/agent/directory': {
          const value = z.object({ label: z.string().trim().min(1).max(100) }).strict().parse(input)
          sendJson(res, await devices.directory(token, value.label)); return
        }
        case '/devices/agent/files/read': {
          const value = z.object({ directoryId: z.uuid(), path: z.string().min(1).max(512) }).strict().parse(input)
          sendJson(res, await devices.readCloud(token, value.directoryId, value.path)); return
        }
        case '/devices/agent/files/put': {
          const value = z.object({ directoryId: z.uuid(), requestId: z.uuid(),
            path: z.string().min(1).max(512), data: z.string().max(2_800_000) }).strict().parse(input)
          sendJson(res, await devices.putCloud(token, value.directoryId, value.requestId, value.path, value.data)); return
        }
        case '/devices/agent/jobs': {
          const value = z.object({ instanceId: z.uuid() }).strict().parse(input)
          sendJson(res, await devices.jobs(token, value.instanceId)); return
        }
        case '/devices/agent/claim': {
          const value = z.object({ instanceId: z.uuid(), executionId: z.uuid() }).strict().parse(input)
          sendJson(res, await devices.claim(token, value.instanceId, value.executionId)); return
        }
        case '/devices/agent/finish': {
          const value = z.object({ instanceId: z.uuid(), executionId: z.uuid(), result: z.object({
            state: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain']), exitCode: z.number().int().nullable(),
            stdout: z.string().max(65_536), stderr: z.string().max(65_536),
            stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(), timedOut: z.boolean(),
          }).strict() }).strict().parse(input)
          sendJson(res, await devices.finish(token, value.instanceId, value.executionId, value.result)); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    }
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
        case '/runtime/executions/propose': {
          if (!executions) throw new PlatformError(503, 'execution_unavailable')
          const value = z.object({ callId: z.string().min(1).max(100), command: z.string().min(1).max(8192),
            cwd: z.string().max(256).regex(/^(?:|[A-Za-z0-9._/-]{1,256})$/) }).strict().parse(input)
          if (value.cwd.split('/').some(part => part === '..')) throw new PlatformError(400, 'invalid_cwd')
          sendJson(res, await executions.propose(token, value.callId, value.command, value.cwd)); return
        }
        case '/runtime/desktop-executions/propose': {
          const value = z.object({ callId: z.string().min(1).max(100), command: z.string().min(1).max(8192),
            cwd: z.string().max(256).regex(/^(?:|[A-Za-z0-9._/-]{1,256})$/) }).strict().parse(input)
          if (value.cwd.split('/').some(part => part === '..')) throw new PlatformError(400, 'invalid_cwd')
          sendJson(res, await devices.propose(token, value.callId, value.command, value.cwd)); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path === '/identity/exchange') {
      z.object({}).strict().parse(await readJson(req, 4096))
      sendJson(res, { token: await identities.exchange(token) })
      return
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
        const { sessionId, requestId, text, target } = promptRequest.parse(input)
        sendJson(res, await tasks.accept(user, sessionId, requestId, text, user.settings, target)); return
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
      case '/executions/list': {
        z.object({}).strict().parse(input)
        const cloudItems: Array<Record<string, unknown>> = executions
          ? (await executions.list(user) as { items: Array<Record<string, unknown>> }).items : []
        const desktop = await devices.executions(user) as { items: Array<Record<string, unknown>> }
        sendJson(res, { items: [...cloudItems.map(item => ({ ...item, target: { kind: 'cloud' }, createdAt: String(item.createdAt) })),
          ...desktop.items.map(item => ({ ...item, createdAt: String(item.createdAt) }))]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) }); return
      }
      case '/executions/cancel': {
        const value = z.object({ executionId: z.uuid() }).strict().parse(input)
        if (executions) {
          try { sendJson(res, await executions.cancel(user, value.executionId)); return }
          catch (error) { if (!(error instanceof PlatformError && error.status === 404)) throw error }
        }
        sendJson(res, await devices.cancel(user, value.executionId)); return
      }
      case '/devices/list': z.object({}).strict().parse(input); sendJson(res, await devices.list(user)); return
      case '/devices/pair': z.object({}).strict().parse(input); sendJson(res, await devices.pair(user)); return
      case '/devices/revoke': {
        const value = z.object({ deviceId: z.uuid() }).strict().parse(input)
        await devices.revoke(user, value.deviceId); sendJson(res, { ok: true }); return
      }
      case '/devices/directories/revoke': {
        const value = z.object({ directoryId: z.uuid() }).strict().parse(input)
        await devices.revokeDirectory(user, value.directoryId); sendJson(res, { ok: true }); return
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
