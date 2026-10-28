// @vitest-environment jsdom
/** Source-component evidence with real ModuleSystem, Cloud preparation and native AppWebEntry; no production backend claim. */
import type { Context } from '@deepseek-ai/cordis'
import * as moduleClient from '@deepseek-ai/dsh-client-modules/client'
import type { ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import * as connection from '@deepseek-ai/dsh-client-connection/client'
import * as cloud from '@deepseek-ai/dsh-pe-cloud-client/client'
import type { CloudWebManifest } from '@deepseek-ai/dsh-pe-cloud-client/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudWebEntry } from '../src/cloud-web.ts'

const entries: CloudWebEntry[] = []
const win = globalThis as DshWindow

afterEach(async () => {
  await Promise.allSettled(entries.splice(0).map(entry => entry.dispose()))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete win.__ModuleLoader__
  delete win.__DSH_BOOT__
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

function manifest(): CloudWebManifest {
  return {
    client: { bootstrapPath: 'cloud/bootstrap', bootstrapTimeoutMs: 500, maxBootstrapResponseBytes: 8192,
      maxErrorResponseBytes: 512, maxPendingFetches: 8, maxSockets: 2, closeTimeoutMs: 500 },
    decodeLimits: { maxBodyBytes: 8192, maxStringBytes: 256, maxListItems: 32 },
    persistenceLimits: { maxKeys: 16, maxKeyBytes: 128, maxValueBytes: 4096, maxTotalBytes: 16384, maxNamespaceBytes: 256 },
    fields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    auth: { requestTimeoutMs: 500, maxRequestBytes: 4096, maxResponseBytes: 8192 },
  }
}

function metadata() {
  const disabled = { state: 'disabled', reason: 'not-approved' }
  return { account: { id: 'component-account', displayName: 'Component' }, recipeVersion: 'component-recipe', connectionGeneration: 'component-generation',
    capabilities: { projects: disabled, filePreview: disabled, shell: disabled, developmentServices: disabled,
      servicePreview: disabled, sandboxScope: 'session', backgroundJobs: false, localDesktop: false, arbitraryBackendPlugins: false,
      subprocess: { spawn: false, pipes: false, control: false, inherit: false, terminal: false, consumers: [] },
      configuration: { catalogVersion: 'component-catalog', plugins: [], skills: { manage: false }, credentials: { write: false }, fields: [] },
    },
  }
}

function pathOf(input: RequestInfo | URL): string {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, document.baseURI).pathname
}

/** Only network/module arrival and the finite renderer are fixtures; all prepared/native ownership is original source. */
function fixture(options: {
  fetch?: typeof globalThis.fetch
  manifest?: unknown
  nativeStop?: () => Promise<void>
  ordinaryConnection?: boolean
} = {}) {
  const calls: string[] = [], events: string[] = []
  const fetcher = vi.fn<typeof globalThis.fetch>(options.fetch ?? (async (input) => {
    calls.push(pathOf(input))
    return new Response(null, { status: 401 })
  }))
  vi.stubGlobal('fetch', fetcher)
  const mount = vi.fn()
  let native: Context | undefined
  const renderer = { inject: ['connection'], apply(ctx: Context) {
    native = ctx
    expect(ctx.get('peCloudPage')).toBeInstanceOf(cloud.PreparedCloudPage)
    ctx.reflect.provide('uiRenderer', { mount: (root: HTMLElement) => {
      mount()
      root.replaceChildren(document.createElement('article'))
      return () => { events.push('unmount'); root.replaceChildren() }
    } })
    ctx.effect(() => async () => { events.push('native-stop'); await options.nativeStop?.() }, 'component renderer stop')
  } }
  const ids = { cloud: '@deepseek-ai/dsh-pe-cloud-client', connection: '@deepseek-ai/dsh-client-connection', renderer: 'component-renderer' }
  const pendingQueue: ClientBundleRegistration[] = []
  const create = vi.fn((input: ClientModuleCreateOptions) => moduleClient.createClientModuleSystem(target, {
    id: '@deepseek-ai/dsh-client-modules', exports: moduleClient,
  }, { ...input, loadBundle: async () => {
    target.load({ id: ids.connection, factory: () => connection })
    target.load({ id: ids.cloud, factory: () => cloud })
    target.load({ id: ids.renderer, factory: () => renderer })
  } }))
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue,
    load: (registration) => { pendingQueue.push(registration) }, create,
  }
  win.__ModuleLoader__ = target
  win.__DSH_BOOT__ = {
    rev: 'component', entries: [
      { id: ids.connection, url: '/connection.js', rev: '1', activate: options.ordinaryConnection === true },
      { id: ids.cloud, url: '/cloud.js', rev: '1', external: [ids.connection + '/client'] },
      { id: ids.renderer, url: '/renderer.js', rev: '1' },
    ], batches: [{ phase: 'application', url: '/components.js', rev: '1', entries: Object.values(ids) }],
  }
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  const entry = new CloudWebEntry(root, options.manifest ?? manifest())
  entries.push(entry)
  const state = () => document.querySelector('[data-state]')?.getAttribute('data-state')
  return { entry, root, target, create, fetcher, calls, events, mount, state, native: () => native }
}

function submit(password = 'component-password'): void {
  document.querySelector<HTMLInputElement>('input[type=email]')!.value = 'component@example.test'
  document.querySelector<HTMLInputElement>('input[type=password]')!.value = password
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

function exit(): void { document.querySelector<HTMLButtonElement>('header button')!.click() }

describe('real source Cloud Web component', () => {
  it('opens the captured preview through the actual page carrier as an ordinary isolated GET navigation', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null), defaults = manifest(), data = metadata()
    const policy = { managementOrigin: new URL(document.baseURI).origin, previewOrigin: 'http://preview.localhost:3000',
      routePath: '/cloud/service-preview', maxFieldBytes: 128, maxUrlBytes: 2048 }
    const f = fixture({ manifest: { ...defaults, client: { ...defaults.client, servicePreview: policy } },
      fetch: async () => Response.json({ ...data, capabilities: { ...data.capabilities, servicePreview: { state: 'available' } } }) })
    await f.entry.run()
    expect(f.state()).toBe('running')
    const page = f.native()!.get('peCloudPage')!, navigate = page.servicePreviewNavigation
    if (navigate === undefined) throw new Error('Actual Cloud Web page did not supply its navigation carrier')
    navigate({ sessionId: SessionId('original-session'), serviceHandle: 'original-service' })
    expect(open).toHaveBeenCalledTimes(1)
    const [target, name, features] = open.mock.calls[0]!
    const url = new URL(String(target))
    expect([name, features]).toEqual(['_blank', 'noopener,noreferrer'])
    expect(url.origin + url.pathname).toBe(policy.previewOrigin + policy.routePath)
    expect(Object.fromEntries(url.searchParams)).toEqual({ sessionId: 'original-session', serviceHandle: 'original-service',
      peAccount: 'component-account', peGeneration: 'component-generation' })
    await page.dispose()
    navigate({ sessionId: SessionId('original-session'), serviceHandle: 'original-service' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(document.querySelector('header [role=status]')?.textContent).toBe(
      'This page has closed. Check your sign-in status before opening a preview.')
  })

  it('reports contained preview refusal in the visible localized chrome without exposing the rejected target', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => { throw new Error('private rejected target') })
    const defaults = manifest(), data = metadata()
    const f = fixture({ manifest: { ...defaults, client: { ...defaults.client, servicePreview: {
      managementOrigin: new URL(document.baseURI).origin, previewOrigin: 'http://preview.localhost:3000',
      routePath: '/cloud/service-preview', maxFieldBytes: 128, maxUrlBytes: 2048 } } },
    fetch: async () => Response.json({ ...data, capabilities: { ...data.capabilities, servicePreview: { state: 'available' } } }) })
    await f.entry.run()
    const navigate = f.native()!.get('peCloudPage')!.servicePreviewNavigation
    if (navigate === undefined) throw new Error('Actual Cloud Web page did not supply its navigation carrier')
    expect(() =>{  navigate({ sessionId: SessionId('original-session'), serviceHandle: 'original-service' }) }).not.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
    const notice = document.querySelector<HTMLElement>('header [role=status]')!
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toBe('The preview could not open. Check the service status and try again.')
    expect(notice.textContent).not.toContain('private rejected target')
    document.documentElement.lang = 'zh-CN'
    await expect.poll(() => notice.textContent).toBe('无法打开预览，请检查服务状态后重试')
  })

  it('shows localized login after canonical 401 without native startup or storage reads', async () => {
    const storage = vi.spyOn(Storage.prototype, 'getItem')
    const f = fixture()
    await f.entry.run()
    expect(f.state()).toBe('login')
    expect(f.calls).toEqual(['/cloud/bootstrap'])
    expect(f.mount).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledTimes(1)
    document.documentElement.lang = 'zh-CN'
    await expect.poll(() => document.querySelector('h1')?.textContent).toBe('进入你的云端工作空间')
    expect(document.querySelector('header')?.textContent).toBe('PowerEvolve')
    expect(document.querySelector('main > p')?.textContent).toBe('登录 PowerEvolve，继续你的项目、文件与 AI 对话。')
    expect(document.querySelector('input[type=email]')?.parentElement?.textContent).toContain('邮箱')
  })

  it('uses Cookie carriers and the original native table after a real canonical decode', async () => {
    const requests: { path: string; init: RequestInit | undefined }[] = []
    let bootstrap = 0
    const f = fixture({ fetch: async (input, init) => {
      const path = pathOf(input)
      requests.push({ path, init })
      if (path === '/cloud/bootstrap') return ++bootstrap === 1 ? new Response(null, { status: 401 }) : Response.json(metadata())
      return Response.json({ token: 'ignored-library-output' })
    } })
    await f.entry.run()
    submit()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await expect.poll(f.state).toBe('running')
    expect(requests.map(row => row.path)).toEqual(['/cloud/bootstrap', '/cloud/auth/sign-in/email', '/cloud/bootstrap'])
    expect(requests[1]!.init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    const body = requests[1]!.init?.body
    if (typeof body !== 'string') throw new Error('Expected the original auth request body')
    expect(JSON.parse(body)).toEqual({ email: 'component@example.test', password: 'component-password', rememberMe: false })
    expect(document.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('')
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.mount).toHaveBeenCalledTimes(1)
    expect(f.native()?.get('connection')).toBeDefined()
    expect(f.native()?.get('loader')?.internal).toBe(f.create.mock.results[0]?.value)
  })

  it('routes the sidebar sign-out through the original native join before Cookie logout without replay', async () => {
    const held = Promise.withResolvers<undefined>(), requests: string[] = []
    const signout = Promise.withResolvers<Response>()
    const f = fixture({ nativeStop: () => held.promise, fetch: async (input) => {
      const path = pathOf(input)
      requests.push(path)
      return path === '/cloud/bootstrap' ? Response.json(metadata()) : signout.promise
    } })
    await f.entry.run()
    const page = f.native()!.get('peCloudPage')!
    page.nativeOptions.persistence.setItem('component', 'value')
    expect(document.querySelector<HTMLElement>('header')!.hidden).toBe(true)
    const signOut = page.accountSignOut
    expect(signOut).toBeDefined()
    signOut!(f.native()!)
    expect(() => { signOut!(f.native()!) }).toThrow()
    expect(() => { page.nativeOptions.persistence.setItem('late', 'write') }).toThrow()
    await expect.poll(() => f.events.includes('native-stop')).toBe(true)
    expect(requests).toEqual(['/cloud/bootstrap'])
    held.resolve(undefined)
    await expect.poll(() => requests.includes('/cloud/auth/sign-out')).toBe(true)
    expect(f.events).toContain('unmount')
    expect(page.getSnapshot().phase).toBe('stopped')
    expect(requests.filter(path => path.endsWith('sign-out'))).toHaveLength(1)
    signout.resolve(new Response(null, { status: 503 }))
    await expect.poll(f.state).toBe('logout-unknown')
    exit()
    expect(requests.filter(path => path.endsWith('sign-out'))).toHaveLength(1)
  })

  it('does not replay unknown sign-in or allow another identity while its real carrier remains pending', async () => {
    const held = Promise.withResolvers<Response>(), defaults = manifest()
    const config = { ...defaults, auth: { ...defaults.auth, requestTimeoutMs: 10 } }
    const f = fixture({ manifest: config, fetch: async input => pathOf(input) === '/cloud/bootstrap'
      ? new Response(null, { status: 401 }) : held.promise })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    expect(document.querySelector<HTMLButtonElement>('header button')!.disabled).toBe(true)
    submit('another-account-password')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    let done = false
    const stopping = f.entry.dispose().then(() => { done = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(done).toBe(false)
    held.resolve(Response.json({ token: 'ignored-late-output' }))
    await stopping
    expect(f.mount).not.toHaveBeenCalled()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
  })

  it('joins late bootstrap arrival after cancellation without native activation', async () => {
    const held = Promise.withResolvers<Response>()
    const f = fixture({ fetch: async () => held.promise })
    const running = f.entry.run()
    await expect.poll(() => f.fetcher.mock.calls.length).toBe(1)
    let closed = false
    const stopping = f.entry.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    held.resolve(Response.json(metadata()))
    await Promise.all([running, stopping])
    expect(f.mount).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it.each([409, 503])('keeps rejected production-like bootstrap %s unavailable instead of inventing a login/account', async (status) => {
    const f = fixture({ fetch: async () => new Response(null, { status }) })
    await f.entry.run()
    expect(f.state()).toBe('unavailable')
    expect(f.mount).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden).toBe(true)
  })

  it('rejects malformed canonical metadata and an ordinary Connection graph before first native paint', async () => {
    const malformed = fixture({ fetch: async () => Response.json({ account: { id: 'invented' }, ready: true }) })
    await malformed.entry.run()
    expect(malformed.state()).toBe('unavailable')
    expect(malformed.mount).not.toHaveBeenCalled()
    await malformed.entry.dispose()
    document.body.replaceChildren()
    const ordinary = fixture({ ordinaryConnection: true })
    await ordinary.entry.run()
    expect(ordinary.state()).toBe('unavailable')
    expect(ordinary.fetcher).not.toHaveBeenCalled()
  })

  it('rejects unsupported manifest identity fields before table creation or HTTP', async () => {
    const f = fixture({ manifest: { ...manifest(), currentAccount: 'invented' } })
    await f.entry.run()
    expect(f.state()).toBe('unavailable')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('contains rejected sign-in and over-budget input without losing the login form', async () => {
    const defaults = manifest()
    const config = { ...defaults, auth: { ...defaults.auth, maxRequestBytes: 180 } }
    const f = fixture({ manifest: config })
    await f.entry.run()
    submit('p'.repeat(500))
    await expect.poll(() => document.querySelector('form [role=status]')?.textContent).toContain('too long')
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    submit()
    await expect.poll(() => document.querySelector('form [role=status]')?.textContent).toContain('refused')
    expect(f.state()).toBe('login')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
  })

  it('retains a failed auth body cancellation as unconfirmed cleanup and prevents sign-out', async () => {
    const defaults = manifest()
    const config = { ...defaults, auth: { ...defaults.auth, maxResponseBytes: 1 } }
    const f = fixture({ manifest: config, fetch: async input => pathOf(input) === '/cloud/bootstrap'
      ? new Response(null, { status: 401 }) : new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2])) },
        cancel() { return Promise.reject(new Error('component cancellation failure')) },
      })) })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('unconfirmed')
    exit()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    await expect(f.entry.dispose()).rejects.toThrow('cleanup was not confirmed')
  })

  it('observes a later canonical native stop without reopening login or replacing the account', async () => {
    const f = fixture({ fetch: async () => Response.json(metadata()) })
    await f.entry.run()
    const page = f.native()!.get('peCloudPage')!
    await page.lifetime.transport.close('unauthenticated')
    await expect.poll(f.state).toBe('stopped')
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden).toBe(true)
  })

  it.each([403, 409])('keeps sign-in HTTP %s in explicit recovery without another submit', async (status) => {
    const f = fixture({ fetch: async input => new Response(null, { status: pathOf(input) === '/cloud/bootstrap' ? 401 : status }) })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    submit('different-password')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.mount).not.toHaveBeenCalled()
  })

  it('preserves same-generation persistence when an ordinary refresh discards the document', async () => {
    const f = fixture({ fetch: async () => new Response(JSON.stringify(metadata())) })
    await f.entry.run()
    const persistence = f.native()?.get('clientPersistence')
    if (persistence === undefined) throw new Error('Original native persistence missing')
    persistence.setItem('refresh-marker', 'retained')
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    expect(f.state()).toBe('running')
    expect(persistence.getItem('refresh-marker')).toBe('retained')
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps a restored document stopped after pagehide without signing out or reusing its native graph', async () => {
    const f = fixture({ fetch: async () => Response.json(metadata()) })
    await f.entry.run()
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    await expect.poll(f.state).toBe('stopped')
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    expect(f.mount).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('header button')!.disabled).toBe(false)
  })

  it.each(['en-US', 'zh-CN'])('requires explicit sign-out after a confirmed stale-cookie refusal in %s', async (language) => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language)
    document.cookie = 'better-auth.session_token=expired-component-cookie; path=/'
    const signout = Promise.withResolvers<Response>()
    const f = fixture({ fetch: async input => pathOf(input) === '/cloud/bootstrap'
      ? new Response(null, { status: 401 }) : pathOf(input) === '/cloud/auth/sign-out' ? signout.promise
        : Response.json({ code: 'cloud/login-active', message: 'Server-owned text is not displayed.',
          requestId: 'e9c56643-82bc-44ab-aa94-d567862e01a3', retry: 'never' }, { status: 409 }) })
    try {
      await f.entry.run()
      submit()
      await expect.poll(f.state).toBe('login-active')
      expect(document.querySelector('form [role=status]')?.textContent).toBe(language === 'zh-CN'
        ? '此浏览器仍有登录记录，请先退出登录，再重新登录'
        : 'This browser still has a sign-in record. Sign out before signing in again.')
      expect(document.cookie).toContain('expired-component-cookie')
      expect(document.querySelector<HTMLButtonElement>('form button')!.hidden).toBe(true)
      expect(document.querySelector<HTMLButtonElement>('header button')!.disabled).toBe(false)
      submit('must-not-replay')
      expect(f.fetcher).toHaveBeenCalledTimes(2)
      expect(f.mount).not.toHaveBeenCalled()
      exit()
      await expect.poll(() => f.fetcher.mock.calls.filter(([input]) => pathOf(input) === '/cloud/auth/sign-out').length).toBe(1)
      expect(f.fetcher).toHaveBeenCalledTimes(3)
      signout.resolve(new Response(null, { status: 503 }))
      await expect.poll(f.state).toBe('logout-unknown')
    } finally {
      signout.resolve(new Response(null, { status: 503 }))
      document.cookie = 'better-auth.session_token=; Max-Age=0; path=/'
    }
  })

  it.each([
    { status: 409, body: JSON.stringify({ code: 'cloud/config-conflict', retry: 'never',
      requestId: 'e9c56643-82bc-44ab-aa94-d567862e01a3', message: 'other conflict' }) },
    { status: 409, body: JSON.stringify({ code: 'cloud/login-active' }) },
    { status: 409, body: JSON.stringify({ code: 'cloud/login-active', retry: 'after-status-check',
      requestId: 'e9c56643-82bc-44ab-aa94-d567862e01a3', message: 'not canonical' }) },
    { status: 409, body: JSON.stringify({ code: 'cloud/login-active', retry: 'never', requestId: 'invalid', message: 'not canonical' }) },
    { status: 503, body: JSON.stringify({ code: 'cloud/login-active', retry: 'never',
      requestId: 'e9c56643-82bc-44ab-aa94-d567862e01a3', message: 'wrong status' }) },
    { status: 409, body: '{"code":"cloud/login-active"' },
  ])('keeps unconfirmed conflict response $status/$body unknown without replay', async ({ status, body }) => {
    const f = fixture({ fetch: async input => pathOf(input) === '/cloud/bootstrap'
      ? new Response(null, { status: 401 }) : new Response(body, { status }) })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    submit('must-not-replay')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.mount).not.toHaveBeenCalled()
  })

  it('keeps an over-budget canonical login-active response unknown', async () => {
    const defaults = manifest(), body = JSON.stringify({ code: 'cloud/login-active', retry: 'never',
      requestId: 'e9c56643-82bc-44ab-aa94-d567862e01a3', message: 'bounded response' })
    const f = fixture({ manifest: { ...defaults, auth: { ...defaults.auth, maxResponseBytes: body.length - 1 } },
      fetch: async input => pathOf(input) === '/cloud/bootstrap' ? new Response(null, { status: 401 })
        : new Response(body, { status: 409 }) })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.mount).not.toHaveBeenCalled()
  })

  it('does not confirm login-active from a valid body prefix before actual EOF and timeout cleanup', async () => {
    const cancel = vi.fn(), defaults = manifest()
    const f = fixture({ manifest: { ...defaults, auth: { ...defaults.auth, requestTimeoutMs: 10 } },
      fetch: async input => pathOf(input) === '/cloud/bootstrap' ? new Response(null, { status: 401 })
        : new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 'cloud/login-active', retry: 'never',
            requestId: 'e9c56643-82bc-44ab-aa94-d567862e01a3', message: 'still not EOF' })))
        }, cancel }), { status: 409 }) })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    await expect.poll(() => cancel.mock.calls.length).toBe(1)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.mount).not.toHaveBeenCalled()
  })

  it('does not send sign-out when actual native child cleanup rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = fixture({ fetch: async () => Response.json(metadata()),
      nativeStop: async () => { throw new Error('component child stop failure') } })
    await f.entry.run()
    f.native()!.get('peCloudPage')!.accountSignOut!(f.native()!)
    await expect.poll(f.state).toBe('unconfirmed')
    expect(document.querySelector<HTMLButtonElement>('header button')!.hidden).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('header button')!.disabled).toBe(true)
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    await expect(f.entry.dispose()).rejects.toThrow('cleanup was not confirmed')
  })

  it('joins a held authentication body cancellation after timeout instead of replaying sign-in', async () => {
    const held = Promise.withResolvers<undefined>(), cancelled = vi.fn(() => held.promise), defaults = manifest()
    const config = { ...defaults, auth: { ...defaults.auth, requestTimeoutMs: 10 } }
    const f = fixture({ manifest: config, fetch: async input => pathOf(input) === '/cloud/bootstrap'
      ? new Response(null, { status: 401 }) : new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })) })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    expect(cancelled).toHaveBeenCalledTimes(1)
    let completed = false
    const stopping = f.entry.dispose().then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    held.resolve(undefined)
    await stopping
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.mount).not.toHaveBeenCalled()
  })

  it('accepts an authentication body already errored by its exact native abort reason', async () => {
    const defaults = manifest(), config = { ...defaults, auth: { ...defaults.auth, requestTimeoutMs: 10 } }
    const f = fixture({ manifest: config, fetch: async (input, init) => {
      if (pathOf(input) === '/cloud/bootstrap') return new Response(null, { status: 401 })
      const signal = init?.signal
      if (signal === undefined || signal === null) throw new Error('The original auth signal is required')
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        signal.addEventListener('abort', () => { controller.error(signal.reason) }, { once: true })
      } }))
    } })
    await f.entry.run()
    submit()
    await expect.poll(f.state).toBe('auth-unknown')
    await f.entry.dispose()
    expect(f.fetcher).toHaveBeenCalledTimes(2)
    expect(f.mount).not.toHaveBeenCalled()
  })
})
