/** Immutable exact matching and native inventory audit for C-04. */
import { CloudApiError } from './errors.ts'
import type {
  EndpointExposure, ExactFetchExposure, ExposureInventory, ExposureManifest, SettingsExposure,
} from './types.ts'

function invalid(message: string): never {
  throw new CloudApiError('cloud/invalid-config', message)
}

function unique<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const id = key(row)
    if (result.has(id)) invalid('Exposure declarations must be unique.')
    result.set(id, row)
  }
  return result
}

function endpointName(value: string): boolean {
  return value.length > 0 && value.split('/').every(part =>
    part !== '.' && part !== '..' && /^[A-Za-z0-9_$.-]+$/.test(part))
}

function handler(value: string): void {
  if (!/^[A-Za-z0-9_./:-]+$/.test(value)) invalid('Exposure handler identity must be explicit.')
}

function fetchPath(value: string): boolean {
  if (value === '/connect') return false
  if (!value.startsWith('/') || value.includes('\\') || /[%?#*\u0000-\u0020]/.test(value)) return false
  const parts = value.slice(1).split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

function endpointCopy(row: EndpointExposure): EndpointExposure {
  if (!endpointName(row.endpoint)) invalid('Exposure endpoint must be canonical and exact.')
  handler(row.handlerId)
  return Object.freeze({ endpoint: row.endpoint, handlerId: row.handlerId, guard: row.guard })
}

function fetchCopy(row: ExactFetchExposure): ExactFetchExposure {
  if (!/^[A-Z]+$/.test(row.method) || !fetchPath(row.path)) {
    invalid('Fetch exposure requires an exact uppercase method and canonical pathname.')
  }
  handler(row.handlerId)
  return Object.freeze({ method: row.method, path: row.path, handlerId: row.handlerId, guard: row.guard })
}

function settingsCopy(row: SettingsExposure): SettingsExposure {
  if (!endpointName(row.namespace) || row.namespace.includes('/')) invalid('Settings namespace must be exact.')
  if (row.fields.some(field => !field.split('.').every(part => /^[A-Za-z0-9_$-]+$/.test(part)))) {
    invalid('Settings fields must be explicit paths.')
  }
  unique(row.fields, field => field)
  return Object.freeze({ namespace: row.namespace, fields: Object.freeze([...row.fields]) })
}

/** A root policy remains unusable until its inventory has been audited. */
export class ExposurePolicy {
  /** Frozen deployment declarations; admission still requires a successful inventory audit. */
  readonly manifest: ExposureManifest
  private readonly rpc: ReadonlyMap<string, EndpointExposure>
  private readonly streams: ReadonlyMap<string, EndpointExposure>
  private readonly fetch: ReadonlyMap<string, ExactFetchExposure>
  private readonly settings: ReadonlyMap<string, SettingsExposure>
  private audited = false

  /**
   * @param input - deployment-owned configuration at the Loader parsing boundary.
   */
  constructor(input: ExposureManifest) {
    if (input.recipeVersion.trim().length === 0) invalid('Exposure recipeVersion is required.')
    this.manifest = Object.freeze({
      recipeVersion: input.recipeVersion,
      rpcEndpoints: Object.freeze(input.rpcEndpoints.map(endpointCopy)),
      streamEndpoints: Object.freeze(input.streamEndpoints.map(endpointCopy)),
      exactFetchRoutes: Object.freeze(input.exactFetchRoutes.map(fetchCopy)),
      allowedSettings: Object.freeze(input.allowedSettings.map(settingsCopy)),
    })
    this.rpc = unique(this.manifest.rpcEndpoints, row => row.endpoint)
    this.streams = unique(this.manifest.streamEndpoints, row => row.endpoint)
    for (const name of this.rpc.keys()) {
      if (this.streams.has(name)) invalid('An endpoint cannot be both unary and streaming.')
    }
    this.fetch = unique(this.manifest.exactFetchRoutes, row => row.method + ' ' + row.path)
    for (const name of this.rpc.keys()) {
      if (this.fetch.has('POST /api/' + name)) invalid('A Fetch route cannot shadow a reviewed native RPC.')
    }
    this.settings = unique(this.manifest.allowedSettings, row => row.namespace)
  }

  /**
   * Audit configured entries against actual mounted native handlers. Extra native
   * entries stay denied; failure revokes a prior successful audit.
   * @param inventory - native adapter's actual mounted declarations.
   */
  audit(inventory: ExposureInventory): void {
    this.audited = false
    if (inventory.recipeVersion !== this.manifest.recipeVersion) invalid('Exposure recipe versions differ.')
    const rpc = unique(inventory.rpcEndpoints, row => row.endpoint)
    const streams = unique(inventory.streamEndpoints, row => row.endpoint)
    const fetch = unique(inventory.exactFetchRoutes, row => row.method + ' ' + row.path)
    for (const [expected, actual] of [
      [this.rpc, rpc], [this.streams, streams], [this.fetch, fetch],
    ] as const) {
      for (const [id, entry] of expected) {
        const mounted = actual.get(id)
        if (mounted === undefined || mounted.handlerId !== entry.handlerId || mounted.guard !== entry.guard) {
          invalid('A reviewed exposure has no matching mounted handler and guard.')
        }
      }
    }
    this.audited = true
  }

  /** Revoke the inventory audit when its owning composition is disposed or changed. */
  invalidate(): void {
    this.audited = false
  }

  /**
   * Require an audited, explicitly exposed native RPC endpoint.
   * @param endpoint - native endpoint read from the HTTP URL.
   * @returns its exact reviewed RPC declaration.
   */
  requireRpc(endpoint: string): EndpointExposure {
    return this.require(this.rpc.get(endpoint))
  }

  /**
   * Require an audited, explicitly exposed native logical stream endpoint.
   * @param endpoint - native logical-stream endpoint at each mux open.
   * @returns its exact reviewed stream declaration.
   */
  requireStream(endpoint: string): EndpointExposure {
    return this.require(this.streams.get(endpoint))
  }

  /**
   * Require an audited Fetch route matching the exact method and pathname.
   * @param method - original request method.
   * @param pathname - original parsed URL pathname, without decoding.
   * @returns its exact reviewed Fetch declaration.
   */
  requireFetch(method: string, pathname: string): ExactFetchExposure {
    return this.require(this.fetch.get(method + ' ' + pathname))
  }

  /**
   * Require every changed field, including all replacement/deletion paths.
   * @param namespace - exact native settings namespace.
   * @param fields - complete effective changed paths, supplied by native preflight.
   */
  assertSettingsFields(namespace: string, fields: readonly string[]): void {
    const allowed = this.require(this.settings.get(namespace))
    if (fields.some(field => !allowed.fields.includes(field))) this.deny()
  }

  private require<T>(entry: T | undefined): T {
    if (!this.audited) throw new CloudApiError('cloud/account-unavailable', 'Exposure inventory has not been audited.')
    if (entry === undefined) this.deny()
    return entry
  }

  private deny(): never {
    throw new CloudApiError('cloud/forbidden', 'The operation is not exposed by this recipe.')
  }
}
