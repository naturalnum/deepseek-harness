/** Config parsing for bounded local runtime capacity; production graph evidence is separate. */
import z from '@deepseek-ai/schemastery'
import type { RuntimeConfig } from './types.ts'

/** Required positive finite safe-integer capacities; no deployment defaults are inferred. */
export const RuntimeConfigSchema: z<RuntimeConfig> = z.object({
  maxMountedAccounts: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxConcurrentMounts: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxConcurrentDrains: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).required(),
})

export { RuntimeRootConfigSchema } from './root-config.ts'
