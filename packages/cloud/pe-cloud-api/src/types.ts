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

/** One fixed installed plugin's approved public controls and server-only inventory mapping. */
export interface ApprovedConfigurationPlugin {
  readonly id: string
  readonly entryId: string
  readonly moduleName: string
  readonly packageName: string
  readonly packageVersion: string
  readonly installable: false
  readonly toggleable: false
}

/** Immutable first-trial deployment catalog; actual account inventory must still be checked on every projection. */
export interface ApprovedConfigurationCatalog {
  readonly recipeVersion: string
  readonly catalogVersion: string
  readonly maxEntries: number
  readonly maxStringBytes: number
  readonly maxCatalogBytes: number
  readonly plugins: readonly ApprovedConfigurationPlugin[]
  readonly skills: Readonly<{ mode: 'closed' }>
  readonly credentials: Readonly<{ mode: 'read-only' }>
  readonly fields: readonly never[]
}

/** Root exposure plus optional explicit catalog; omission cannot produce successful configuration metadata. */
export interface ExposureRootConfig extends ExposureManifest {
  readonly rpcEndpoints: EndpointExposure[]
  readonly streamEndpoints: EndpointExposure[]
  readonly exactFetchRoutes: ExactFetchExposure[]
  readonly allowedSettings: Array<{ readonly namespace: string; readonly fields: string[] }>
  readonly approvedConfiguration?: ApprovedConfigurationCatalog
}
