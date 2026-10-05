/** Main-process ownership and isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, webContents, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** Additional application endpoints denied for guest navigation and network requests. */
export interface DesktopBrowserGuestPolicy {
  /** Return true to deny a parsed URL in addition to the fixed guest restrictions. */
  readonly rejectsUrl?: (url: URL) => boolean
}

interface Workspace {
  readonly partition: string
  readonly session: Session
  readonly guests: Set<Guest>
  retirement?: Promise<void>
}
interface GuestLease {
  readonly owner: WebContents
  readonly workspace: Workspace
  attached: boolean
  accepting: boolean
  closing: boolean
  guest?: Guest
  attachment?: Promise<void>
  finishAttachment?: () => void
  release?: Promise<void>
}
interface Guest {
  readonly contents: WebContents
  readonly owner: WebContents
  readonly workspace: Workspace
  readonly destroyed: Promise<void>
  dead: boolean
  ready: boolean
  creating: boolean
  lease?: DesktopBrowserLeaseId
  releaseInput?: () => void
  inputError?: unknown
  close?: Promise<void>
}

/** Owns workspace storage independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly workspaces = new Map<string, Workspace>()
  private readonly retired = new Set<Workspace>()
  private readonly retiredKeys = new Set<string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly guests = new Map<WebContents, Guest>()
  private readonly disposedOwners = new WeakSet<WebContents>()
  private readonly bindings = new Map<WebContents, () => Promise<void>>()

  /**
   * @param hostUrl - current authenticated DSH Host, which guests cannot request.
   * @param policy - optional additional endpoint restrictions owned by the application.
   */
  constructor(private readonly hostUrl: () => string | undefined, private readonly policy: DesktopBrowserGuestPolicy = {}) {}

  /**
   * Reserve one guest in a workspace's process-lifetime partition; retired keys always reject.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    if (owner.isDestroyed() || this.disposedOwners.has(owner)) throw new Error('desktop browser: window is disposed')
    if (this.retiredKeys.has(workspace)) throw new Error('desktop browser: workspace is retired')
    let state = this.workspaces.get(workspace)
    if (state === undefined) {
      const partition = `dsh-sidebar-browser-${randomUUID()}`
      state = { partition, session: session.fromPartition(partition), guests: new Set() }
      this.configureSession(state)
      this.workspaces.set(workspace, state)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, workspace: state, attached: false, accepting: false, closing: false })
    return { lease, partition: state.partition }
  }

  /**
   * Release only the owner's lease, awaiting native destruction while retaining workspace storage.
   * Concurrent calls share the close; a failed close retains ownership and can be retried.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   * @returns completion of input disposal and native destruction.
   */
  release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') return Promise.reject(new Error('desktop browser: invalid guest lease'))
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return Promise.resolve()
    if (lease.owner !== owner) return Promise.reject(new Error('desktop browser: guest belongs to another window'))
    if (lease.release !== undefined) return lease.release
    lease.closing = true
    const closing = lease.guest !== undefined ? this.closeGuest(lease.guest)
      : (lease.attachment ?? Promise.resolve()).then(async () => {
        if (lease.guest !== undefined) await this.closeGuest(lease.guest)
      })
    lease.release = closing.then(() => {
      if (this.leases.get(key) === lease) this.leases.delete(key)
    }).catch((error: unknown) => { delete lease.release; throw error })
    return lease.release
  }

  /**
   * Permanently block a workspace key, destroy all its guests, and clear its Session data.
   * This privileged main-process operation is never registered as renderer IPC. Failures
   * retain the blocked Session and guest ownership; call again to retry cleanup.
   * @param workspace - main-owned workspace identity or authentication epoch namespace.
   * @returns completion of native destruction, connection closure, storage and cache cleanup.
   */
  retireWorkspace(workspace: string): Promise<void> {
    this.retiredKeys.add(workspace)
    const state = this.workspaces.get(workspace)
    if (state === undefined) return Promise.resolve()
    this.retired.add(state)
    if (state.retirement !== undefined) return state.retirement
    this.scanGuests()
    const pending = [...this.leases].filter(([, lease]) => lease.workspace === state)
      .map(([id, lease]) => this.release(lease.owner, id))
    pending.push(...[...state.guests].map(guest => this.closeGuest(guest)))
    state.retirement = (async () => {
      this.throwFailures(await Promise.allSettled(pending))
      this.scanGuests()
      this.throwFailures(await Promise.allSettled([...state.guests].map(guest => this.closeGuest(guest))))
      await state.session.closeAllConnections()
      state.session.flushStorageData()
      this.throwFailures(await Promise.allSettled([
        state.session.clearStorageData(), state.session.clearCache(), state.session.clearAuthCache(),
        state.session.clearSharedDictionaryCache(),
      ]))
    })().catch((error: unknown) => { delete state.retirement; throw error })
    return state.retirement
  }

  /**
   * Check attachments before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches input to a verified ready guest and returns a single-use disposer.
   * @returns async disposer that blocks this binding, closes its guests, then removes tracking listeners.
   * Live disposed windows continue denying webviews. Owner destruction invokes the same disposer;
   * failed closure leaves tracking installed for retry.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): () => Promise<void> {
    const owner = window.webContents
    if (this.disposedOwners.has(owner)) throw new Error('desktop browser: window is disposed')
    const existing = this.bindings.get(owner)
    if (existing !== undefined) return existing
    let disposing = false
    let disposal: Promise<void> | undefined
    const created = (_event: Electron.Event, contents: WebContents): void => {
      if (!contents.isDestroyed() && contents.getType() === 'webview' && contents.hostWebContents === owner) this.trackGuest(contents, owner)
    }
    const willAttach = (event: Electron.Event, preferences: Electron.WebPreferences, params: Record<string, string>): void => {
      const id = this.bootstrapLease(params.src)
      const lease = id === undefined ? undefined : this.leases.get(id)
      if (disposing || lease === undefined || lease.owner !== owner || lease.attached || lease.closing
        || this.retired.has(lease.workspace) || params.partition !== lease.workspace.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      lease.accepting = true
      lease.attachment = new Promise((resolve) => { lease.finishAttachment = resolve })
      // Electron creates the guest and starts its bootstrap navigation before returning
      // from will-attach. Keep unresolved identities until their actual guest settles.
      queueMicrotask(() => { lease.accepting = false; this.finishAttachments(lease.workspace, owner) })
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.workspace.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    }
    const didAttach = (_event: Electron.Event, contents: WebContents): void => {
      const guest = this.trackGuest(contents, owner)
      if (guest === undefined) { contents.close({ waitForBeforeUnload: false }); return }
      guest.creating = false
      contents.once('dom-ready', () => {
        this.identifyGuest(guest, contents.getURL())
        const id = guest.lease
        const lease = id === undefined ? undefined : this.leases.get(id)
        if (disposing || guest.dead || id === undefined || lease === undefined || lease.closing
          || this.retired.has(guest.workspace) || owner.isDestroyed()) {
          void this.closeGuest(guest).catch((error: unknown) => { console.error(error) })
          return
        }
        guest.ready = true
        guest.releaseInput = attachInput(contents, id)
      })
    }
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (event.isMainFrame && !event.isSameDocument) releaseAll()
    }
    const destroyed = (): void => { void dispose().catch((error: unknown) => { console.error(error) }) }
    const dispose = (): Promise<void> => {
      if (disposal !== undefined) return disposal
      disposing = true
      this.disposedOwners.add(owner)
      this.scanGuests()
      const pending = [...this.leases].filter(([, lease]) => lease.owner === owner)
        .map(([id]) => this.release(owner, id))
      pending.push(...[...this.guests.values()].filter(guest => guest.owner === owner).map(guest => this.closeGuest(guest)))
      disposal = Promise.allSettled(pending).then((results) => {
        this.throwFailures(results)
        app.removeListener('web-contents-created', created)
        owner.removeListener('will-attach-webview', willAttach)
        if (!owner.isDestroyed()) {
          const deny = (event: Electron.Event): void => { event.preventDefault() }
          owner.on('will-attach-webview', deny)
          owner.once('destroyed', () => { owner.removeListener('will-attach-webview', deny) })
        }
        owner.removeListener('did-attach-webview', didAttach)
        owner.removeListener('did-start-navigation', navigation)
        owner.removeListener('render-process-gone', releaseAll)
        owner.removeListener('destroyed', destroyed)
        this.bindings.delete(owner)
      }).catch((error: unknown) => { disposal = undefined; throw error })
      return disposal
    }
    this.bindings.set(owner, dispose)
    app.on('web-contents-created', created)
    owner.on('will-attach-webview', willAttach)
    owner.on('did-attach-webview', didAttach)
    owner.on('did-start-navigation', navigation)
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', destroyed)
    return dispose
  }

  private scanGuests(): void {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.getType() === 'webview' && contents.hostWebContents !== null
        && this.bindings.has(contents.hostWebContents)) this.trackGuest(contents, contents.hostWebContents)
    }
  }

  private trackGuest(contents: WebContents, owner: WebContents): Guest | undefined {
    const existing = this.guests.get(contents)
    if (existing !== undefined) return existing
    const workspace = [...this.workspaces.values()].find(state => state.session === contents.session)
    if (workspace === undefined || contents.hostWebContents !== owner) return undefined
    let resolveDestroyed!: () => void
    const guest: Guest = { contents, owner, workspace, dead: contents.isDestroyed(), ready: false, creating: true,
      destroyed: new Promise((resolve) => { resolveDestroyed = resolve }) }
    this.guests.set(contents, guest)
    queueMicrotask(() => { guest.creating = false })
    workspace.guests.add(guest)
    const destroyed = (): void => {
      guest.dead = true
      this.disposeInput(guest)
      resolveDestroyed()
      if (guest.close === undefined && guest.inputError === undefined) this.forgetGuest(guest)
      this.finishAttachments(workspace, owner)
    }
    contents.once('destroyed', destroyed)
    contents.on('did-start-navigation', (event) => { if (event.isMainFrame) this.identifyGuest(guest, event.url) })
    contents.setWindowOpenHandler(({ url, postBody }) => {
      const id = guest.lease
      const lease = id === undefined ? undefined : this.leases.get(id)
      if (id !== undefined && lease?.guest === guest && guest.ready && !lease.closing && !this.retired.has(workspace)
        && !owner.isDestroyed() && postBody === undefined && this.allowedNavigation(url)) {
        const request: DesktopBrowserOpenRequest = { lease: id, url: new URL(url).href }
        owner.send(DESKTOP_IPC.browserOpenRequested, request)
      }
      return { action: 'deny' }
    })
    contents.on('will-frame-navigate', (event) => {
      if (this.retired.has(workspace) || (event.isMainFrame && !this.allowedNavigation(event.url))) event.preventDefault()
    })
    contents.on('will-redirect', (event, url, _inPlace, mainFrame) => {
      if (this.retired.has(workspace) || (mainFrame && !this.allowedNavigation(url))) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => { event.preventDefault() })
    contents.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    this.identifyGuest(guest, contents.getURL())
    if (guest.dead) destroyed()
    if (this.retired.has(workspace)) void this.closeGuest(guest).catch((error: unknown) => { console.error(error) })
    return guest
  }

  private identifyGuest(guest: Guest, url: string): void {
    if (guest.lease !== undefined || guest.dead) return
    const id = this.bootstrapLease(url)
    const lease = id === undefined ? undefined : this.leases.get(id)
    if (id === undefined || lease === undefined || !lease.attached || lease.owner !== guest.owner
      || lease.workspace !== guest.workspace || lease.guest !== undefined) return
    guest.lease = id
    lease.guest = guest
    lease.finishAttachment?.()
    delete lease.finishAttachment
    this.finishAttachments(guest.workspace, guest.owner)
    if (lease.closing) void this.closeGuest(guest).catch((error: unknown) => { console.error(error) })
  }

  private finishAttachments(workspace: Workspace, owner: WebContents): void {
    if ([...workspace.guests].some(guest => guest.owner === owner && !guest.dead && guest.lease === undefined)) return
    for (const lease of this.leases.values()) {
      if (lease.workspace === workspace && lease.owner === owner && !lease.accepting) {
        lease.finishAttachment?.()
        delete lease.finishAttachment
      }
    }
  }

  private disposeInput(guest: Guest): void {
    const release = guest.releaseInput
    delete guest.releaseInput
    try { release?.() } catch (error: unknown) { guest.inputError = error }
  }

  private closeGuest(guest: Guest): Promise<void> {
    if (guest.close !== undefined) return guest.close
    let failed!: (error: unknown) => void
    const destruction = new Promise<void>((resolve, reject) => {
      failed = reject
      void guest.destroyed.then(resolve)
    })
    this.disposeInput(guest)
    const inputError = guest.inputError
    delete guest.inputError
    guest.close = destruction.then(() => {
      if (inputError !== undefined) throw inputError
      this.forgetGuest(guest)
    }).catch((error: unknown) => { delete guest.close; throw error })
    const requestClose = (): void => {
      try { if (!guest.dead) guest.contents.close({ waitForBeforeUnload: false }) } catch (error: unknown) { failed(error) }
    }
    // Closing during web-contents-created interrupts Electron's native attachment.
    if (guest.creating) queueMicrotask(requestClose)
    else requestClose()
    return guest.close
  }

  private forgetGuest(guest: Guest): void {
    this.guests.delete(guest.contents)
    guest.workspace.guests.delete(guest)
    const lease = guest.lease === undefined ? undefined : this.leases.get(guest.lease)
    if (guest.lease !== undefined && lease?.guest === guest && guest.ready && !lease.closing) this.leases.delete(guest.lease)
  }

  private throwFailures(results: PromiseSettledResult<void>[]): void {
    const failures = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'desktop browser: guest cleanup failed')
  }

  private bootstrapLease(url: string | undefined): DesktopBrowserLeaseId | undefined {
    return url?.startsWith('about:blank#') ? url.slice('about:blank#'.length) as DesktopBrowserLeaseId : undefined
  }

  private configureSession(workspace: Workspace): void {
    const browserSession = workspace.session
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: this.retired.has(workspace) || (network
        ? url.username !== '' || url.password !== '' || this.rejectsUrl(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol)) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '' && !this.rejectsUrl(url)
  }

  private rejectsUrl(url: URL): boolean {
    const value = this.hostUrl()
    if (value !== undefined) {
      const host = new URL(value)
      if (url.port === host.port
        && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return true
    }
    return this.policy.rejectsUrl?.(url) ?? false
  }
}
