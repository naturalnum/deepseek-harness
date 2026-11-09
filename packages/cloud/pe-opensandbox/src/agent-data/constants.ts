/** Runtime pins and limits for one authenticated agent data carrier. */
import { RUNTIME_PROFILES } from '../bootstrap/runtime-profiles.ts'

/** Fixed core installation/service slice selected by Root's pinned payload; older payloads cannot satisfy it. */
export const PROTOCOL = 's6-stream/2-native-pipes-pty-v1' as const
/** Fixed private authentication header; its value is the original 64-hex token without a scheme prefix. */
export const AGENT_AUTH_HEADER = 'x-pe-execution-token' as const
/** Required frozen Python runtime source digest; never learned from a handshake response. */
export const AGENT_SOURCE_SHA256 = '4d9f9ceb554d72662d61e70cc03faa936e3b495db235c69d01649cc4845093b5'
/** Original ARM64 default; explicit platform carriers use their reviewed runtime profile. */
export const BWRAP_SHA256 = RUNTIME_PROFILES.arm64.bwrapSha256
/** Finite core slice: residence is absolute; four records/300s do not qualify full S4 or promise four complete runs. */
export const SLICE_LIMITS = Object.freeze({ lifetimeOperations: 4, activeRanges: 2, tailBytesPerStream: 4096,
  observedStopThresholdPerStream: 65536, prepareMs: 3000, preparedLeaseMs: 3000, runMs: 150000,
  serviceRunMs: 120000, stopMs: 2000, residentMs: 300000, childCpuSeconds: 75, childAddressBytes: 536870912,
  childFileBytes: 67108864, childOpenFiles: 32, childProcesses: 32, childCoreBytes: 0 })
/** Fixed carrier limits. Reply allowance bounds lifetime traffic; it is neither retained bytes nor a process RSS limit. */
// Four prepare bodies + one required handshake + 635 maximum signed polls: 4*12288 + 86 + 635*477.
export const CARRIER_LIMITS = Object.freeze({ body: 12288, reply: 16384, headers: 4096,
  concurrent: 4, httpConcurrent: 2, attempts: 640, sentBodyTotal: 352133, replyAllowanceTotal: 10485760,
  requestMs: 6000, localLifetimeMs: 300000, releaseMs: 2000 })
