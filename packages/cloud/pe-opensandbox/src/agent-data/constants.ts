/** Runtime pins and limits for one authenticated agent data carrier. */
import { RUNTIME_PROFILES } from '../bootstrap/runtime-profiles.ts'

/** Fixed core installation/service slice selected by Root's pinned payload; older payloads cannot satisfy it. */
export const PROTOCOL = 's6-stream/2-native-pipes-pty-v1' as const
/** Fixed private authentication header; its value is the original 64-hex token without a scheme prefix. */
export const AGENT_AUTH_HEADER = 'x-pe-execution-token' as const
/** Paired opt-in extension for settled foreground collect operation records. */
export const RECORD_SETTLEMENT_VERSION = 1 as const
/** One original active service can receive one bounded post-commit grant. */
export const SERVICE_WINDOW_VERSION = 1 as const
/** Opt-in collected operation/residence grants on the original protected connection. */
export const RESIDENCE_VERSION = 1 as const
export const RESIDENCE_LIMITS = Object.freeze({ maxMs: 900000, grants: 32, segmentMs: 600000,
  clockMarginMs: 250, minPollMs: 2000, terminalAttempts: 20, fixedControlBytes: 1024 })
/** Required frozen Python runtime source digest; never learned from a handshake response. */
export const AGENT_SOURCE_SHA256 = '9e1744674aa758c8b9b75e64c13aed36d46f90439b0949c96b22532cd3cf5bd5'
export const RENEWAL_AGENT_SOURCE_SHA256 = '12c3fbda33481dbaba289859315c3c069b8230b96dae6bc8233a6599bd3b2ddf'
/** Original ARM64 default; explicit platform carriers use their reviewed runtime profile. */
export const BWRAP_SHA256 = RUNTIME_PROFILES.arm64.bwrapSha256
/** Finite core slice: residence is absolute and the original four record slots stay bounded. */
export const SLICE_LIMITS = Object.freeze({ lifetimeOperations: 4, activeRanges: 2, tailBytesPerStream: 4096,
  observedStopThresholdPerStream: 65536, prepareMs: 3000, preparedLeaseMs: 3000, runMs: 150000,
  serviceRunMs: 120000, stopMs: 2000, residentMs: 300000, childCpuSeconds: 600, childAddressBytes: 17179869184,
  childFileBytes: 134217728, childOpenFiles: 256, childProcesses: 2048, childCoreBytes: 0 })

/** Full guest time needed to start an ordinary operation without retiring the original allocation. */
export const CONTINUATION_WINDOW_MS = SLICE_LIMITS.prepareMs + SLICE_LIMITS.runMs + SLICE_LIMITS.stopMs

/**
 * Check whether the provider's renewal period leaves time for another full operation.
 * @param seconds - Proposed provider lease duration after an active renewal.
 * @param createSeconds - Original provider lease duration at creation.
 * @param requestTimeoutMs - Local timeout for a provider renewal request.
 * @returns Whether the renewed lease covers the next full operation and the renewal margins.
 */
export function sustainedRenewalFits(seconds: number, createSeconds: number, requestTimeoutMs: number): boolean {
  return Number.isSafeInteger(seconds) && seconds > createSeconds && seconds <= 600
    && seconds * 500 > CONTINUATION_WINDOW_MS + requestTimeoutMs + 2 * RESIDENCE_LIMITS.clockMarginMs
}

/** The measured child limits of the exact bounded renewal guest, under the selected outer sandbox limits. */
export const RENEWAL_CHILD_LIMITS = Object.freeze({
  childCpuSeconds: 600, childAddressBytes: 17179869184, childOpenFiles: 256, childProcesses: 2048,
})
/** Fixed per-request and carrier ceilings. Reply allowance is charged independently of actual or retained reply bytes. */
export const CARRIER_LIMITS = Object.freeze({ body: 12288, reply: 16384, headers: 4096,
  concurrent: 4, httpConcurrent: 2, attempts: 640, sentBodyTotal: 352133, replyAllowanceTotal: 10485760,
  requestMs: 6000, localLifetimeMs: 300000, releaseMs: 2000 })
