/** Loader schema for the deployment's exact reviewed exposure policy. */
import z from '@deepseek-ai/schemastery'
import type { ConfigSaveLimits } from './save-hooks.ts'
import type { ExposureRootConfig, EndpointExposure, ExactFetchExposure } from './types.ts'
import { parseApprovedConfigurationCatalog } from './approved-catalog.ts'

const guard = z.union([
  z.const('authenticated-account'), z.const('account-project'),
  z.const('account-session'), z.const('account-attachment'),
]).required()
const endpoint = z.object({
  endpoint: z.string().required(),
  handlerId: z.string().required(),
  guard,
})

const positive = () => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()
const nonnegative = () => z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).required()

/** Explicit F06 limits for a runtime-owned shared coordinator. */
export const ConfigSaveLimitsSchema: z<ConfigSaveLimits> = z.object({
  maxAccounts: positive(),
  maxRunning: positive(),
  maxQueued: nonnegative(),
  maxQueuedPerAccount: nonnegative(),
  maxTrackedOperations: positive(),
  maxTrackedOperationsPerAccount: positive(),
  maxNestedPerOperation: positive(),
  maxWaitersPerAccount: positive(),
})

interface ManifestInput {
  recipeVersion: string
  rpcEndpoints: EndpointExposure[]
  streamEndpoints: EndpointExposure[]
  exactFetchRoutes: ExactFetchExposure[]
  allowedSettings: Array<{ namespace: string; fields: string[] }>
}
interface RootInput extends ManifestInput { approvedConfiguration?: unknown }

/** Required manifest fields; canonical names and duplicates are checked during policy construction. */
export const ExposureManifestSchema: z<ManifestInput> = z.object({
  recipeVersion: z.string().required(),
  rpcEndpoints: z.array(endpoint).required(),
  streamEndpoints: z.array(endpoint).required(),
  exactFetchRoutes: z.array(z.object({
    method: z.string().required(), path: z.string().required(),
    handlerId: z.string().required(), guard,
  })).required(),
  allowedSettings: z.array(z.object({
    namespace: z.string().required(),
    fields: z.array(z.string()).required(),
  })).required(),
})

const rootFields: z<RootInput> = z.intersect([
  ExposureManifestSchema,
  z.object({ approvedConfiguration: z.any<unknown>().default(undefined as never) }),
])

/** Optional explicit Root catalog, bounded and canonical before the original owner retains it. */
export const ExposureRootConfigSchema = z.transform(rootFields, (input): ExposureRootConfig => {
  const approved = parseApprovedConfigurationCatalog(
    input.approvedConfiguration, input.recipeVersion, input.allowedSettings.length === 0,
  )
  const { approvedConfiguration: _raw, ...manifest } = input
  return approved === undefined ? manifest : { ...manifest, approvedConfiguration: approved }
})
