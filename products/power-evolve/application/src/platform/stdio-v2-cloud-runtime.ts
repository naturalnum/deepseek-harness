/** Private original Cloud Runner transport; queried absence never authorizes start or writer release. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { stdioJsonV2, stdioLimitsV2, stdioObjectV2, stdioPreparedV2, stdioStartAuthorizationV2,
  type StdioDispatchV2, type StdioLimitsV2, type StdioPreparedV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCloudStopEvidenceV2, stdioRuntimeViewV2, type StdioCloudObservationV2 } from '@power-evolve/contracts/stdio-runtime'
import { parseStdioStartV2, validateStdioStartV2 } from '@power-evolve/connector-runner/stdio-v2-dispatch'
import { stdioCatalogFingerprintV2, stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { PlatformError } from '../contracts.ts'
import { KubernetesError } from './kubernetes.ts'
import type { SandboxManager, SandboxReady } from './sandbox.ts'
import { storageBinding } from './workspace-binding-types.ts'

/** Original once reply; a persisted false receipt is observation authority only. */
export type StdioCloudAuthorizationV2 = z.infer<typeof stdioStartAuthorizationV2>
/** Explicit SDK/transport bounds and the maximum number of live original permit reservations. */
export interface StdioCloudRunOptionsV2 { limits: StdioLimitsV2; maxReplyBytes: number; requestTimeoutMs: number; maxTrackedActions: number }
interface Original { dispatch: StdioDispatchV2; authorization: StdioCloudAuthorizationV2; prepared: StdioPreparedV2;
  dispatchDigest: StdioDispatchV2['taskDigest'] }
interface Tracked { dispatchDigest: string; executionId: string; expiresAt: number }

/** Calls only the original already captured Runner; every HTTP operation is bracketed by fresh exact capture. */
export class StdioCloudRunTransportV2 {
  private readonly options: StdioCloudRunOptionsV2
  private readonly actions = new Map<string, Tracked>()
  private readonly executions = new Map<string, string>()
  private observedNow = 0
  private startsBlockedUntil = 0
  constructor(private readonly manager: Pick<SandboxManager, 'observeReady' | 'captureStdioV2' | 'runnerBounded'>,
    options: StdioCloudRunOptionsV2) {
    this.options = { ...options, limits: stdioLimitsV2.parse(options.limits) }
    if (!Number.isSafeInteger(options.maxReplyBytes) || options.maxReplyBytes <= 0
      || !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0
      || options.requestTimeoutMs > 2_147_483_647 || !Number.isSafeInteger(options.maxTrackedActions)
      || options.maxTrackedActions <= 0) throw new TypeError('stdio_v2_cloud_transport_options_invalid')
  }

  /** Consume only the first in-process true reply; expired/repeated replies query and capacity blocks new starts.
   * @param client Original caller transaction holding owner and accepted resource locks.
   * @param dispatch Complete immutable dispatch whose permit is already committed by the Platform.
   * @param authorization Original true response or a persisted false query receipt with the same complete permit.
   * @param prepared Original stored private image/spec/mount/Runner snapshot, never a browser observation.
   * @returns Bounded original Runner observation; no response/404 is not a stop certificate.
   */
  async start(client: PoolClient, dispatch: StdioDispatchV2, authorization: StdioCloudAuthorizationV2,
    prepared: StdioPreparedV2): Promise<StdioCloudObservationV2 | null> {
    const original = this.original(dispatch, prepared, authorization), now = this.now(), first = this.bind(original, now)
    if (first && original.authorization.grantOnce) {
      if (original.prepared.capture.kind !== 'cloud') throw this.changed()
      try { validateStdioStartV2({ dispatch: original.dispatch, authorization: original.authorization }, this.options.limits,
        { kind: 'cloud', runnerInstanceId: original.prepared.capture.runnerInstanceId }, now) }
      catch (_startRejected) { throw new PlatformError(409, 'stdio_v2_cloud_start_denied') }
      return this.request(client, original, 'POST', '/stdio/v2/executions', 'dispatch',
        { dispatch: original.dispatch, authorization: original.authorization })
    }
    return this.request(client, original, 'GET', this.path(original), 'observe')
  }

  /** Query the exact original execution without provisioning, replaying or treating 404 as quiet.
   * @param client Caller transaction retaining the original resource locks, including after revocation.
   * @param dispatch Original full dispatch and consumed permit.
   * @param prepared Original immutable private preparation.
   * @returns Same Runner facts, or null only for an exact GET 404 after both captures still match.
   */
  async observe(client: PoolClient, dispatch: StdioDispatchV2, prepared: StdioPreparedV2): Promise<StdioCloudObservationV2 | null> {
    const original = this.original(dispatch, prepared); this.bind(original, this.now())
    return this.request(client, original, 'GET', this.path(original), 'observe')
  }

  /** Ask only the same original Runner to cancel; its response still needs complete UID stop evidence.
   * @param client Caller transaction with original owner/resource locks; revocation does not prevent stop observation.
   * @param dispatch Original dispatch identity, never a replacement action.
   * @param prepared Original captured writer.
   * @returns Bounded cancel observation; transport/POST absence rejects without declaring stopped.
   */
  async cancel(client: PoolClient, dispatch: StdioDispatchV2, prepared: StdioPreparedV2): Promise<StdioCloudObservationV2 | null> {
    const original = this.original(dispatch, prepared); this.bind(original, this.now())
    return this.request(client, original, 'POST', `${this.path(original)}/cancel`, 'observe')
  }

  private budget() {
    const limits = this.options.limits
    return { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
  }
  private sha(domain: 'spec' | 'scope' | 'prepared' | 'dispatch', value: unknown) { return stdioSha256V2(domain, value, this.budget()) }
  private changed() { return new PlatformError(409, 'stdio_v2_cloud_original_changed') }
  private same(left: unknown, right: unknown) { return this.sha('spec', left) === this.sha('spec', right) }
  private path(original: Original) { return `/stdio/v2/executions/${encodeURIComponent(original.dispatch.executionRef.executionId)}` }

  private original(dispatch: StdioDispatchV2, prepared: StdioPreparedV2, authorization?: StdioCloudAuthorizationV2): Original {
    try {
      authorization ??= { grantOnce: false, permit: dispatch.permit }
      stdioJsonV2(this.budget()).parse({ dispatch, authorization, prepared })
      const packet = parseStdioStartV2({ dispatch, authorization }, this.options.limits)
      const p = stdioJsonV2(this.budget()).pipe(stdioPreparedV2).parse(prepared), d = packet.dispatch, task = d.task
      if (d.executionRef.kind !== 'cloud' || task.scopeBinding.kind !== 'cloud' || p.capture.kind !== 'cloud'
        || d.permit.executorOwner.kind !== 'cloud' || p.actionId !== task.actionId || !this.same(p.executionRef, d.executionRef)
        || p.taskDigest !== d.taskDigest || this.sha('prepared', p) !== d.preparedDigest
        || !this.same(p.scopeBinding, task.scopeBinding) || !this.same(p.expectedDeploymentPin, task.expectedDeploymentPin)
        || p.capture.runnerInstanceId !== d.permit.executorOwner.runnerInstanceId
        || p.fullScopeDigest !== this.sha('scope', { scopeBinding: p.scopeBinding,
          workspaceMount: p.capture.workspaceMount, homeMount: p.capture.homeMount })
        || task.phase === 'call' && !this.same(p.actualExecutorImage, task.selection.catalogImageExpectation)) throw this.changed()
      return { dispatch: packet.dispatch, authorization: packet.authorization, prepared: structuredClone(p),
        dispatchDigest: this.sha('dispatch', packet.dispatch) }
    } catch (_invalidOriginal) { throw this.changed() }
  }

  private now(): number {
    // Once expiry retired a reservation, a wall-clock rollback cannot restore its start authority.
    const now = Date.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('stdio_v2_cloud_clock_invalid')
    this.observedNow = Math.max(this.observedNow, now)
    return this.observedNow
  }

  private bind(original: Original, now: number): boolean {
    for (const [action, tracked] of this.actions) if (tracked.expiresAt <= now) {
      this.actions.delete(action); this.executions.delete(tracked.executionId)
    }
    if (this.startsBlockedUntil <= now) this.startsBlockedUntil = 0
    const action = original.dispatch.task.actionId, execution = original.dispatch.executionRef.executionId
    const previous = this.actions.get(action), owner = this.executions.get(execution)
    if (previous !== undefined && previous.dispatchDigest !== original.dispatchDigest || owner !== undefined && owner !== action) throw this.changed()
    if (previous !== undefined) return false
    const expiresAt = Date.parse(original.dispatch.permit.expiresAt)
    if (expiresAt <= now) return false
    if (this.actions.size >= this.options.maxTrackedActions || original.authorization.grantOnce && this.startsBlockedUntil > now) {
      // Unknown queries/cancels remain available; their untracked true reply is fenced until its whole permit expires.
      this.startsBlockedUntil = Math.max(this.startsBlockedUntil, expiresAt)
      if (original.authorization.grantOnce) throw new PlatformError(409, 'stdio_v2_cloud_tracking_full')
      return false
    }
    this.actions.set(action, { dispatchDigest: original.dispatchDigest, executionId: execution, expiresAt })
    this.executions.set(execution, action)
    return true
  }

  private async capture(client: PoolClient, original: Original, mode: 'dispatch' | 'observe'): Promise<SandboxReady> {
    const { dispatch, prepared } = original, task = dispatch.task, expected = prepared.capture, scope = task.scopeBinding
    if (scope.kind !== 'cloud' || expected.kind !== 'cloud' || task.expectedDeploymentPin.kind !== 'cloud') throw this.changed()
    const writer = await this.manager.observeReady(task.sessionId, task.userId, expected.podUid, expected.runnerInstanceId, client, mode)
    const binding = storageBinding.parse(writer.binding)
    if (writer.name !== expected.podName || writer.podUid !== expected.podUid || writer.runnerInstanceId !== expected.runnerInstanceId
      || writer.sessionId !== task.sessionId || writer.userId !== task.userId || writer.generation !== expected.mountGeneration
      || binding.workspaceId !== scope.workspaceId
      || binding.generation !== scope.bindingGeneration || binding.spaceId !== scope.target.spaceId
      || binding.rootRelativePath !== scope.target.rootRelativePath) throw this.changed()
    const observed = await this.manager.captureStdioV2(writer, scope, task.expectedDeploymentPin, this.options.limits, client, mode)
    const fresh = stdioJsonV2(this.budget()).pipe(stdioPreparedV2).parse({ formatVersion: 2, actionId: task.actionId,
      executionRef: dispatch.executionRef, taskDigest: dispatch.taskDigest, scopeBinding: scope,
      expectedDeploymentPin: task.expectedDeploymentPin, actualExecutorImage: observed.actualExecutorImage, capture: observed.capture,
      specDigest: this.sha('spec', stdioObjectV2(this.budget()).parse(observed.spec)),
      fullScopeDigest: this.sha('scope', { scopeBinding: scope,
        workspaceMount: observed.capture.workspaceMount, homeMount: observed.capture.homeMount }) })
    if (!this.same(fresh, prepared)) throw this.changed()
    return writer
  }

  private async request(client: PoolClient, original: Original, method: 'GET' | 'POST', path: string,
    mode: 'dispatch' | 'observe', body?: unknown): Promise<StdioCloudObservationV2 | null> {
    const writer = await this.capture(client, original, mode)
    // Capture may outlast the permit; an unsent start becomes only a query, including after clock rollback.
    if (mode === 'dispatch' && Date.parse(original.dispatch.permit.expiresAt) <= this.now()) {
      method = 'GET'; path = this.path(original); body = undefined
    }
    let value: unknown, failed = false, missing = false
    try {
      value = await this.manager.runnerBounded(writer.name, writer.token, method, path, body,
        { timeoutMs: this.options.requestTimeoutMs, maxResponseBytes: this.options.maxReplyBytes })
    } catch (error) { if (method === 'GET' && error instanceof KubernetesError && error.status === 404) missing = true; else failed = true }
    // Even a lost response or missing query is observed against the same original writer, never a new one.
    await this.capture(client, original, 'observe')
    if (failed) throw new PlatformError(409, 'stdio_v2_cloud_runner_unavailable')
    if (missing) return null
    let view: StdioCloudObservationV2['view']
    try { view = stdioRuntimeViewV2(this.options.limits, this.options.maxReplyBytes).parse(value) }
    catch (_invalidReply) { throw new PlatformError(409, 'stdio_v2_cloud_runner_reply_invalid') }
    const d = original.dispatch, p = original.prepared
    if (p.capture.kind !== 'cloud' || view.instanceId !== p.capture.runnerInstanceId || view.actionId !== d.task.actionId
      || !this.same(view.executionRef, d.executionRef) || view.taskDigest !== d.taskDigest || view.dispatchDigest !== original.dispatchDigest
      || view.outcome?.state === 'completed' && (view.outcome.phase !== d.task.phase || d.task.phase === 'call'
        && stdioCatalogFingerprintV2(view.outcome.catalog, this.options.limits) !== d.task.selection.catalogDigest)) throw this.changed()
    const stopped = ['completed', 'failed', 'cancelled'].includes(view.state) && view.writerStopConfirmed
    const stopEvidence = stopped ? stdioCloudStopEvidenceV2.parse({ formatVersion: 2, kind: 'cloud_uid_quiet',
      actionId: d.task.actionId, executionRef: d.executionRef, taskDigest: d.taskDigest, dispatchDigest: original.dispatchDigest,
      preparedDigest: d.preparedDigest, fullScopeDigest: p.fullScopeDigest, podUid: p.capture.podUid,
      runnerInstanceId: p.capture.runnerInstanceId, mountGeneration: p.capture.mountGeneration, observedAt: new Date().toISOString() }) : null
    return structuredClone({ view, stopEvidence })
  }
}
