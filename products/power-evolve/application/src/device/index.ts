/** Local desktop executor profile with a loopback authorization interface. */
import { execFile, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson } from '../http.ts'
import { serveUi } from '../ui.ts'
import { DesktopWorker } from './worker.ts'
import { OwnedDeviceContainer } from './owned-container.ts'

const executeFile = promisify(execFile)
export const name = 'power-evolve-device'
export const inject = ['webServer']
export const Config = schema.object({
  platformUrl: schema.string().required(), privateDir: schema.string().required(),
  coordinationRoot: schema.string().required(), pythonExecutable: schema.string().required(),
  fileOperationTimeoutMs: schema.number().step(1).min(100).max(60000).required(),
  image: schema.string().required(), pollMs: schema.number().min(100).required(),
  contactGraceMs: schema.number().step(1).min(100).max(60000).required(),
  commandPollMs: schema.number().step(1).min(10).max(60000).required(),
  platformRequestTimeoutMs: schema.number().step(1).min(100).max(60000).required(),
  dockerCommandTimeoutMs: schema.number().step(1).min(100).max(60000).required(),
  dockerStopTimeoutMs: schema.number().step(1).min(100).max(60000).required(),
  dockerStopGraceSeconds: schema.number().step(1).min(0).max(30).required(),
  directoryPickerTimeoutMs: schema.number().step(1).min(1000).max(120000).required(),
  readyFile: schema.string().required(),
})
/** Validated local Profile configuration; timing fields use milliseconds except the named stop grace. */
export type Config = ReturnType<typeof Config>

/** Mount a local-only UI; the current OS user approves paths before the device advertises them.
 * @param ctx - device profile plugin lifetime.
 * @param config - platform origin, local image, and private state.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const origin = `http://${ctx.webServer.host}:${ctx.webServer.port}`
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Device UI must bind loopback')
  const platform = new URL(config.platformUrl)
  if (platform.protocol !== 'https:' && !(platform.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(platform.hostname))) {
    throw new Error('Device platform must use HTTPS or local loopback')
  }
  if (config.dockerStopTimeoutMs <= config.dockerStopGraceSeconds * 1000) {
    throw new Error('Device Docker stop timeout must exceed its grace period')
  }
  if (!isAbsolute(config.coordinationRoot) || resolve(config.coordinationRoot) === resolve(config.privateDir)) {
    throw new Error('Device coordination requires a separate absolute root shared by local Profiles')
  }
  const worker = new DesktopWorker(config.platformUrl, config.privateDir, config.image, {
    pollMs: config.pollMs, contactGraceMs: config.contactGraceMs,
    commandPollMs: config.commandPollMs, platformRequestTimeoutMs: config.platformRequestTimeoutMs,
    coordinationRoot: config.coordinationRoot, pythonExecutable: config.pythonExecutable,
    fileOperationTimeoutMs: config.fileOperationTimeoutMs,
  }, new OwnedDeviceContainer({ commandTimeoutMs: config.dockerCommandTimeoutMs,
    stopTimeoutMs: config.dockerStopTimeoutMs, stopGraceSeconds: config.dockerStopGraceSeconds }))
  ctx.effect(() => () => worker.close())
  await worker.init(); worker.start()
  const pickerStop = new AbortController()
  let picker: Promise<{ stdout: string; stderr: string }> | undefined
  let pickerChild: ChildProcess | undefined
  ctx.effect(() => async () => {
    pickerStop.abort()
    pickerChild?.kill('SIGKILL')
    await picker?.catch((_pickerFailure: unknown) => {
      // The request reports picker failure; teardown only awaits the owned child exit.
    })
  })
  const nonce = randomBytes(24).toString('base64url'), instanceId = randomUUID()
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', origin).pathname
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, { ready: true, service: 'device', instanceId }); return
      }
      if (req.method === 'GET' && path === '/config') { sendJson(res, { nonce, status: worker.status() }); return }
      if (req.method === 'GET' && await serveUi(path, 'device', res)) return
      if (req.method !== 'POST' || !path.startsWith('/api/')) throw new PlatformError(404, 'not_found')
      if (req.headers.origin !== origin || req.headers['x-pe-device-nonce'] !== nonce) {
        throw new PlatformError(403, 'invalid_local_request')
      }
      const input = await readJson(req, 4096)
      switch (path) {
        case '/api/status': z.object({}).strict().parse(input); sendJson(res, worker.status()); return
        case '/api/pair': {
          const value = z.object({ code: z.string().min(24).max(128), name: z.string().trim().min(1).max(80) }).strict().parse(input)
          sendJson(res, await worker.pair(value.code, value.name)); return
        }
        case '/api/authorize': {
          const value = z.object({ path: z.string().min(1).max(2048) }).strict().parse(input)
          sendJson(res, await worker.authorize(value.path)); return
        }
        case '/api/import': {
          const value = z.object({ directoryId: z.uuid(), cloudPath: z.string().min(1).max(512),
            localPath: z.string().min(1).max(512) }).strict().parse(input)
          sendJson(res, await worker.importFile(value.directoryId, value.cloudPath, value.localPath)); return
        }
        case '/api/export': {
          const value = z.object({ directoryId: z.uuid(), cloudPath: z.string().min(1).max(512),
            localPath: z.string().min(1).max(512), requestId: z.uuid() }).strict().parse(input)
          sendJson(res, await worker.exportFile(value.directoryId, value.localPath, value.cloudPath, value.requestId)); return
        }
        case '/api/choose': {
          z.object({}).strict().parse(input)
          if (process.platform !== 'darwin') throw new PlatformError(501, 'native_picker_unavailable')
          if (!picker) {
            const pending = executeFile('/usr/bin/osascript',
              ['-e', 'POSIX path of (choose folder with prompt "Choose a local project for PowerEvolve")'],
              { timeout: config.directoryPickerTimeoutMs, maxBuffer: 4096, signal: pickerStop.signal })
            pickerChild = pending.child
            const exited = new Promise<void>(resolve => pending.child.once('close', () => resolve()))
            picker = pending.then(async value => { await exited; return value }, async (error: unknown) => {
              await exited
              throw error
            }).finally(() => { picker = undefined; pickerChild = undefined })
          }
          const selected = await picker
          sendJson(res, await worker.authorize(selected.stdout.trim())); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    } catch (error) { sendFailure(res, error) }
  }))
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid, url: origin, instanceId }), { mode: 0o600 })
}
