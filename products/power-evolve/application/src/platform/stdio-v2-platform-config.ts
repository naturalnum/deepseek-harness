/** Operator-only Cloud STDIO settings; connection JSON cannot supply deployment pins, budgets or approval keys. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { stdioCloudDeploymentV2, stdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioEnvironmentOptions } from '@power-evolve/contracts/stdio-environment'
import { stdioManagementLimitsV2 } from '@power-evolve/contracts/stdio-management'
import { stdioOperationAdmissionLimitsV2 } from '../stdio-v2-operation-contracts.ts'

const positive = z.number().int().positive()
const timer = positive.max(2_147_483_647)
const filePath = z.string().min(1).refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value))
const configuration = z.object({
  approvalKeyFile: filePath,
  environment: stdioEnvironmentOptions.optional(),
  limits: stdioLimitsV2,
  management: stdioManagementLimitsV2,
  admission: stdioOperationAdmissionLimitsV2,
  cloudDeployment: stdioCloudDeploymentV2,
  maxReplyBytes: positive,
  maxPendingPerUser: timer,
  maxCallsPerChain: timer,
  chainLifetimeMs: timer,
  approvalLifetimeMs: timer,
  worker: z.object({ pollMs: timer, renewMs: timer, leaseMs: timer, maxActive: timer, maxCandidates: timer }).strict()
    .refine(value => value.renewMs < value.leaseMs),
  transport: z.object({ requestTimeoutMs: timer, maxTrackedActions: positive }).strict(),
}).strict()

/** Explicit operator settings and separately resolved 32-byte approval key; parsing does not verify OCI manifest bytes. */
export interface StdioPlatformConfigV2 {
  settings: z.infer<typeof configuration>
  approvalKey: Uint8Array
}

/** Read all required Cloud budgets and the private hex key before enabling any STDIO entry point.
 * Runner configuration uses only settings.limits and settings.maxReplyBytes; other settings remain Platform-owned.
 * @param path Absolute configuration filename; only an empty string disables Cloud STDIO v2.
 * @param readText Trusted text reader for the configuration and its absolute approval-key path.
 * @returns Validated operator settings and key bytes, or null when disabled; failures omit filenames, input and key material.
 */
export async function loadStdioPlatformConfigV2(path: string,
  readText: (filename: string) => Promise<string> = filename => readFile(filename, 'utf8')): Promise<StdioPlatformConfigV2 | null> {
  if (path === '') return null
  try {
    filePath.parse(path)
    const settings = configuration.parse(JSON.parse(await readText(path)))
    const key = (await readText(settings.approvalKeyFile)).trim()
    if (!/^[a-f0-9]{64}$/iu.test(key)) throw new Error('Invalid approval key')
    return { settings, approvalKey: Uint8Array.from(Buffer.from(key, 'hex')) }
  } catch (_invalidConfiguration) {
    // Reader diagnostics, JSON inputs and private key bytes must not enter startup errors.
    throw new Error('Invalid STDIO v2 platform configuration')
  }
}
