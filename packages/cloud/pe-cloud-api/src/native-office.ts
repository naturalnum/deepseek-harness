/** Native Office provider identity and bounded Remote declaration audit. */
import { nativeOriginal, nativeAccountFibers } from './native-inventory.ts'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import OfficeKit, {
  OfficeKitError, type Config as NativeOfficeConfig, type OfficeKitRequest, type OfficeKitResult,
  type OfficeImagesRequest, type OfficeImagesResult, type OfficeConversionRequest,
  type OfficeRecalculationRequest, type OfficeFileResult,
} from '@deepseek-ai/dsh-office-kit'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { CloudApiError } from './errors.ts'
import type { ExposureInventory } from './types.ts'
import { OfficeWork } from './office-work.ts'

/** Private installation and drain capability handed to the account factory. */
export interface AccountOfficeLifecycle {
  /** Install the native PDF renderer with account-owned call observation.
   * @param owner Original account Loader scope.
   * @param config Resolved native conversion limits.
   */
  install(owner: Context, config: NativeOfficeConfig): void
  /** Close admission and finitely join conversions before original account disposal.
   * @param deadlineAtMs Existing account shutdown deadline.
   * @returns Confirmation of retained conversions; the factory must still confirm original Context disposal.
   */
  stop(deadlineAtMs: number): Promise<void>
  /** @returns Whether the account owns no admitted conversion or unknown Office cleanup. */
  isIdle(): boolean
}

/** Exact native provider and its original account-graph admission. */
export interface NativeOffice {
  /** The original provider registered by its Loader fiber. */
  readonly value: OfficeKit
  /** Recheck the retained provider and its file dependencies. */
  assertCurrent(): void
  /** Audit the original Remote methods and admission declarations. */
  inspect(): ExposureInventory
  /** @param deadlineAtMs Account shutdown deadline. @returns Retained shutdown observation. */
  stop(deadlineAtMs: number): Promise<void>
  /** @returns Whether Office has neither admitted work nor unknown cleanup. */
  isIdle(): boolean
}

function knownConversionFailure(cause: unknown): boolean {
  return cause instanceof OfficeKitError && cause.code !== 'failed' && cause.code !== 'unavailable'
}

function original(value: object | undefined): object | undefined {
  if (value === undefined) return undefined
  const target: unknown = nativeOriginal(value)
  return target !== null && typeof target === 'object' ? target : value
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original Office provider is unavailable.')
}

/** Install and retain the native conversion owner in the account's existing filesystem graph.
 * @param ctx Original account Loader fiber.
 * @param binding Original account graph identity.
 * @param current Existing unpublished and installed-graph guard.
 * @param maximum Bound for native registry inspection.
 * @param config Native provider configuration.
 * @param admit Original business admission before a new conversion, separate from installation auditing.
 * @returns Original service and exact Remote inventory audit.
 */
export function createNativeOffice(ctx: Context, binding: AccountBinding, current: () => void, maximum: number,
  config: NativeOfficeConfig, admit: () => void): NativeOffice {
  current()
  if (!Number.isSafeInteger(maximum) || maximum < 1) unavailable()
  if (ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding || binding.lifetime.aborted
    || ctx.get('officeKit') !== undefined || ctx.root.get('officeKit') !== undefined) unavailable()
  const fs = ctx.get('fs'), files = ctx.get('workspaceFiles')
  if (fs === undefined || files === undefined || ctx.root.get('fs') === undefined || ctx.root.get('workspaceFiles') === undefined
    || original(fs) !== original(ctx.root.get('fs')) || original(files) !== original(ctx.root.get('workspaceFiles'))) unavailable()
  const root = ctx.root, fiber = ctx.fiber
  let checkConversion: () => void = unavailable
  const work = new OfficeWork(config.maxReaders, () => { checkConversion(); admit() }, () => {
    if (fiber.state !== FiberState.ACTIVE || root.fiber.state !== FiberState.ACTIVE) {
      work.cleanupFailed(new Error('Office owner was withdrawn before ordered shutdown.'), 'owner-unloaded')
    }
    // The original account Context owns provider disposal and its independent error observation.
    return Promise.resolve()
  }, knownConversionFailure, (phase) => {
    try {
      console.error(JSON.stringify({ event: 'cloud-office-cleanup-unconfirmed', phase,
        providerState: fiber.state, accountRootState: root.fiber.state }))
    } catch (_diagnosticFailure) { /* Closing diagnostics never change the retained failure. */ }
    root.logger.error('Office cleanup is unconfirmed; conversion admission is closed and account resources remain retained.')
  })
  const removeObserver = root.logger.exporter({ levels: { default: 0 }, export: (message) => {
    if (message.type === 'error' && message.fiber?.deref() === fiber) work.cleanupFailed(message)
  } })
  // Keep the real native reader until conversion and its finally cleanup settle.
  class AccountOffice extends OfficeKit {
    override async renderImages(_request: OfficeImagesRequest, _signal?: AbortSignal): Promise<OfficeImagesResult> {
      throw new CloudApiError('cloud/forbidden', 'The account Office provider supports PDF preview only.')
    }
    override async convertTo(_request: OfficeConversionRequest, _signal?: AbortSignal): Promise<OfficeFileResult> {
      throw new CloudApiError('cloud/forbidden', 'The account Office provider supports PDF preview only.')
    }
    override async recalculate(_request: OfficeRecalculationRequest, _signal?: AbortSignal): Promise<OfficeFileResult> {
      throw new CloudApiError('cloud/forbidden', 'The account Office provider supports PDF preview only.')
    }
    override convert(request: OfficeKitRequest, signal?: AbortSignal): Promise<OfficeKitResult> {
      let sourceFailure: { readonly cause: unknown } | undefined
      const retained = { ...request, source: { ...request.source,
        read: async (upstream: AbortSignal, bytes: number) => {
          try { return await request.source.read(upstream, bytes) }
          catch (cause) { sourceFailure = { cause }; throw cause }
        } } }
      const ownerActive = (): void => {
        if (fiber.state !== FiberState.ACTIVE || root.fiber.state !== FiberState.ACTIVE) {
          work.cleanupFailed(new Error('Office owner was unloaded during an admitted conversion.'), 'owner-unloaded')
        }
      }
      return work.run(() => super.convert(retained).then((result) => { ownerActive(); return result }, (cause: unknown) => {
        ownerActive(); throw cause
      }), signal,
      cause => sourceFailure !== undefined && cause === sourceFailure.cause || knownConversionFailure(cause))
    }
  }
  let value: OfficeKit
  const outputOwner = createHash('sha256').update(JSON.stringify([binding.accountId, binding.epoch])).digest('hex')
  const providerConfig = { ...config, outputDirectory: join(config.outputDirectory, `cloud-${outputOwner}`) }
  try { value = new AccountOffice(ctx, providerConfig) }
  catch (cause) {
    void Promise.resolve(removeObserver()).catch((failure: unknown) => { work.cleanupFailed(failure) })
    throw cause
  }
  ctx.effect(() => () => { work.ownerUnloaded() }, 'pe-cloud-api: Office owner withdrawal')
  const registrations = new Map<string, { value: object; fiber: Fiber }>()
  const scan = (): void => {
    let remaining = maximum
    const found = new Map<string, { value: object; fiber: Fiber }>()
    for (const fiber of nativeAccountFibers(ctx, () => { if (--remaining < 0) unavailable() })) {
      if (fiber.ctx.root !== ctx.root || fiber.state !== FiberState.ACTIVE) continue
      for (const entry of fiber.provisions) {
        if (--remaining < 0) unavailable()
        const key = entry.name, installed: unknown = entry.value
        if (entry.ctx.fiber !== fiber || (key !== 'fs' && key !== 'workspaceFiles' && key !== 'officeKit')) continue
        if (installed === null || typeof installed !== 'object' || found.has(key)) unavailable()
        const unwrapped = original(installed)
        if (unwrapped === undefined) unavailable()
        found.set(key, { value: unwrapped, fiber })
      }
    }
    for (const [key, expected] of [['fs', fs], ['workspaceFiles', files], ['officeKit', value]] as const) {
      const actual = found.get(key), retained = registrations.get(key)
      if (actual === undefined || actual.value !== original(expected)
        || retained !== undefined && (retained.value !== actual.value || retained.fiber !== actual.fiber)) unavailable()
      registrations.set(key, actual)
    }
  }
  const assertCurrent = (): void => {
    current()
    if (ctx.fiber.state !== FiberState.ACTIVE || binding.lifetime.aborted || ctx.get('peAccount') !== binding
      || ctx.root.get('peAccount') !== binding || ctx.get('officeKit') === undefined || ctx.root.get('officeKit') === undefined
      || original(ctx.get('officeKit')) !== original(value) || original(ctx.root.get('officeKit')) !== original(value)
      || ctx.get('fs') === undefined || ctx.root.get('fs') === undefined || original(ctx.get('fs')) !== original(fs)
      || original(ctx.root.get('fs')) !== original(fs) || ctx.get('workspaceFiles') === undefined
      || ctx.root.get('workspaceFiles') === undefined || original(ctx.get('workspaceFiles')) !== original(files)
      || original(ctx.root.get('workspaceFiles')) !== original(files)) unavailable()
    scan()
  }
  checkConversion = assertCurrent
  return { value, assertCurrent, stop: deadline => work.stop(deadline), isIdle: () => work.isIdle(), inspect(): ExposureInventory {
    assertCurrent()
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'officeKit' || remote.namespace !== 'officeKit'
      || markers.length > maximum) unavailable()
    const entries = ([['render', 'render'], ['getGeneration', 'generation']] as const).map(([member, method]) => {
      const matches = markers.filter(marker => marker.method === member), marker = matches[0]
      if (matches.length !== 1 || marker === undefined || (marker.exportName ?? member) !== method
        || markers.filter(row => (row.exportName ?? row.method) === method).length !== 1 || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(value, member) !== Reflect.get(OfficeKit.prototype, member)) unavailable()
      return { endpoint: `officeKit/${method}`, handlerId: 'native:officeKit',
        guard: method === 'render' ? 'account-session' as const : 'authenticated-account' as const }
    })
    if (new Set(entries.map(row => row.endpoint)).size !== 2) unavailable()
    return { recipeVersion: binding.recipeVersion, rpcEndpoints: entries, streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
