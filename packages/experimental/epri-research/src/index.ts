/** Account-owned EPRI research service over the existing Cloud runtime. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ResearchService, type ResearchBackend } from './service.ts'
export type { ResearchService } from './service.ts'

/** Loader identity for the optional research integration. */
export const name = 'epri-research'
/** Account preparation and the original Controller must precede this feature. */
export const inject = ['peCloudApi', 'sessionController']
/** Trusted deployment paths and finite operation limits; no account or credential settings. */
export interface Config {
  /** File URL of the independently built research backend. */
  backendModule: string
  /** Python executable in the approved OpenSandbox image. */
  python: string
  /** Complete research request/result byte limit, within the platform carrier limit. */
  maxJsonBytes: number
  /** Per-stream retained execution output limit. */
  maxOutputBytes: number
  /** Native managed-range cleanup observation limit. */
  graceMs: number
}
/** Every deployment-dependent choice is explicit. */
export const Config: z<Config> = z.object({
  backendModule: z.string().required(), python: z.string().required(),
  maxJsonBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxOutputBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(), graceMs: z.natural().min(1).max(2147483647).required(),
})

/** Load the reviewed backend and attach it to this exact account graph.
 * @param ctx Original account Loader fiber.
 * @param config Fixed deployment inputs sealed by the account recipe.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (new URL(config.backendModule).protocol !== 'file:' || !config.python.startsWith('/')
    || ![config.maxJsonBytes, config.maxOutputBytes, config.graceMs].every(value => Number.isSafeInteger(value) && value > 0)
    || config.graceMs > 2147483647) {
    throw new Error('Research requires a built file module, an image executable and finite integer limits.')
  }
  // The trusted deployment module implements the independently built EPRI backend.
  const backend: unknown = await import(config.backendModule)
  if (backend === null || typeof backend !== 'object' || typeof Reflect.get(backend, 'install') !== 'function'
    || typeof Reflect.get(backend, 'openCloudStore') !== 'function') throw new Error('The research backend exports are incomplete.')
  new ResearchService(ctx, config, backend as ResearchBackend)
}
