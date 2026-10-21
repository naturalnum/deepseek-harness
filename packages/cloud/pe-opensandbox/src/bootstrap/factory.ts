/** Root infrastructure assembly of the original fixed SDK bootstrap, authenticated registry and lifecycle owner. */
import { SdkAllocationBackend } from '../sdk-lifecycle.ts'
import { TrustedRuntimeRegistry } from '../trusted-runtime.ts'
import { createOwnedSdkTransport } from '../sdk-transport.ts'
import { BootstrapFailure, TrustedSdkBootstrap, type BootstrapConfig } from './bootstrap.ts'
import { loadPackagedBootstrapPayload } from './assets.ts'
import { createSelectedServerHttp } from '../application-http.ts'

/** Explicit Root-selected finite limits and private credentials; Loader JSON supplies no deployment authority. */
export type RootSdkBootstrapConfig = BootstrapConfig

/** Root owns allocation stop and backend.closeRoot; this object grants neither files exports nor account admission. */
export interface RootSdkExecutionOwner {
  readonly backend: SdkAllocationBackend
  readonly runtimes: TrustedRuntimeRegistry
  /** Recheck the original Root deployment lease before infrastructure use. */
  assertCurrent(): void
}

/**
 * Construct one Root-owned SDK composition from the installed package's pinned runtime payload.
 * @param config Original protected server selection, credentials, finite limits and deployment-current check.
 * @returns Original backend and registry; Root must stop allocations and join backend.closeRoot before releasing infrastructure.
 * @throws Before any HTTP request when assets or configuration fail validation. This does not authenticate a runtime or enable a recipe.
 */
export async function createRootSdkExecutionOwner(config: RootSdkBootstrapConfig): Promise<RootSdkExecutionOwner> {
  const payload = await loadPackagedBootstrapPayload()
  config.assertDeploymentCurrent()
  const bootstrap = new TrustedSdkBootstrap(config, payload)
  const lifecycleBaseUrl = config.lifecycle.lifecycleBaseUrl, apiKey = config.lifecycle.apiKey
  const runtimes = new TrustedRuntimeRegistry(bootstrap, config.maxRecords, bootstrap.createAgentDataClient,
    (target, limits, owner) => createSelectedServerHttp({ lifecycleBaseUrl, apiKey, limits,
      assertCurrent: () => { config.assertDeploymentCurrent() } }, target, owner))
  const transport = createOwnedSdkTransport(config.transport)
  try {
    const backend = new SdkAllocationBackend(config.lifecycle, runtimes, transport)
    return Object.freeze({ backend, runtimes, assertCurrent: () => { config.assertDeploymentCurrent() } })
  } catch (cause) {
    try { await transport.close() }
    catch (closeCause) {
      throw new BootstrapFailure('wire-unknown', Object.freeze({ kind: 'root-bootstrap-construction-cleanup', cause, closeCause, transport }))
    }
    throw cause
  }
}
