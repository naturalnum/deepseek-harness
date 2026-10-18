/** Browser-safe validation of public limits and the relative bootstrap entry. */
import z from '@deepseek-ai/schemastery'
import type { CloudClientConfig, CloudWebManifest } from './types.ts'

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

const positive = (): z<number> => z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required()

/** Optional Host browser inputs have no production defaults or identity fields. */
export const CloudWebManifestSchema: z<CloudWebManifest> = z.object({
  client: CloudClientConfigSchema.required(),
  decodeLimits: z.object({
    maxBodyBytes: positive(), maxStringBytes: positive(),
    maxListItems: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
  }).required(),
  persistenceLimits: z.object({
    maxKeys: positive(), maxKeyBytes: positive(), maxValueBytes: positive(),
    maxTotalBytes: positive(), maxNamespaceBytes: positive(),
  }).required(),
  fields: z.object({
    accountHeader: z.string().pattern(/^x-[a-z0-9-]+$/).required(),
    generationHeader: z.string().pattern(/^x-[a-z0-9-]+$/).required(),
    accountQuery: z.string().pattern(/^[A-Za-z][A-Za-z0-9_-]*$/).required(),
    generationQuery: z.string().pattern(/^[A-Za-z][A-Za-z0-9_-]*$/).required(),
  }).required(),
  auth: z.object({
    requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).required(),
    maxRequestBytes: positive(), maxResponseBytes: positive(),
  }).required(),
})

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const prototype: unknown = input === null || typeof input !== 'object' ? undefined : Object.getPrototypeOf(input)
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError('Cloud Web deployment inputs must be plain objects')
  }
  const record = input as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) {
    throw new TypeError('Cloud Web deployment inputs contain missing or unsupported fields')
  }
  return record
}

/**
 * Validate and detach public deployment inputs before authentication or native startup.
 * @param input - Host configuration or the structured browser injection.
 * @returns frozen limits and field names without account identity or authorization.
 * @throws Error for missing budgets, unsupported fields, or incompatible fixed ingress paths.
 */
export function parseCloudWebManifest(input: unknown): CloudWebManifest {
  const value = fields(input, ['client', 'decodeLimits', 'persistenceLimits', 'fields', 'auth'])
  fields(value['client'], ['bootstrapPath', 'bootstrapTimeoutMs', 'maxBootstrapResponseBytes',
    'maxErrorResponseBytes', 'maxPendingFetches', 'maxSockets', 'closeTimeoutMs'])
  fields(value['decodeLimits'], ['maxBodyBytes', 'maxStringBytes', 'maxListItems'])
  fields(value['persistenceLimits'], ['maxKeys', 'maxKeyBytes', 'maxValueBytes', 'maxTotalBytes', 'maxNamespaceBytes'])
  fields(value['fields'], ['accountHeader', 'generationHeader', 'accountQuery', 'generationQuery'])
  fields(value['auth'], ['requestTimeoutMs', 'maxRequestBytes', 'maxResponseBytes'])
  const parsed = CloudWebManifestSchema(input as CloudWebManifest)
  const client = parseCloudClientConfig(parsed.client)
  if (client.bootstrapPath !== 'cloud/bootstrap'
    || parsed.fields.accountHeader === parsed.fields.generationHeader
    || parsed.fields.accountQuery === parsed.fields.generationQuery) {
    throw new TypeError('Cloud Web inputs must match the fixed bootstrap path and distinct binding fields')
  }
  return Object.freeze({
    client: Object.freeze({ ...client }), decodeLimits: Object.freeze({ ...parsed.decodeLimits }),
    persistenceLimits: Object.freeze({ ...parsed.persistenceLimits }), fields: Object.freeze({ ...parsed.fields }),
    auth: Object.freeze({ ...parsed.auth }),
  })
}
