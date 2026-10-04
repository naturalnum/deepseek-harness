/** Operator-owned parser placement and budgets; browser requests cannot supply these settings. */
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { officePreviewLimits } from '@power-evolve/contracts/office-preview'
import type { OfficePreviewConfig } from './office-previews.ts'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timer = positive.max(2_147_483_647)
const absolutePath = z.string().min(1).refine(value => isAbsolute(value) && resolve(value) === value)
const resourceName = z.string().min(1).max(63).regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u)
const configuration = z.object({
  namespace: resourceName,
  image: z.string().max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/u),
  volumeClaimName: resourceName,
  volumeSubPath: z.string().min(1).max(1024).refine(value => value.split('/').every(part =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && part !== '.' && part !== '..')),
  localRoot: absolutePath,
  fontPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  limits: officePreviewLimits,
  maxConcurrentParsers: positive.max(2_147_483_647), maxRetainedJobsPerUser: positive,
  leaseMs: timer, jobDeadlineMs: timer, pollMs: timer,
  kubernetesTimeoutMs: timer, terminationGraceSeconds: z.number().int().nonnegative().max(2_147_483_647),
  cpuMilliCores: positive, memoryMiB: positive, temporaryMiB: positive,
}).strict()

/** Validated service settings and the explicitly configured reconciliation interval. */
export interface OfficePreviewDeployment extends OfficePreviewConfig {
  readonly pollMs: number
}

function overlaps(left: string, right: string): boolean {
  const part = relative(left, right)
  return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith('../')
}

/**
 * Load an optional private parser configuration before opening Platform resources.
 * Both filenames must be configured together; the preview root cannot overlap live protected files.
 * @param path Canonical absolute JSON filename, or empty when previews are disabled.
 * @param kubeconfigFile Canonical absolute Kubernetes credential filename, or the existing in-cluster provider.
 * @param protectedRoots Workspace, artifact, Home and Skill roots that the parser must never mount.
 * @param readText Trusted deployment text reader; errors never expose filenames or input bytes.
 * @returns Strict deployment settings, or null when both feature references are empty.
 */
export async function loadOfficePreviewConfig(path: string, kubeconfigFile: string,
  protectedRoots: readonly string[],
  readText: (filename: string) => Promise<string> = filename => readFile(filename, 'utf8')): Promise<OfficePreviewDeployment | null> {
  if (!path && !kubeconfigFile) return null
  try {
    absolutePath.parse(path)
    if (kubeconfigFile !== 'in-cluster') absolutePath.parse(kubeconfigFile)
    const settings = configuration.parse(JSON.parse(await readText(path)))
    if (settings.leaseMs < 2 * settings.kubernetesTimeoutMs || settings.pollMs >= settings.leaseMs
      || settings.jobDeadlineMs < settings.limits.timeoutMs) throw new Error('Invalid preview timing')
    for (const root of protectedRoots) {
      const canonicalRoot = resolve(root)
      if (overlaps(settings.localRoot, canonicalRoot) || overlaps(canonicalRoot, settings.localRoot)) {
        throw new Error('Preview root overlaps protected files')
      }
    }
    return settings
  } catch {
    throw new Error('Invalid Office preview platform configuration')
  }
}
