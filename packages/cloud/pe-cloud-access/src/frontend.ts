/** Public Cloud login document using the original native static-file responder. */
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { serveStatic } from '@deepseek-ai/dsh-host-frontend-static'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Loader name for the existing Cloud package's public frontend. */
export const name = 'pe-cloud-access/frontend'
/** Public assets need no account or native Connection provider. */
export const inject = ['webServer']
/** Public distribution selected by the trusted deployment profile. */
export interface Config {
  /** Absolute index path; its directory and every index injection must contain only public assets. */
  readonly distIndex: string
}
/** Configuration contains no identity, authentication material or production path default. */
export const Config: z<Config> = z.object({ distIndex: z.string().required() })

/**
 * Replace the profile's native frontend row with a public login document and assets.
 * @param ctx Original Loader entry owning the sole fallback registration.
 * @param config Public distribution; named API, authentication and WS handlers retain their checks.
 * @throws Error before registration for a relative path or an already occupied fallback.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.distIndex)) throw new Error('Cloud frontend requires an absolute public distIndex')
  const distIndex = config.distIndex, distRoot = dirname(distIndex)
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always supplies a URL. */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, () => true, renderIndex)
  }), 'pe-cloud-access: public frontend fallback')
}
