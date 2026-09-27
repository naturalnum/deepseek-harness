/** Local desktop executor profile with a loopback authorization interface. */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson } from '../http.ts'
import { serveUi } from '../ui.ts'
import { DesktopWorker } from './worker.ts'

const executeFile = promisify(execFile)
export const name = 'power-evolve-device'
export const inject = ['webServer']
export const Config = schema.object({
  platformUrl: schema.string().required(), privateDir: schema.string().required(),
  image: schema.string().required(), pollMs: schema.number().min(100).required(),
  readyFile: schema.string().required(),
})
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
  const worker = new DesktopWorker(config.platformUrl, config.privateDir, config.image, config.pollMs)
  await worker.init(); worker.start()
  ctx.effect(() => () => worker.close())
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
          const selected = await executeFile('/usr/bin/osascript',
            ['-e', 'POSIX path of (choose folder with prompt "Choose a local project for PowerEvolve")'],
            { timeout: 120_000, maxBuffer: 4096 })
          sendJson(res, await worker.authorize(selected.stdout.trim())); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    } catch (error) { sendFailure(res, error) }
  }))
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid, url: origin, instanceId }), { mode: 0o600 })
}
