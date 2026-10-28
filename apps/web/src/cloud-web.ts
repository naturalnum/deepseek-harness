/** Existing Web entry ownership for real Cookie login, canonical preparation and joined native exit. */
import { AppWebEntry, getStaticModules } from '@deepseek-ai/dsh-client-web'
import type { ClientModuleLoader, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import { parseCloudWebManifest } from '@deepseek-ai/dsh-pe-cloud-client/schema'
import type { CloudWebManifest } from '@deepseek-ai/dsh-pe-cloud-client/types'
import type { CloudPagePreparation, PreparedCloudPage } from '@deepseek-ai/dsh-pe-cloud-client/client'
import { cloudWebCopy } from './locales.ts'
import styles from './cloud-web.module.css'

type CloudModule = Pick<typeof import('@deepseek-ai/dsh-pe-cloud-client/client'), 'PreparedCloudPage' | 'ClientFailure'>
type Phase = 'checking' | 'login' | 'signing-in' | 'starting' | 'running' | 'stopping'
  | 'unavailable' | 'stopped' | 'auth-unknown' | 'logout-unknown' | 'unconfirmed'
type AuthOutcome = 'accepted' | 'denied' | 'unknown' | 'request-too-large'

function readModule(value: unknown): CloudModule {
  if (value === null || typeof value !== 'object' || !('PreparedCloudPage' in value)
    || typeof value.PreparedCloudPage !== 'function' || !('prepare' in value.PreparedCloudPage)
    || typeof value.PreparedCloudPage.prepare !== 'function'
    || !('ClientFailure' in value) || typeof value.ClientFailure !== 'function') {
    throw new TypeError('Cloud Web module does not provide the public prepared entry')
  }
  return value as CloudModule
}

/** One document's entry controller; no account identity is stored outside its prepared owner. */
export class CloudWebEntry {
  private readonly root: HTMLElement
  private readonly input: unknown
  private readonly doc: Document
  private readonly shell: HTMLDivElement
  private readonly brand: HTMLElement
  private readonly chrome: HTMLElement
  private readonly content: HTMLElement
  private readonly form: HTMLFormElement
  private readonly title: HTMLHeadingElement
  private readonly description: HTMLParagraphElement
  private readonly emailLabel: HTMLSpanElement
  private readonly passwordLabel: HTMLSpanElement
  private readonly emailField: HTMLLabelElement
  private readonly passwordField: HTMLLabelElement
  private readonly email: HTMLInputElement
  private readonly password: HTMLInputElement
  private readonly submit: HTMLButtonElement
  private readonly exit: HTMLButtonElement
  private readonly check: HTMLButtonElement
  private readonly notice: HTMLParagraphElement
  private readonly previewNotice: HTMLParagraphElement
  private readonly localeObserver: MutationObserver
  private readonly lifetime = new AbortController()
  private readonly fetch = globalThis.fetch.bind(globalThis)
  private manifest: CloudWebManifest | undefined
  private modules: ClientModuleLoader | undefined
  private cloud: CloudModule | undefined
  private preparation: CloudPagePreparation | undefined
  private importWork: Promise<CloudModule> | undefined
  private authWork: Promise<AuthOutcome> | undefined
  private authAbort: AbortController | undefined
  private authPending = false
  private running: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private logoutWork: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private stopping = false
  private disposed = false
  private phase: Phase = 'checking'
  private issue: 'invalidCredentials' | 'requestTooLarge' | 'previewClosed' | 'previewDenied' | undefined
  private nativeLanguage = false

  /**
   * Draw the unauthenticated entry without starting native plugins or reading storage.
   * @param root - original native Web mount point.
   * @param input - the optional Host's public deployment injection.
   */
  constructor(root: HTMLElement, input: unknown) {
    this.root = root
    this.input = input
    this.doc = root.ownerDocument
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
      const node = this.doc.createElement(tag)
      if (className !== undefined) node.className = className
      return node
    }
    this.shell = element('div', styles.shell)
    this.brand = element('header', styles.brand)
    this.chrome = element('header', styles.chrome)
    this.content = element('main', styles.content)
    this.form = element('form', styles.card)
    this.title = element('h1', styles.title)
    this.description = element('p', styles.description)
    this.emailField = element('label', styles.field)
    this.passwordField = element('label', styles.field)
    this.emailLabel = element('span')
    this.passwordLabel = element('span')
    this.email = element('input', styles.input)
    this.email.type = 'email'
    this.email.placeholder = ' '
    this.email.autocomplete = 'username'
    this.email.required = true
    this.password = element('input', styles.input)
    this.password.type = 'password'
    this.password.placeholder = ' '
    this.password.autocomplete = 'current-password'
    this.password.required = true
    this.submit = element('button', styles.button)
    this.submit.type = 'submit'
    this.exit = element('button', styles.button)
    this.exit.type = 'button'
    this.check = element('button', styles.button)
    this.check.type = 'button'
    this.notice = element('p', styles.notice)
    this.notice.setAttribute('role', 'status')
    this.notice.setAttribute('aria-live', 'polite')
    this.previewNotice = element('p', styles.notice)
    this.previewNotice.setAttribute('role', 'status')
    this.previewNotice.setAttribute('aria-live', 'polite')
    this.emailField.append(this.email, this.emailLabel)
    this.passwordField.append(this.password, this.passwordLabel)
    this.form.append(this.emailField, this.passwordField, this.submit, this.notice, this.check)
    this.chrome.append(this.previewNotice, this.exit)
    this.content.append(this.title, this.description, this.form)
    root.before(this.shell)
    root.classList.add(styles.native as string)
    this.shell.append(this.brand, this.chrome, this.content, root)
    this.form.addEventListener('submit', this.onSubmit)
    this.exit.addEventListener('click', this.onExit)
    this.check.addEventListener('click', this.onCheck)
    this.doc.defaultView?.addEventListener('pagehide', this.onPageHide)
    this.localeObserver = new MutationObserver(() => {
      this.nativeLanguage = true
      this.render()
    })
    this.localeObserver.observe(this.doc.documentElement, { attributes: true, attributeFilter: ['lang'] })
    this.render()
  }

  /**
   * Materialize the original public table and try canonical Cookie bootstrap once.
   * @returns startup observation; unavailable authentication/backend stays visible in the entry.
   */
  run(): Promise<void> {
    if (this.running !== undefined) return this.running
    return this.running = this.start()
  }

  private isStopping(): boolean { return this.stopping }
  private isDisposed(): boolean { return this.disposed }

  private async start(): Promise<void> {
    try {
      this.manifest = parseCloudWebManifest(this.input)
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      if (this.isStopping()) return
      const win = globalThis as DshWindow
      if (win.__ModuleLoader__ === undefined) throw new Error('Cloud Web module bootstrap is missing')
      this.modules = win.__ModuleLoader__.create({ boot: win.__DSH_BOOT__, staticModules: getStaticModules() })
      const connection = '@deepseek-ai/dsh-client-connection'
      if (!this.modules.manifest.modules.some(row => row.id === connection)
        || this.modules.manifest.plugins.some(row => row.id === connection)) {
        throw new Error('Cloud Web requires module-only native Connection')
      }
      this.importWork = this.modules.import('@deepseek-ai/dsh-pe-cloud-client/client', this.doc.baseURI, {}).then(readModule)
      this.cloud = await this.importWork
      if (!this.isStopping()) await this.prepareNative()
    } catch (_error: unknown) {
      if (!this.isStopping()) this.setPhase('unavailable')
    }
  }

  private baseUrl(): string {
    const location = this.doc.location
    if (!['http:', 'https:'].includes(location.protocol)) {
      throw new Error('Cloud Web requires its fixed same-origin HTTP entry')
    }
    return new URL('/', location.href).href
  }

  private async prepareNative(): Promise<void> {
    const manifest = this.manifest, cloud = this.cloud, modules = this.modules
    if (manifest === undefined || cloud === undefined || modules === undefined || this.isStopping()) return
    this.setPhase('checking')
    let page: PreparedCloudPage | undefined
    let preparation: CloudPagePreparation | undefined
    try {
      const open = this.doc.defaultView?.open.bind(this.doc.defaultView)
      preparation = cloud.PreparedCloudPage.prepare({
        baseUrl: this.baseUrl(), config: manifest.client, decodeLimits: manifest.decodeLimits,
        persistenceLimits: manifest.persistenceLimits, fields: manifest.fields,
        storage: globalThis.localStorage, fetch: this.fetch, createWebSocket: url => new WebSocket(url),
        ...open === undefined ? {} : { previewNavigation: {
          open: (url: string) => {
            if (this.stopping || this.disposed || this.phase !== 'running') throw new cloud.ClientFailure('closed')
            open(url, '_blank', 'noopener,noreferrer')
            this.issue = undefined
            this.render()
          },
          refused: (code: 'closed' | 'target-denied') => {
            this.issue = code === 'closed' ? 'previewClosed' : 'previewDenied'
            this.render()
          },
        } },
      }, this.lifetime.signal)
      this.preparation = preparation
      page = await preparation.ready
      await preparation.settled
      if (this.isStopping()) return
      this.setPhase('starting')
      const beforeDispose = page.nativeOptions.beforeDispose
      const entry = new AppWebEntry(this.root, {
        ...page.nativeOptions, modules,
        beforeDispose: () => {
          try { beforeDispose() }
          finally {
            this.stopping = true
            queueMicrotask(() => { this.observeNativeStop() })
          }
        },
      })
      await page.start(entry)
      if (!this.isStopping()) this.setPhase('running')
    } catch (error: unknown) {
      try { await preparation?.dispose() }
      catch (_cleanupError: unknown) { this.setPhase('unconfirmed'); return }
      if (this.isStopping()) return
      this.preparation = undefined
      if (page === undefined && error instanceof cloud.ClientFailure && error.code === 'unauthenticated') {
        this.setPhase('login')
      } else this.setPhase('unavailable')
    }
  }

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault()
    if (this.phase !== 'login' || this.authPending || this.stopping) return
    const body = JSON.stringify({ email: this.email.value, password: this.password.value, rememberMe: false })
    this.password.value = ''
    this.issue = undefined
    this.setPhase('signing-in')
    void this.signIn(body)
  }

  private async signIn(body: string): Promise<void> {
    try {
      const result = await this.authenticate('sign-in/email', body)
      if (this.stopping || this.disposed) return
      if (result === 'accepted') await this.prepareNative()
      else if (result === 'denied' || result === 'request-too-large') {
        this.issue = result === 'denied' ? 'invalidCredentials' : 'requestTooLarge'
        this.setPhase('login')
      } else this.setPhase('auth-unknown')
    } catch (_cleanupError: unknown) { this.setPhase('unconfirmed') }
  }

  private authenticate(path: 'sign-in/email' | 'sign-out', body: string): Promise<AuthOutcome> {
    const manifest = this.manifest
    if (manifest === undefined || this.authPending) return Promise.resolve('unknown')
    if (new TextEncoder().encode(body).byteLength > manifest.auth.maxRequestBytes) return Promise.resolve('request-too-large')
    const abort = new AbortController()
    this.authAbort = abort
    this.authPending = true
    this.render()
    const timer = setTimeout(() => {
      abort.abort()
      if (!this.disposed) this.setPhase(path === 'sign-out' ? 'logout-unknown' : 'auth-unknown')
    }, manifest.auth.requestTimeoutMs)
    const actual = (async (): Promise<AuthOutcome> => {
      let response: Response | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let cancelBody: (() => Promise<void>) | undefined
      const onAbort = (): void => {
        void cancelBody?.().catch((_error: unknown) => {
          // The original cancellation is joined below before this request settles.
        })
      }
      abort.signal.addEventListener('abort', onAbort, { once: true })
      try {
        response = await this.fetch(new URL('cloud/auth/' + path, this.baseUrl()), {
          method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { 'content-type': 'application/json' }, body, signal: abort.signal,
        })
        reader = response.body?.getReader()
        let size = 0
        if (reader !== undefined) {
          const owned = reader
          const terminal = owned.closed.then(() => ({ errored: false as const }),
            (reason: unknown) => ({ errored: true as const, reason }))
          let cancellation: Promise<void> | undefined
          cancelBody = () => cancellation ??= owned.cancel(abort.signal.reason).catch(async (failure: unknown) => {
            const closed = await terminal
            if (!closed.errored || !abort.signal.aborted
              || closed.reason !== abort.signal.reason || failure !== abort.signal.reason) throw failure
          })
          if (abort.signal.aborted) onAbort()
          while (true) {
            abort.signal.throwIfAborted()
            const next = await reader.read()
            abort.signal.throwIfAborted()
            if (next.done) break
            size += next.value.byteLength
            if (size > manifest.auth.maxResponseBytes) throw new Error('Cloud auth response exceeds its public byte budget')
          }
        }
        abort.signal.throwIfAborted()
        if (response.ok) return 'accepted'
        return path === 'sign-in/email' && [400, 401, 422].includes(response.status) ? 'denied' : 'unknown'
      } catch (_error: unknown) {
        try {
          if (cancelBody !== undefined) await cancelBody()
          else await response?.body?.cancel()
        } catch (_cleanupError: unknown) { throw new Error('Cloud auth body cleanup was not confirmed') }
        return 'unknown'
      } finally {
        abort.signal.removeEventListener('abort', onAbort)
        reader?.releaseLock()
        clearTimeout(timer)
        this.authPending = false
        this.render()
      }
    })()
    this.authWork = actual
    return actual
  }

  private stopLocal(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    this.stopping = true
    this.lifetime.abort()
    this.authAbort?.abort()
    const stopping = this.preparation?.dispose()
    const actual = Promise.allSettled([stopping, this.importWork, this.authWork]).then((results) => {
      const failures: unknown[] = []
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Cloud Web cleanup was not confirmed')
    })
    void actual.then(completion.resolve, completion.reject)
    return this.closing
  }

  private observeNativeStop(): void {
    if (this.disposed || this.logoutWork !== undefined) return
    this.setPhase('stopping')
    void this.stopLocal().then(() => {
      if (!this.disposed && this.logoutWork === undefined) this.setPhase('stopped')
    }, (_error: unknown) => { this.setPhase('unconfirmed') })
  }

  private readonly onExit = (): void => {
    if (this.authPending || this.logoutWork !== undefined || this.phase === 'unconfirmed') return
    this.logoutWork = this.logout()
  }

  private async logout(): Promise<void> {
    this.setPhase('stopping')
    try {
      await this.stopLocal()
      if (this.isDisposed()) return
      const result = await this.authenticate('sign-out', '{}')
      if (this.isDisposed()) return
      if (result !== 'accepted') { this.setPhase('logout-unknown'); return }
      this.doc.location.replace(this.baseUrl())
    } catch (_error: unknown) { this.setPhase('unconfirmed') }
  }

  private readonly onCheck = (): void => {
    if (this.authPending || this.phase === 'unconfirmed') return
    void this.stopLocal().then(() => {
      if (!this.isDisposed()) this.doc.location.reload()
    }, (_error: unknown) => { this.setPhase('unconfirmed') })
  }

  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) return
    this.setPhase('stopping')
    void this.stopLocal().then(() => { this.setPhase('stopped') }, (_error: unknown) => { this.setPhase('unconfirmed') })
  }

  /**
   * Revoke and join the actual prepared/native/auth work, then remove entry-owned listeners.
   * @returns actual local cleanup; this does not send or claim server sign-out.
   * @throws Error while an original body, native disposer or persistence cleanup remains unconfirmed.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.authAbort?.abort()
    this.disposal = (async () => {
      const results = await Promise.allSettled([this.stopLocal(), this.authWork])
      this.localeObserver.disconnect()
      this.form.removeEventListener('submit', this.onSubmit)
      this.exit.removeEventListener('click', this.onExit)
      this.check.removeEventListener('click', this.onCheck)
      this.doc.defaultView?.removeEventListener('pagehide', this.onPageHide)
      const failures: unknown[] = []
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Cloud Web cleanup was not confirmed')
    })()
    return this.disposal
  }

  private setPhase(phase: Phase): void {
    if (this.disposed) return
    this.phase = phase
    this.render()
  }

  private render(): void {
    if (this.disposed) return
    const copy = cloudWebCopy(this.nativeLanguage ? this.doc.documentElement.lang : this.doc.defaultView?.navigator.language ?? 'en')
    const login = this.phase === 'login' || this.phase === 'signing-in'
    const pending = ['checking', 'signing-in', 'starting', 'stopping'].includes(this.phase)
    this.shell.dataset['state'] = this.phase
    this.brand.textContent = copy.product
    this.title.textContent = copy.title
    this.description.textContent = copy.description
    this.emailLabel.textContent = copy.email
    this.passwordLabel.textContent = copy.password
    this.submit.textContent = copy.signIn
    this.exit.textContent = copy.signOut
    const previewIssue = this.issue === 'previewClosed' || this.issue === 'previewDenied' ? this.issue : undefined
    this.previewNotice.hidden = previewIssue === undefined
    this.previewNotice.textContent = previewIssue === undefined ? '' : copy[previewIssue]
    this.check.textContent = copy.check
    this.emailField.hidden = !login
    this.passwordField.hidden = !login
    this.submit.hidden = !login
    this.email.disabled = this.phase !== 'login'
    this.password.disabled = this.phase !== 'login'
    this.submit.disabled = this.phase !== 'login' || this.authPending
    this.exit.disabled = pending || this.authPending || this.logoutWork !== undefined || this.phase === 'unconfirmed'
    this.chrome.hidden = login || this.phase === 'checking'
    this.brand.hidden = !login
    this.description.hidden = !login
    this.check.hidden = login || pending || this.phase === 'running'
    this.check.disabled = this.authPending || this.phase === 'unconfirmed'
    this.content.hidden = this.phase === 'running' || this.phase === 'starting'
    this.root.hidden = this.phase !== 'running' && this.phase !== 'starting'
    const messages: Partial<Record<Phase, string>> = {
      unavailable: copy.unavailable, stopped: copy.stopped, 'auth-unknown': copy.authUnknown,
      'logout-unknown': copy.logoutUnknown, unconfirmed: copy.unconfirmed,
    }
    this.notice.textContent = pending ? copy.pending : this.issue === undefined ? messages[this.phase] ?? '' : copy[this.issue]
    this.form.setAttribute('aria-busy', String(pending || this.authPending))
  }
}
