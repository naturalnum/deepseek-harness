/** API-owned exposure declarations; native Session and Remote DTOs stay in DSH. */
export type * from './save-hooks.ts'

/** Resource verifier selected by each reviewed entry. */
export type ExposureGuard = 'authenticated-account' | 'account-project' | 'account-session' | 'account-attachment'

/** One exact native RPC or logical-stream declaration. */
export interface EndpointExposure {
  readonly endpoint: string
  readonly handlerId: string
  readonly guard: ExposureGuard
}

/** One exact Fetch route; method and pathname must both match. */
export interface ExactFetchExposure {
  readonly method: string
  readonly path: string
  readonly handlerId: string
  readonly guard: ExposureGuard
}

/** Deployment-reviewed settings namespace and exact writable field paths. */
export interface SettingsExposure {
  readonly namespace: string
  readonly fields: readonly string[]
}

/** Deployment policy, distinct from any account's enabled capabilities. */
export interface ExposureManifest {
  readonly recipeVersion: string
  readonly rpcEndpoints: readonly EndpointExposure[]
  readonly streamEndpoints: readonly EndpointExposure[]
  readonly exactFetchRoutes: readonly ExactFetchExposure[]
  readonly allowedSettings: readonly SettingsExposure[]
}

/** Actual mounted declarations supplied by the native transport adapter. */
export interface ExposureInventory {
  readonly recipeVersion: string
  readonly rpcEndpoints: readonly EndpointExposure[]
  readonly streamEndpoints: readonly EndpointExposure[]
  readonly exactFetchRoutes: readonly ExactFetchExposure[]
}
