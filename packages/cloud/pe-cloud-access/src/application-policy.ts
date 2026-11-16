/** Explicit same-site content origins and finite service-application HTTP/authentication limits. */
import z from '@deepseek-ai/schemastery'
import type { AccessConfig } from './types.ts'
import type { ApplicationReadLimits } from '@deepseek-ai/dsh-pe-opensandbox/types'
import type { ApplicationViewLimits } from './application-views.ts'

/** Complete Root-only service-content inputs; omission preserves the existing inert preview route. */
export interface ServiceApplicationConfig {
  readonly origin: string
  readonly siteDomain: string
  readonly maxUrlBytes: number
  readonly maxPathBytes: number
  readonly maxRequestHeaderCount: number
  readonly maxRequestHeaderBytes: number
  readonly maxRequestBodyBytes: number
  readonly maxQueuedRequests: number
  readonly queueTimeoutMs: number
  readonly response: ApplicationReadLimits
  readonly views: ApplicationViewLimits
}

const positive = () => z.natural().min(1).max(2_147_483_647).required()
const bytes = () => z.natural().min(1).max(1_048_576).required()

/** Root Loader structure with no feature, capacity or timeout defaults. */
export const ServiceApplicationConfigSchema: z<ServiceApplicationConfig> = z.object({
  origin: z.string().required(), siteDomain: z.string().required(), maxUrlBytes: bytes(), maxPathBytes: bytes(),
  maxRequestHeaderCount: z.natural().min(1).max(128).required(), maxRequestHeaderBytes: bytes(),
  maxRequestBodyBytes: bytes(), maxQueuedRequests: positive(), queueTimeoutMs: positive(),
  response: z.object({ maxBodyBytes: bytes(), maxChunkBytes: bytes(), maxChunks: positive(),
    maxHeaderCount: z.natural().min(1).max(128).required(), maxHeaderBytes: bytes() }).required(),
  views: z.object({ maxViews: positive(), maxViewsPerAccount: positive(), maxRetainedBytes: positive(),
    maxFieldBytes: bytes(), lifetimeMs: z.natural().min(1000).max(2_147_483_647).required() }).required(),
})

function domain(value: string): boolean {
  return value.length <= 253 && value.includes('.') && value === value.toLowerCase()
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}
function below(value: string, parent: string): boolean { return value !== parent && value.endsWith('.' + parent) }

/**
 * Keep executable content outside the management Cookie domain and on an explicit same-scheme deployment suffix.
 * @param input Root-only service-content configuration.
 * @param access Already parsed original authentication/origin inputs.
 * @returns Detached validated configuration; it grants no listener, credential or service authority.
 */
export function parseServiceApplicationConfig(input: ServiceApplicationConfig, access: AccessConfig): ServiceApplicationConfig {
  try {
    const config = structuredClone(ServiceApplicationConfigSchema(input))
    const origin = new URL(config.origin), management = new URL(access.publicOrigin), authDomain = access.servicePreview?.cookieDomain
    if (origin.origin !== config.origin || origin.protocol !== management.protocol || !domain(config.siteDomain)
      || !domain(origin.hostname) || origin.hostname.length > 220 || !below(origin.hostname, config.siteDomain)
      || authDomain === undefined || !below(authDomain, config.siteDomain) || !below(management.hostname, authDomain)
      || origin.hostname === authDomain || below(origin.hostname, authDomain)
      || below(authDomain, origin.hostname)
      || access.deploymentMode === 'production' && origin.protocol !== 'https:'
      || access.deploymentMode === 'development' && origin.protocol === 'http:' && !below(config.siteDomain, 'localhost')
      || config.response.maxChunkBytes > config.response.maxBodyBytes + 1
      || config.maxPathBytes > config.maxUrlBytes || config.views.maxViewsPerAccount > config.views.maxViews) throw new TypeError()
    return config
  } catch (_error) { throw new TypeError('Cloud service applications require isolated explicit origins and finite limits.') }
}

/**
 * Build a public view origin, never an authentication URL or backend destination.
 * @param config Original parsed content-origin configuration.
 * @param id Non-secret Root-generated view id.
 * @returns Exact dedicated view origin; invalid ids reject without echoing their value.
 */
export function serviceApplicationOrigin(config: ServiceApplicationConfig, id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new TypeError('Invalid application preview identity.')
  const origin = new URL(config.origin)
  origin.hostname = id + '.' + origin.hostname
  return origin.origin
}
