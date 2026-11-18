/** Exact opt-in group for the original Job Controller and Cloud bootstrap. */
import { CloudApiError } from './errors.ts'
import type { ExposureManifest } from './types.ts'

function endpoint<const Name extends string, const Mode extends 'rpc' | 'stream'>(method: Name, mode: Mode) {
  return Object.freeze({ endpoint: `job/${method}` as const, method, mode,
    handlerId: 'native:jobController' as const, guard: 'account-session' as const })
}

/** All three native Job methods form one reviewed Cloud capability. */
export const JOB_CONTROLLER_ENDPOINTS = Object.freeze([
  endpoint('kill', 'rpc'), endpoint('list', 'stream'), endpoint('follow', 'stream'),
] as const)

/**
 * Recognize the optional complete group, rejecting partial or differently scoped declarations.
 * @param manifest Exposure manifest for this deployment.
 * @returns Whether all three native job endpoints are selected.
 */
export function selectJobController(manifest: ExposureManifest): boolean {
  const rpc = manifest.rpcEndpoints.filter(row => row.endpoint.startsWith('job/'))
  const streams = manifest.streamEndpoints.filter(row => row.endpoint.startsWith('job/'))
  if (rpc.length === 0 && streams.length === 0) return false
  if (rpc.length !== 1 || streams.length !== 2 || !JOB_CONTROLLER_ENDPOINTS.every(expected =>
    (expected.mode === 'rpc' ? rpc : streams).some(row => row.endpoint === expected.endpoint
      && row.handlerId === expected.handlerId && row.guard === expected.guard))) {
    throw new CloudApiError('cloud/invalid-config', 'Job observation requires its complete exact native Session group.')
  }
  return true
}
