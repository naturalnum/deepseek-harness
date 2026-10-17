/** Browser-safe validation of public limits and the relative bootstrap entry. */
import z from '@deepseek-ai/schemastery'
import type { CloudClientConfig } from './types.ts'

const MAX_TIMER_MS = 2_147_483_647

/** Limits have no production defaults; the reviewed browser manifest supplies them. */
export const CloudClientConfigSchema: z<CloudClientConfig> = z.object({
  bootstrapPath: z.string().required(),
  bootstrapTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
  maxBootstrapResponseBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxErrorResponseBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxPendingFetches: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxSockets: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  closeTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
})

/**
 * Validate public browser configuration before starting any network operation.
 * @param input - Loader configuration or the public browser manifest.
 * @returns validated finite limits and a document-relative bootstrap path.
 * @throws Error when a limit or relative route is invalid.
 */
export function parseCloudClientConfig(input: unknown): CloudClientConfig {
  const config = CloudClientConfigSchema(input as CloudClientConfig)
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(config.bootstrapPath)) {
    throw new Error('cloud client bootstrapPath must be a document-relative route without query or fragment')
  }
  return config
}
