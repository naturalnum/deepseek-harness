/** Account capability contributions checked against the original Gateway and live Cordis owner. */
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { remoteMethods, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CloudApiError } from './errors.ts'
import { inventoryMethodMatches } from './inventory-method.ts'
import type { EndpointExposure, ExposureInventory } from './types.ts'

interface Contribution {
  readonly owner: Context
  service?: object
  readonly inspect: () => ExposureInventory
}

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The account capability has no current native implementation.')
}

/** Owns only reversible inventory registrations; services, transport and authorization retain their original owners. */
export class AccountCapabilityInventories {
  private readonly contributions = new Map<string, Contribution>()

  /**
   * @param recipeVersion Actual account deployment.
   * @param maximum Shared native inventory bound.
   * @param invalidate Original exposure revocation.
   */
  constructor(private readonly recipeVersion: string, private readonly maximum: number,
    private readonly invalidate: () => void) {}

  /**
   * Retain the registering fiber; its first audit captures the active Remote service without opening an endpoint.
   * @param owner Original caller in the account graph.
   * @param namespace Exact service key and wire namespace.
   * @param inspect Contribution's current operation inventory; the Gateway independently verifies every method.
   * @returns Cordis disposer which removes the contribution and revokes the preceding audit.
   */
  register(owner: Context, namespace: string, inspect: () => ExposureInventory): () => void {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(namespace) || this.contributions.has(namespace)
      || !Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.contributions.size >= this.maximum) unavailable()
    const entry: Contribution = { owner, inspect }
    return owner.effect(() => {
      this.contributions.set(namespace, entry)
      this.invalidate()
      return () => {
        if (this.contributions.get(namespace) === entry) this.contributions.delete(namespace)
        this.invalidate()
      }
    }, 'pe-cloud-api: retain account capability inventory')
  }

  /**
   * Resolve every contribution through the same Gateway used by real calls.
   * @param account Original account graph.
   * @returns Checked RPC and stream rows; contributions cannot add shared Fetch routes.
   */
  inspect(account: Context): ExposureInventory {
    const rpcEndpoints: EndpointExposure[] = [], streamEndpoints: EndpointExposure[] = []
    for (const [namespace, entry] of this.contributions) {
      const value = this.inspectOne(account, namespace, entry)
      rpcEndpoints.push(...value.rpcEndpoints); streamEndpoints.push(...value.streamEndpoints)
      if (rpcEndpoints.length + streamEndpoints.length > this.maximum) unavailable()
    }
    return { recipeVersion: this.recipeVersion, rpcEndpoints, streamEndpoints, exactFetchRoutes: [] }
  }

  /** Recheck a selected contribution immediately before ordinary dispatch.
   * @param account Original account graph. @param row Already approved exact exposure. @param mode Actual carrier mode. */
  assertEndpoint(account: Context, row: EndpointExposure, mode: 'rpc' | 'stream'): void {
    const namespace = row.endpoint.split('/')[0]
    const entry = namespace === undefined ? undefined : this.contributions.get(namespace)
    if (entry === undefined || namespace === undefined) return
    const value = this.inspectOne(account, namespace, entry)
    const rows = mode === 'rpc' ? value.rpcEndpoints : value.streamEndpoints
    if (!rows.some(actual => actual.endpoint === row.endpoint && actual.handlerId === row.handlerId
      && actual.guard === row.guard)) unavailable()
  }

  private inspectOne(account: Context, namespace: string, entry: Contribution): ExposureInventory {
    if (entry.owner.root !== account.root || entry.owner.fiber.state !== FiberState.ACTIVE) unavailable()
    const service = account.get(namespace), registration = entry.owner.fiber.store?.[namespace]
    if (!(service instanceof TypertRemoteService) || service.typertRemote.namespace !== namespace
      || service.typertRemote.serviceKey !== namespace || registration?.fiber !== entry.owner.fiber
      || original(account.root.get(namespace) ?? {}) !== original(service)
      || original(registration.value) !== original(service)) unavailable()
    if (entry.service === undefined) entry.service = service
    else if (original(entry.service) !== original(service)) unavailable()
    const gateway = account.get('typertGateway')
    if (!(gateway instanceof Gateway)) unavailable()
    const value = entry.inspect()
    if (value.recipeVersion !== this.recipeVersion || value.exactFetchRoutes.length !== 0
      || value.rpcEndpoints.length + value.streamEndpoints.length > this.maximum) unavailable()
    const markers = remoteMethods(service), seen = new Set<string>()
    for (const [rows, mode] of [[value.rpcEndpoints, 'rpc'], [value.streamEndpoints, 'stream']] as const) {
      for (const row of rows) {
        const method = row.endpoint.slice(namespace.length + 1)
        const marker = markers.find(candidate => candidate.method === method && (candidate.exportName ?? candidate.method) === method)
        if (!row.endpoint.startsWith(namespace + '/') || !/^[A-Za-z][A-Za-z0-9_]*$/.test(method)
          || seen.has(row.endpoint) || row.handlerId !== 'native:' + namespace || marker === undefined
          || (marker.mode ?? 'rpc') !== mode) unavailable()
        seen.add(row.endpoint)
        const descriptor = gateway.inspectInvocation(namespace, method)
        if (!inventoryMethodMatches(row, mode, descriptor)) unavailable()
        if (row.guard === 'account-session' && marker.resources?.['session'] === undefined
          && !descriptor.parameters.some(parameter => parameter.source === 'lookup' && parameter.lookup === 'session')) unavailable()
      }
    }
    return value
  }
}
