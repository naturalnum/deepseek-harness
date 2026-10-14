/** Explicit Platform deployment inputs for shared native execution providers. */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const positive = z.number().int().positive().max(2_147_483_647)
const absolute = z.string().min(1).max(4096).refine(path => path.startsWith('/') && !path.includes('\0'))
const name = z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u).max(63)
const relative = z.string().min(1).max(4096).refine(path => !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
/** Every deployment-varying limit and storage address is explicit; no fallback can silently widen authority. */
export const nativeExecutionConfig = z.object({
  broker: z.object({ kubectlExecutable: absolute, kubeconfigPath: absolute, fsWorkerPath: absolute, processWorkerPath: absolute,
    maxRequestBytes: positive, maxReplyBytes: positive, maxProcessMs: positive, authorityPollMs: positive,
    transportGraceMs: positive }).strict(),
  pods: z.object({ namespace: name, runtimeClassName: name, image: z.string().min(1).max(2048).regex(/@sha256:[a-f0-9]{64}$/u),
    storageVolumeClaim: name, storageVolumePrefix: relative, homeVolumePrefix: relative, homeLocalRoot: absolute,
    tmpVolumePrefix: relative, tmpLocalRoot: absolute,
    nodeName: z.string().min(1).max(253).optional(), cpu: z.string().regex(/^\d+(?:m)?$/u),
    memory: z.string().regex(/^\d+(?:[KMGTPE]i)?$/u), pollMs: positive, readyTimeoutMs: positive,
    stopTimeoutMs: positive, maxPodSeconds: positive, maxRecoveryRows: positive }).strict(),
  routes: z.object({ maxLiveHandles: positive, maxOutputBytes: positive }).strict(),
}).strict()
/** Validated Platform execution deployment configuration. */
export type NativeExecutionConfig = z.infer<typeof nativeExecutionConfig>

/** Load the private execution deployment file before starting any provider.
 * @param path Private JSON configuration path.
 * @returns Complete validated broker, Pod and route configuration.
 */
export async function loadNativeExecutionConfig(path: string): Promise<NativeExecutionConfig> {
  return nativeExecutionConfig.parse(JSON.parse(await readFile(path, 'utf8')))
}
