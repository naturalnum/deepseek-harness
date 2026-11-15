/** Original Host tasks under one account's Session, target, and exposure guards. */
import { nativeOriginal } from './native-inventory.ts'
import { type Context } from '@deepseek-ai/cordis'
import ScheduleService, { type ScheduleCatalogEntry, type ScheduleTask, type ScheduleTargetRequest } from '@deepseek-ai/dsh-schedule'
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

const methods = [
  { endpoint: 'deliveryLimits', method: 'deliveryLimits', guard: 'authenticated-account' },
  { endpoint: 'create', method: 'remoteCreate', guard: 'account-session' },
  { endpoint: 'list', method: 'remoteList', guard: 'account-session' },
  { endpoint: 'catalog', method: 'catalog', guard: 'authenticated-account' },
  { endpoint: 'view', method: 'view', guard: 'account-session' },
  { endpoint: 'history', method: 'remoteHistory', guard: 'account-session' },
  { endpoint: 'run', method: 'run', guard: 'account-session' },
  { endpoint: 'deleteInactive', method: 'deleteInactive', guard: 'account-session' },
  { endpoint: 'edit', method: 'remoteEdit', guard: 'account-session' },
] as const
const reviewedEndpoints = ['list', 'catalog', 'history', 'edit'] as const
type Method = (typeof reviewedEndpoints)[number]
type TaskFacts = Pick<ScheduleTask, 'target' | 'involvedSessionIds' | 'lastDelivery'>

/** Install native Schedule under the original account graph; the owning Loader controls its lifetime.
 * @param ctx Exact account Loader fiber.
 * @param binding Original account generation.
 * @param assertCurrent Original business admission guard.
 * @param policy Explicit approved account endpoint inventory.
 * @param guards Original Session/Workspace checks and finite first-screen bounds.
 * @param maximum Existing finite native service inventory limit.
 * @param config Native Schedule configuration.
 * @returns Original service and its auditable account-bound exposure. Creating targets require separate authorization and are refused.
 */
export function createNativeSchedule(ctx: Context, binding: AccountBinding, assertCurrent: (binding: AccountBinding) => void,
  policy: ExposurePolicy, guards: NativeSessionGuards, maximum: number,
  config: ConstructorParameters<typeof ScheduleService>[1]): NativeSchedule {
  const candidate = guards.firstScreen
  const unavailable = (): never => { throw new CloudApiError('cloud/account-unavailable', 'The account Schedule service is unavailable.') }
  const closedEndpoint = (): never => {
    current()
    throw new CloudApiError('cloud/forbidden', 'This Schedule endpoint is not approved for this account.')
  }
  const unsupportedTarget = (): never => {
    throw new CloudApiError('cloud/forbidden', 'This account permits scheduled delivery only to an existing Session.')
  }
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
      const original: unknown = scoped === undefined ? undefined : nativeOriginal(scoped) ?? scoped
      if (original !== owner.value) unavailable()
    }
  }
  const current = (): void => { installed(); assertCurrent(binding); installed() }
  const admit = (method: Method): void => {
    current()
    const declaration = methods.find(row => row.endpoint === method) ?? unavailable()
    const row = policy.requireRpc('schedule/' + method)
    if (row.handlerId !== 'native:schedule' || row.guard !== declaration.guard) unavailable()
  }
  const session = async (sessionId: SessionId): Promise<void> => {
    current()
    reader.assertSessionRead(sessionId)
    await guards.assertSessionProject(sessionId)
    current()
    reader.assertSessionRead(sessionId)
  }
  const target = async (value: ScheduleTargetRequest | TaskFacts['target'] | undefined): Promise<void> => {
    current()
    if (value?.kind !== 'session') return unsupportedTarget()
    await session(value.sessionId)
  }
  const prepareTask = async (task: TaskFacts): Promise<() => void> => {
    current()
    if (task.target.kind !== 'session') return unsupportedTarget()
    if (task.involvedSessionIds.length > reader.maxCollectionItems) unavailable()
    const ids = [...new Set([task.target.sessionId, ...task.involvedSessionIds,
      ...(task.lastDelivery === undefined ? [] : [task.lastDelivery.targetSessionId])])]
    for (const id of ids) await session(id)
    const recheck = (): void => { current(); for (const id of ids) reader.assertSessionRead(id) }
    recheck()
    return recheck
  }
  const checkedEntry = async (entry: ScheduleCatalogEntry): Promise<void> => {
    firstScreenJsonBytes(entry, reader.maxFrameBytes)
    const recheck = await prepareTask(entry)
    recheck()
  }
  const result = <T>(method: Method, value: T): T => {
    admit(method); firstScreenJsonBytes(value, reader.maxFrameBytes); return value
  }
  installed()
  class AccountSchedule extends ScheduleService {
    protected override async prepareMutation(before: ScheduleTask | undefined, after: ScheduleTask | undefined,
      actorSessionId: SessionId | undefined): Promise<() => void> {
      const checks: (() => void)[] = []
      if (before !== undefined) checks.push(await prepareTask(before))
      if (after !== undefined) checks.push(await prepareTask(after))
      if (actorSessionId !== undefined) await session(actorSessionId)
      return () => {
        current()
        for (const check of checks) check()
        if (actorSessionId !== undefined) reader.assertSessionRead(actorSessionId)
      }
    }
    private async authorizeStored(id: Parameters<ScheduleService['view']>[0]['id']): Promise<void> {
      current()
      const value = await super.view({ id })
      if ('target' in value) await checkedEntry(value)
      current()
    }
    override deliveryLimits(): ReturnType<ScheduleService['deliveryLimits']> { return closedEndpoint() }
    override async create(request: Parameters<ScheduleService['create']>[0], actorSessionId?: SessionId, signal?: AbortSignal) {
      firstScreenJsonBytes(request, reader.maxFrameBytes)
      await target(request.target)
      if (actorSessionId !== undefined) await session(actorSessionId)
      const value = await super.create(request, actorSessionId, signal)
      await checkedEntry(value)
      current()
      return value
    }
    override async remoteCreate(request: Parameters<ScheduleService['remoteCreate']>[0], signal?: AbortSignal):
    ReturnType<ScheduleService['remoteCreate']> { void request; void signal; return closedEndpoint() }
    override async list(request: Parameters<ScheduleService['list']>[0] = {}) {
      admit('list'); firstScreenJsonBytes(request, reader.maxFrameBytes)
      const id = request.targetSessionId ?? unsupportedTarget()
      if (request.active === false || (request.limit !== undefined && request.limit > reader.maxCollectionItems)) closedEndpoint()
      await session(id)
      const value = await super.list({ ...request, active: true, limit: request.limit ?? reader.maxCollectionItems })
      if (value.total > reader.maxCollectionItems || value.items.length > reader.maxCollectionItems
        || value.items.some(entry => entry.target.kind !== 'session' || entry.target.sessionId !== id)) unavailable()
      firstScreenJsonBytes(value, reader.maxFrameBytes)
      const checks: (() => void)[] = []
      for (const entry of value.items) checks.push(await prepareTask(entry))
      for (const check of checks) check()
      reader.assertSessionRead(id)
      return result('list', value)
    }
    override async remoteList(request: Parameters<ScheduleService['remoteList']>[0]) {
      admit('list'); return result('list', await super.remoteList(request))
    }
    override async catalog() {
      admit('catalog')
      const rows = await super.catalog()
      if (rows.length > reader.maxCollectionItems) unavailable()
      firstScreenJsonBytes(rows, reader.maxFrameBytes)
      const checks: (() => void)[] = []
      for (const row of rows) checks.push(await prepareTask(row))
      for (const check of checks) check()
      return result('catalog', rows)
    }
    override async view(request: Parameters<ScheduleService['view']>[0]): ReturnType<ScheduleService['view']> {
      void request
      return closedEndpoint()
    }
    override async history(request: Parameters<ScheduleService['history']>[0]) {
      admit('history'); firstScreenJsonBytes(request, reader.maxFrameBytes)
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > reader.maxCollectionItems) unavailable()
      await this.authorizeStored(request.id)
      const value = await super.history(request)
      firstScreenJsonBytes(value, reader.maxFrameBytes)
      const ids = 'records' in value ? [...new Set(value.records.map(record => record.targetSessionId))] : []
      for (const id of ids) await session(id)
      for (const id of ids) reader.assertSessionRead(id)
      return result('history', value)
    }
    override async remoteHistory(request: Parameters<ScheduleService['remoteHistory']>[0]) {
      admit('history'); return result('history', await super.remoteHistory(request))
    }
    override async run(request: Parameters<ScheduleService['run']>[0], signal?: AbortSignal): ReturnType<ScheduleService['run']> {
      void request; void signal
      return closedEndpoint()
    }
    override async deleteInactive(): ReturnType<ScheduleService['deleteInactive']> { return closedEndpoint() }
    override async edit(request: Parameters<ScheduleService['edit']>[0], actorSessionId?: SessionId, signal?: AbortSignal) {
      admit('edit'); firstScreenJsonBytes(request, reader.maxFrameBytes)
      if (!['update', 'delete'].includes(request.action)) closedEndpoint()
      await this.authorizeStored(request.id)
      if (request.action === 'update' && request.patch.target !== undefined) await target(request.patch.target)
      if (actorSessionId !== undefined) await session(actorSessionId)
      const value = await super.edit(request, actorSessionId, signal)
      if ('target' in value) await checkedEntry(value)
      return result('edit', value)
    }
    override async remoteEdit(request: Parameters<ScheduleService['remoteEdit']>[0], signal?: AbortSignal) {
      admit('edit'); return result('edit', await super.remoteEdit(request, signal))
    }
  }
  const value = new AccountSchedule(ctx, config)
  owner.value = value
  if (value.installDispatchAdmission !== installAdmission) unavailable()
  value.installDispatchAdmission(prepareTask)
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
      || markers.length > maximum) unavailable()
    for (const { endpoint, method } of methods) {
      const matches = markers.filter(row => row.method === method), marker = matches[0]
      if (matches.length !== 1 || marker === undefined || (marker.exportName ?? method) !== endpoint
        || markers.filter(row => (row.exportName ?? row.method) === endpoint).length !== 1 || (marker.mode ?? 'rpc') !== 'rpc'
        || Reflect.get(value, method) !== Reflect.get(AccountSchedule.prototype, method)) unavailable()
    }
    return { recipeVersion: binding.recipeVersion,
      rpcEndpoints: methods.filter(({ endpoint }) => reviewedEndpoints.some(reviewed => reviewed === endpoint)
        && policy.manifest.rpcEndpoints.some(row => row.endpoint === 'schedule/' + endpoint))
        .map(({ endpoint, guard }) => ({ endpoint: 'schedule/' + endpoint, handlerId: 'native:schedule', guard })),
      streamEndpoints: [], exactFetchRoutes: [] }
  } }
}
