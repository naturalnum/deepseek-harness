/** Runtime pins and limits for one authenticated agent data carrier. */
/** Fixed core installation/service slice selected by Root's pinned payload; older payloads cannot satisfy it. */
export const PROTOCOL = 's4-collect/9-install-service-v1' as const
/** Fixed private authentication header; its value is the original 64-hex token without a scheme prefix. */
export const AGENT_AUTH_HEADER = 'x-pe-execution-token' as const
/** Required frozen Python runtime source digest; never learned from a handshake response. */
export const AGENT_SOURCE_SHA256 = 'cc55d7cb7d61a9bc74569c1f980830bc52fa150f26eecccf0adb7bce37e6abd0'
/** Required fixed bwrap binary digest verified by the Python owner. */
export const BWRAP_SHA256 = '0fc274e60c4b606db202dc9e82db60b4d944ba74bab8b6af2cd95ea28c4f8b2d'
/** Finite core slice: residence is absolute; four records/300s do not qualify full S4 or promise four complete runs. */
export const SLICE_LIMITS = Object.freeze({ lifetimeOperations: 4, activeRanges: 2, tailBytesPerStream: 4096,
  observedStopThresholdPerStream: 65536, prepareMs: 3000, preparedLeaseMs: 3000, runMs: 150000,
  serviceRunMs: 120000, stopMs: 2000, residentMs: 300000, childCpuSeconds: 75, childAddressBytes: 134217728,
  childFileBytes: 8388608, childOpenFiles: 32, childProcesses: 32, childCoreBytes: 0 })
/** Fixed carrier limits. Reply allowance bounds lifetime traffic; it is neither retained bytes nor a process RSS limit. */
// Four prepare bodies + one required handshake + 635 maximum signed polls: 4*12288 + 86 + 635*477.
export const CARRIER_LIMITS = Object.freeze({ body: 12288, reply: 16384, headers: 4096,
  concurrent: 4, attempts: 640, sentBodyTotal: 352133, replyAllowanceTotal: 10485760,
  requestMs: 6000, localLifetimeMs: 300000, releaseMs: 2000 })
