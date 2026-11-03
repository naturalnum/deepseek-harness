/** Strict Root policy for the optional cloud remote-server integration. */
import { PROBE_SCRIPT } from '@deepseek-ai/dsh-remote-server-cloud'
import { z } from 'zod'
import type { RemoteStoreLimits } from '@deepseek-ai/dsh-pe-cloud-files'
import type { RemoteSshConfig } from '@deepseek-ai/dsh-pe-opensandbox'

/** Root-selected bounds and readonly workload-image executables; carries no credentials or account selector. */
export interface ApprovedRemoteServers {
  readonly limits: RemoteStoreLimits & { readonly maxRequestBytes: number; readonly maxReplyBytes: number; readonly maxImportBytes: number }
  readonly execution: RemoteSshConfig
}
/** Validate and detach the optional deployment policy.
 * @param input Root Loader JSON.
 * @returns Finite immutable remote-server policy.
 */
export function remoteServerPolicy(input: unknown): ApprovedRemoteServers {
  const positive = z.number().int().min(1).max(65536)
  const limits = z.strictObject({ maxServers: positive.max(64), maxCommandBytes: positive.max(4096),
    maxPrivateKeyBytes: positive.max(4096), maxKnownHostsBytes: positive.max(4096), alwaysAsk: z.boolean(),
    readOnlyAllowlist: z.array(z.string().min(1).max(64)).max(64), maxRequestBytes: positive,
    maxReplyBytes: z.number().int().min(1).max(1048576), maxImportBytes: positive })
  const execution = z.strictObject({ pythonPath: z.enum(['/usr/local/bin/python3', '/usr/bin/python3']),
    sshPath: z.literal('/usr/bin/ssh'), timeoutMs: z.number().int().min(1).max(150000),
    probeTimeoutMs: z.number().int().min(1).max(150000), connectTimeoutSeconds: positive.max(60),
    outputMaxBytes: positive, stopWaitMs: positive.max(2000) })
  const value = z.strictObject({ limits, execution }).parse(input)
  if (value.limits.maxCommandBytes < Buffer.byteLength(PROBE_SCRIPT)) throw new Error('cloud/invalid-remote-probe-budget')
  if (value.limits.maxReplyBytes < 12 * value.execution.outputMaxBytes + 4096) throw new Error('cloud/invalid-remote-reply-budget')
  return Object.freeze({ limits: Object.freeze({ ...value.limits, readOnlyAllowlist: Object.freeze(value.limits.readOnlyAllowlist) }),
    execution: Object.freeze(value.execution) })
}
