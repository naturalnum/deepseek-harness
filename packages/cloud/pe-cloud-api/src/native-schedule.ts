/** Original Schedule service under one account's Session and exposure guards. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { NativeSessionGuards } from './native.ts'
import type { ExposurePolicy } from './exposure.ts'
import type { ExposureInventory } from './types.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { firstScreenNativeOwner } from './native-first-screen.ts'
import { CloudApiError } from './errors.ts'

/** Original native scheduler and the bounded inventory of its guarded Remote methods. */
export interface NativeSchedule {
  readonly value: ScheduleService
  /** Reconsider native obligations only after the original account becomes ready. */
  resumeAfterReady(): Promise<void>
  /** Observe the original scheduler owner, including admitted work awaiting persistence. */
  isIdle(): boolean
  /** Audit the registered original service and its guarded Remote markers. */
  inspect(): ExposureInventory
}

type Method = 'list' | 'catalog' | 'history' | 'delete' | 'update'
const methods: readonly Method[] = ['list', 'catalog', 'history', 'delete', 'update']

/** Install native Schedule under the original account graph; the owning Loader controls its lifetime.
 * @param ctx Exact account Loader fiber.
 * @param binding Original account generation.
 * @param assertCurrent Original business admission guard.
 * @param policy Explicit approved account endpoint inventory.
 * @param guards Original Session/Workspace checks and finite first-screen bounds.
 * @param maximum Existing finite native service inventory limit.
 * @param config Native Schedule configuration.
 * @returns Original service and its auditable account-bound exposure.
 */
export function createNativeSchedule(ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
  config: ConstructorParameters<typeof ScheduleService>[1]): NativeSchedule {
  const candidate = guards.firstScreen
  const unavailable = (): never => { throw new CloudApiError('cloud/account-unavailable', 'The account Schedule service is unavailable.') }
  const reader = candidate ?? unavailable()
  if (!Number.isSafeInteger(maximum) || maximum < 1
    || !Number.isSafeInteger(reader.maxCollectionItems) || reader.maxCollectionItems < 1
    || !Number.isSafeInteger(reader.maxFrameBytes) || reader.maxFrameBytes < 1) unavailable()
  const owner: { value?: ScheduleService } = {}
  const resumeDispatch: unknown = Reflect.get(ScheduleService.prototype, 'resumeDispatch')
  const installAdmission: unknown = Reflect.get(ScheduleService.prototype, 'installDispatchAdmission')
  const isDispatchIdle: unknown = Reflect.get(ScheduleService.prototype, 'isDispatchIdle')
  const installed = (): void => {
    ctx.fiber.assertActive()
    if (binding.lifetime.aborted || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding
      || policy.manifest.recipeVersion !== binding.recipeVersion) unavailable()
    if (owner.value !== undefined) {
      const scoped = ctx.get('schedule')
      const original: unknown = scoped === undefined ? undefined : Reflect.get(scoped, symbols.original) ?? scoped
      if (original !== owner.value) unavailable()
    }
  }
  const current = (): void => { installed(); assertCurrent(binding); installed() }
  const admit = (method: Method): void => {
    current()
    const row = policy.requireRpc('schedule/' + method)
    if (row.handlerId !== 'native:schedule' || row.guard !== (method === 'catalog' ? 'authenticated-account' : 'account-session')) unavailable()
  }
  const session = async (sessionId: SessionId): Promise<void> => {
    current()
    reader.assertSessionRead(sessionId)
    await guards.assertSessionProject(sessionId)
    current()
    reader.assertSessionRead(sessionId)
  }
  const prepare = async (method: Exclude<Method, 'catalog'>, request: { readonly sessionId: SessionId }): Promise<void> => {
    admit(method); firstScreenJsonBytes(request, reader.maxFrameBytes)
    await session(request.sessionId)
    admit(method)
  }
  const result = <T>(method: Method, value: T): T => {
    admit(method); firstScreenJsonBytes(value, reader.maxFrameBytes); return value
  }
  installed()
  class AccountSchedule extends ScheduleService {
    override async create(id: SessionId, request: Parameters<ScheduleService['create']>[1], signal?: AbortSignal) {
      firstScreenJsonBytes(request, reader.maxFrameBytes)
      await session(id)
      const value = await super.create(id, request, signal)
      await session(id)
      return value
    }
    override async list(request: Parameters<ScheduleService['list']>[0]) {
      await prepare('list', request)
      const rows = await super.list(request)
      if (rows.length > reader.maxCollectionItems) unavailable()
      reader.assertSessionRead(request.sessionId)
      return result('list', rows)
    }
    override async catalog() {
      admit('catalog')
      const rows = await super.catalog()
      admit('catalog')
      if (rows.length > reader.maxCollectionItems) unavailable()
      firstScreenJsonBytes(rows, reader.maxFrameBytes)
      for (const row of rows) await session(row.sessionId)
      for (const row of rows) reader.assertSessionRead(row.sessionId)
      return result('catalog', rows)
    }
    override async history(request: Parameters<ScheduleService['history']>[0]) {
      await prepare('history', request)
      const value = await super.history(request)
      reader.assertSessionRead(request.sessionId)
      return result('history', value)
    }
    override async delete(request: Parameters<ScheduleService['delete']>[0], signal?: AbortSignal) {
      await prepare('delete', request)
      const value = await super.delete(request, signal)
      reader.assertSessionRead(request.sessionId)
      return result('delete', value)
    }
    override async update(request: Parameters<ScheduleService['update']>[0], signal?: AbortSignal) {
      await prepare('update', request)
      const value = await super.update(request, signal)
      reader.assertSessionRead(request.sessionId)
      return result('update', value)
    }
  }
  const value = new AccountSchedule(ctx, config)
  owner.value = value
  if (value.installDispatchAdmission !== installAdmission) unavailable()
  value.installDispatchAdmission(async (id) => {
    await session(id)
    return () => { current(); reader.assertSessionRead(id) }
  })
  return { value, isIdle() {
    installed()
    if (value.isDispatchIdle !== isDispatchIdle || ScheduleService.prototype.isDispatchIdle !== isDispatchIdle) unavailable()
    return value.isDispatchIdle()
  }, async resumeAfterReady() {
    const original = (): void => {
      if (value.resumeDispatch !== resumeDispatch || ScheduleService.prototype.resumeDispatch !== resumeDispatch) unavailable()
    }
    current()
    original()
    await value.resumeDispatch()
    original()
    current()
  }, inspect() {
    installed()
    firstScreenNativeOwner(ctx, 'schedule', value, maximum)
    const remote = value.typertRemote, markers = remoteMethods(value)
    if (remote.service !== value || remote.serviceKey !== 'schedule' || remote.namespace !== 'schedule'
      || markers.length !== methods.length || markers.length > maximum) unavailable()
    for (const method of methods) {
      const marker = markers.find(row => row.method === method)
      if (marker === undefined || (marker.exportName ?? method) !== method || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(value, method) !== Reflect.get(AccountSchedule.prototype, method)) unavailable()
    }
    return { recipeVersion: binding.recipeVersion,
      rpcEndpoints: methods.filter(method => policy.manifest.rpcEndpoints.some(row => row.endpoint === 'schedule/' + method))
        .map(method => ({ endpoint: 'schedule/' + method, handlerId: 'native:schedule',
          guard: method === 'catalog' ? 'authenticated-account' as const : 'account-session' as const })),
      streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
