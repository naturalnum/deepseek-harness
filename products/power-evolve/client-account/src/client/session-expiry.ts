/** Native identity checks are independent of resource-level Remote failures. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountHttpError, type AccountHttpClient, type CurrentAccount } from './account-api.ts'

/** Confirmed expiry and the current attempt to open configured trusted sign-in. */
export interface AccountExpiryView {
  readonly findingLogin: boolean
  readonly loginUnavailable: boolean
}

/** Product policy over the existing Connection lifecycle and personal identity endpoint. */
export interface AccountSessionOptions {
  readonly connection: Pick<ConnectionHandle, 'state' | 'stop'>
  readonly client: Pick<AccountHttpClient, 'me' | 'loginUrl'>
  readonly navigate: (url: string) => void
  /** Replace the current native document to discard the previous account's retained views. */
  readonly resetDocument: () => void
}

/** Owns cancellable identity/navigation reads and stops revoked native login connections. */
export class AccountSession {
  private readonly lifetime = new AbortController()
  private probe: AbortController | undefined
  private destination: Promise<string | undefined> | undefined
  private loginUrl: string | undefined
  private expired = false
  private userId: CurrentAccount['userId'] | undefined
  private resetRequested = false
  private redirecting = false
  private snapshot: AccountExpiryView | undefined
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | undefined

  /** Stable source bound by the Slot renderer into the account expiry hook. */
  readonly view: HostObservable<AccountExpiryView | undefined> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
  }

  constructor(private readonly options: AccountSessionOptions) {}

  /** Observe connection changes and acquire the configured sign-in address.
   * @returns disposer cancelling all reads and withdrawing the listener.
   */
  start(): () => void {
    this.unsubscribe = this.options.connection.state.subscribe(this.connectionChanged)
    void this.destinationUrl()
    this.check()
    return () => {
      this.lifetime.abort(); this.probe?.abort(); this.unsubscribe?.()
      this.listeners.clear()
    }
  }

  /** Keep a retired page stopped when its Connection owner activates after expiry or an account change. */
  private connectionChanged = (): void => {
    if (this.lifetime.signal.aborted) return
    if (this.expired || this.resetRequested) {
      if (this.options.connection.state.getSnapshot() !== undefined) this.options.connection.stop()
      return
    }
    this.check()
  }

  /** Bind the first confirmed account to this document; a later account change stops its Connection and resets it. */
  check = (): void => {
    if (this.expired || this.resetRequested || this.lifetime.signal.aborted || this.probe) return
    const controller = new AbortController()
    this.probe = controller
    void this.options.client.me(controller.signal).then(user => {
      if (controller.signal.aborted || this.lifetime.signal.aborted || this.expired || this.resetRequested) return
      if (this.userId === undefined) {
        this.userId = user.userId
        return
      }
      if (this.userId === user.userId) return
      this.resetRequested = true
      controller.abort()
      this.options.connection.stop()
      this.options.resetDocument()
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !this.lifetime.signal.aborted
        && error instanceof AccountHttpError && error.status === 401) this.confirmExpired()
    }).finally(() => { if (this.probe === controller) this.probe = undefined })
  }

  /** Handle a 401 confirmed by the independent personal identity request. */
  confirmExpired = (): void => {
    if (this.expired || this.resetRequested || this.lifetime.signal.aborted) return
    this.expired = true
    this.probe?.abort()
    this.options.connection.stop()
    void this.returnToLogin()
  }

  /** Retry configured navigation after expiry without issuing further identity requests. */
  returnToLogin = async (): Promise<void> => {
    if (!this.expired || this.redirecting || this.lifetime.signal.aborted) return
    this.redirecting = true
    this.publish({ findingLogin: true, loginUnavailable: false })
    try {
      const url = await this.destinationUrl()
      if (this.lifetime.signal.aborted) return
      if (!url) { this.publish({ findingLogin: false, loginUnavailable: true }); return }
      this.options.navigate(url)
      this.publish({ findingLogin: false, loginUnavailable: false })
    } catch {
      if (!this.lifetime.signal.aborted) this.publish({ findingLogin: false, loginUnavailable: true })
    } finally { this.redirecting = false }
  }

  private destinationUrl(): Promise<string | undefined> {
    if (this.loginUrl) return Promise.resolve(this.loginUrl)
    if (this.destination) return this.destination
    const pending = this.options.client.loginUrl(this.lifetime.signal).then(url => {
      if (this.lifetime.signal.aborted || this.resetRequested) return undefined
      this.loginUrl = url
      return url
    }, () => undefined).finally(() => { if (this.destination === pending) this.destination = undefined })
    this.destination = pending
    return pending
  }

  private publish(snapshot: AccountExpiryView): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try { listener() }
      catch { console.error('PowerEvolve account expiry listener failed') }
    }
  }
}
