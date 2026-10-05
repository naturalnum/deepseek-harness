/** Browser storage follows current Platform membership and the owned Cloud document generation. */
import { randomUUID } from 'node:crypto'
import type { DesktopBrowserLeaseId, DesktopBrowserReservation } from '@deepseek-ai/dsh-desktop/assembly'
import type { DesktopBrowserScopeRequest, DesktopBrowserScopeView } from '@power-evolve/contracts/desktop-browser-scope'
import type { SidebarBrowserConfig } from './config.ts'

/** Guest operations remain in Electron main; retirement closes guests and clears their storage. */
export interface CloudBrowserResources {
  /** @param key - Main-selected storage identity. @returns An owned guest reservation. */
  acquire(key: string): DesktopBrowserReservation
  /** @param lease - Main-issued reservation. @returns After its actual guest closes. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param key - Main-selected storage identity. @returns After guest exit and storage cleanup. */
  retireWorkspace(key: string): Promise<void>
}

/** Main-process dependencies; renderer input cannot select credentials, owner or storage keys. */
export interface CloudBrowserAuthorizationOptions {
  readonly config: SidebarBrowserConfig
  readonly resources: CloudBrowserResources
  readonly assertDocument: () => void
  readonly requestScope: (request: DesktopBrowserScopeRequest, signal: AbortSignal) => Promise<DesktopBrowserScopeView>
  readonly onCleanupFailure: () => void
}

interface Reservation {
  readonly lease: DesktopBrowserLeaseId
  readonly scope: DesktopBrowserScopeView
  readonly key: string
}

/**
 * Recheck membership for every acquire and periodically while guests remain active.
 * Document/account invalidation immediately fences reservations, aborts pending observations and
 * retires all storage used by that document. Failed cleanup keeps admission closed until retried.
 * This is a bounded client-side authorization observation, not a lasting Platform grant.
 */
export class CloudBrowserAuthorization {
  private readonly generation = randomUUID()
  private epoch = 0
  private stopped = false
  private owner: DesktopBrowserScopeView['userId'] | undefined
  private readonly keys = new Set<string>()
  private readonly retiring = new Set<string>()
  private readonly retirementTasks = new Map<string, Promise<boolean>>()
  private readonly reservations = new Map<string, Reservation>()
  private readonly requests = new Set<AbortController>()
  private cleanup: Promise<void> = Promise.resolve()
  private checking = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: CloudBrowserAuthorizationOptions) {}

  private assertCurrent(epoch: number): void {
    this.options.assertDocument()
    if (this.stopped || epoch !== this.epoch) throw new Error('PowerEvolve desktop: stale browser authorization')
  }

  private async observe(request: DesktopBrowserScopeRequest): Promise<DesktopBrowserScopeView> {
    const controller = new AbortController()
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('PowerEvolve desktop: browser authorization interrupted')), { once: true })
    })
    this.requests.add(controller)
    const timeout = setTimeout(() => controller.abort(), this.options.config.scopeRequestTimeoutMs)
    timeout.unref()
    try {
      const scope = await Promise.race([this.options.requestScope(request, controller.signal), interrupted])
      if (scope.sessionId !== request.sessionId) throw new Error('PowerEvolve desktop: mismatched browser membership')
      return scope
    } finally {
      clearTimeout(timeout)
      this.requests.delete(controller)
    }
  }

  private beginRetirement(key: string): void {
    if (this.retirementTasks.has(key)) return
    try {
      // retireWorkspace fences guest navigation synchronously, before its exit/clear Promise settles.
      const task = this.options.resources.retireWorkspace(key).then(() => true, () => false)
      this.retirementTasks.set(key, task)
    } catch (_retirementFailed) { this.retirementTasks.set(key, Promise.resolve(false)) }
  }

  private enqueueCleanup(): Promise<void> {
    const attempt = this.cleanup.catch(() => { /* Pending keys retain the failed cleanup for this retry. */ }).then(async () => {
      const results = await Promise.all([...this.retiring].map(async key => {
        this.beginRetirement(key)
        const task = this.retirementTasks.get(key)!
        const closed = await task
        if (this.retirementTasks.get(key) === task) {
          this.retirementTasks.delete(key)
          if (closed) this.retiring.delete(key)
        }
        return closed
      }))
      if (results.some(closed => !closed)) throw new Error('PowerEvolve desktop: browser cleanup incomplete')
    })
    this.cleanup = attempt
    return attempt
  }

  /**
   * Fence all old requests synchronously before awaiting guest exit and storage cleanup.
   * @returns Completion of cleanup; rejection preserves blocked storage for a later retry.
   */
  invalidate(): Promise<void> {
    this.epoch++
    this.owner = undefined
    clearTimeout(this.timer)
    this.timer = undefined
    for (const request of this.requests) request.abort()
    this.reservations.clear()
    for (const key of this.keys) {
      this.retiring.add(key)
      this.beginRetirement(key)
    }
    this.keys.clear()
    return this.enqueueCleanup()
  }

  /**
   * Resolve current account/session membership before selecting a storage partition.
   * @param request - Validated native Session; no filesystem path is used for authorization.
   * @returns A reservation bound to the current document, account and Workspace.
   */
  async acquire(request: DesktopBrowserScopeRequest): Promise<DesktopBrowserReservation> {
    const epoch = this.epoch
    this.assertCurrent(epoch)
    try { await this.cleanup }
    catch (_cleanupIncomplete) { await this.enqueueCleanup() }
    this.assertCurrent(epoch)
    let scope: DesktopBrowserScopeView
    try { scope = await this.observe(request) }
    catch (error) {
      if (epoch === this.epoch) await this.invalidate().catch(() => { this.options.onCleanupFailure() })
      throw error
    }
    this.assertCurrent(epoch)
    if (this.owner !== undefined && this.owner !== scope.userId) {
      await this.invalidate()
      throw new Error('PowerEvolve desktop: browser account changed')
    }
    this.owner = scope.userId
    const key = JSON.stringify([this.generation, epoch, scope.userId, scope.workspaceId])
    this.keys.add(key)
    const reservation = this.options.resources.acquire(key)
    this.reservations.set(reservation.lease, { lease: reservation.lease, scope, key })
    this.scheduleRecheck()
    return reservation
  }

  /**
   * Cleanup needs no new credential; unknown or already retired leases cause no resource operation.
   * @param lease - Reservation issued to this owned window.
   * @returns After an active lease's actual guest closes; failure leaves it tracked.
   */
  async release(lease: string): Promise<void> {
    const reservation = this.reservations.get(lease)
    if (reservation === undefined) return
    await this.options.resources.release(reservation.lease)
    if (this.reservations.get(lease) === reservation) this.reservations.delete(lease)
    if (this.reservations.size === 0) { clearTimeout(this.timer); this.timer = undefined }
  }

  private scheduleRecheck(): void {
    if (this.stopped || this.checking || this.timer !== undefined || this.reservations.size === 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.recheck().catch(() => { this.options.onCleanupFailure() })
    }, this.options.config.scopeRecheckIntervalMs)
    this.timer.unref()
  }

  private async recheck(): Promise<void> {
    this.checking = true
    const epoch = this.epoch
    const scopes = new Map([...this.reservations.values()].map(record => [record.scope.sessionId, record.scope]))
    try {
      for (const expected of scopes.values()) {
        this.assertCurrent(epoch)
        const actual = await this.observe({ sessionId: expected.sessionId })
        this.assertCurrent(epoch)
        if (actual.userId !== expected.userId || actual.workspaceId !== expected.workspaceId) {
          throw new Error('PowerEvolve desktop: browser membership changed')
        }
      }
    } catch (_authorizationUnavailable) {
      if (epoch === this.epoch) await this.invalidate()
    } finally {
      this.checking = false
      this.scheduleRecheck()
    }
  }

  /**
   * Permanently close this window's browser admission; failed retirement remains retryable.
   * @returns After aborting observations and retiring all owned guest storage.
   */
  dispose(): Promise<void> {
    this.stopped = true
    return this.invalidate()
  }
}
