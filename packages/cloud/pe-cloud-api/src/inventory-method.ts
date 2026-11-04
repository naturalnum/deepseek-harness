/** Exact implementation identity comparison for the original mounted account inventory. */
import type { Context } from '@deepseek-ai/cordis'
import type { EndpointExposure } from './types.ts'

type Descriptor = NonNullable<ReturnType<Context['typert']['local']['get']>>

/**
 * Match one inspected endpoint to its actual Typert implementation.
 * @param row Actual installed inventory row, independently audited by its provider.
 * @param mode Original registry iteration mode.
 * @param descriptor Actual registered Typert method description.
 * @returns Whether the original Native relation or the sole approved Cloud management tuple matches.
 */
export function inventoryMethodMatches(row: EndpointExposure, mode: 'rpc' | 'stream', descriptor: Descriptor): boolean {
  const service = row.handlerId.startsWith('native:') ? row.handlerId.slice('native:'.length)
    : mode === 'rpc' && row.endpoint === 'cloudRemoteServers/action' && row.handlerId === 'cloud:remote-servers'
      && row.guard === 'authenticated-account' ? 'cloudRemoteServers' : undefined
  if (service === undefined) return false
  const separator = row.endpoint.indexOf('/'), namespace = row.endpoint.slice(0, separator)
  const method = row.endpoint.slice(separator + 1)
  return descriptor.service === service && descriptor.namespace === namespace && descriptor.method === method
    && (descriptor.implementation ?? descriptor.method) === method && (descriptor.mode ?? 'rpc') === mode
}
