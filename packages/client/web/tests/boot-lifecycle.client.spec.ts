import { createSnapshotStore, type ClientPersistence } from '@deepseek-ai/dsh-client-store'
// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.ts'

const win = globalThis as DshWindow

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  document.body.replaceChildren()
})

/** Real module system and Loader; only the external bundle and renderer are fixtures. */
function fixture(options: {
  persistence?: ClientPersistence
  requirePersistence?: boolean
  immediately?: boolean
  bundle?: Promise<undefined>
  activate?: (ctx: Context) => Promise<void> | void
  mount?: (container: HTMLElement) => () => void
} = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  const loading = Promise.withResolvers<undefined>()
  const activating = Promise.withResolvers<undefined>()
  const pendingQueue: ClientBundleRegistration[] = []
  const create = vi.fn((input: ClientModuleCreateOptions) => modulesClient.createClientModuleSystem(target, {
    id: '@deepseek-ai/dsh-client-modules',
    exports: modulesClient,
  }, input))
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue, create,
    load: (registration) => { pendingQueue.push(registration) },
  }
  win.__ModuleLoader__ = target
  win.__DSH_BOOT__ = {
    rev: 'lifecycle',
    entries: [{ id: 'renderer', url: '/renderer.js', rev: '1', immediately: options.immediately }],
    batches: [{ phase: 'application', url: '/application.js', rev: '1', entries: ['renderer'] }],
  }
  const unmount = vi.fn(() => { container.replaceChildren() })
  const mount = vi.fn(options.mount ?? ((element: HTMLElement) => {
    element.textContent = 'native application'
    return unmount
  }))
  const apply = vi.fn()
  async function activate(ctx: Context): Promise<void> {
    apply()
    ctx.reflect.provide('uiRenderer', { mount })
    activating.resolve(undefined)
    await options.activate?.(ctx)
  }
  const entry = new AppWebEntry(container, {
    ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
    ...(options.requirePersistence === undefined ? {} : { requirePersistence: options.requirePersistence }),
    loadBundle: async () => {
      loading.resolve(undefined)
      await options.bundle
      target.load({ id: 'renderer', factory: () => ({ apply: activate }) })
    },
  })
  return { entry, container, create, apply, mount, unmount, loading: loading.promise, activating: activating.promise }
}

/** Observe completion without replacing the operation's own promise. */
function completion(promise: Promise<void>) {
  const done = vi.fn()
  void promise.then(done, done)
  return done
}

/** Interrupted native startup keeps the same failure on both public promises. */
async function sharedFailure(boot: Promise<void>, closing: Promise<void>): Promise<unknown> {
  const [startup, disposal] = await Promise.allSettled([boot, closing])
  if (startup?.status !== 'rejected' || disposal?.status !== 'rejected') {
    throw new Error('expected both startup and disposal to retain the native failure')
  }
  expect(disposal.reason).toBe(startup.reason)
  return startup.reason
}

describe('AppWebEntry disposal', () => {
  it('does not start after disposal and shares one completed disposal', async () => {
    const f = fixture()
    const closing = f.entry.dispose()
    expect(f.entry.dispose()).toBe(closing)
    await closing
    await f.entry.run()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('joins a pending ready gate and discards its late completion', async () => {
    const gate = Promise.withResolvers<undefined>()
    vi.stubGlobal('__DSH_BOOT_READY__', gate)
    const f = fixture()
    const failure = vi.fn()
    const boot = f.entry.run(failure)
    const closing = f.entry.dispose()
    const done = completion(closing)
    f.container.textContent = 'successor page'
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    gate.resolve(undefined)
    await Promise.all([boot, closing])
    expect(f.create).not.toHaveBeenCalled()
    expect(failure).not.toHaveBeenCalled()
    expect(f.container.textContent).toBe('successor page')
  })

  it('retains a late ready-gate rejection without reporting to the disposed page', async () => {
    const gate = Promise.withResolvers<undefined>()
    vi.stubGlobal('__DSH_BOOT_READY__', gate)
    const f = fixture()
    const failure = vi.fn()
    const reason = new Error('late gate failure')
    const boot = f.entry.run(failure)
    const closing = f.entry.dispose()
    f.container.textContent = 'successor page'
    gate.reject(reason)
    await expect(boot).rejects.toBe(reason)
    await expect(closing).rejects.toBe(reason)
    expect(failure).not.toHaveBeenCalled()
    expect(f.container.textContent).toBe('successor page')
  })

  it('waits for immediate prefetch without activating the late bundle', async () => {
    const bundle = Promise.withResolvers<undefined>()
    const f = fixture({ immediately: true, bundle: bundle.promise })
    const boot = f.entry.run()
    await f.loading
    const closing = f.entry.dispose()
    const done = completion(closing)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    bundle.resolve(undefined)
    await Promise.all([boot, closing])
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.mount).not.toHaveBeenCalled()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('seals Loader activation while a non-immediate bundle is still loading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bundle = Promise.withResolvers<undefined>()
    const f = fixture({ bundle: bundle.promise })
    const boot = f.entry.run()
    await f.loading
    const closing = f.entry.dispose()
    const done = completion(closing)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    bundle.resolve(undefined)
    expect(await sharedFailure(boot, closing)).toMatchObject({ code: 'INACTIVE_EFFECT' })
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.mount).not.toHaveBeenCalled()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('waits for actual plugin startup and cleanup before disposal completes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const activation = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    const cleaning = Promise.withResolvers<undefined>()
    const released = vi.fn()
    const f = fixture({ activate: async (ctx) => {
      ctx.effect(() => async () => {
        cleaning.resolve(undefined)
        await cleanup.promise
        released()
      })
      await activation.promise
    } })
    const boot = f.entry.run()
    await f.activating
    const closing = f.entry.dispose()
    const done = completion(closing)
    expect(f.entry.dispose()).toBe(closing)
    activation.resolve(undefined)
    await cleaning.promise
    expect(done).not.toHaveBeenCalled()
    expect(released).not.toHaveBeenCalled()
    expect(f.mount).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    expect(await sharedFailure(boot, closing)).toBeInstanceOf(TypeError)
    expect(released).toHaveBeenCalledOnce()
    expect(f.mount).not.toHaveBeenCalled()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('stops a queued mount fiber synchronously before its renderer executes', async () => {
    let closing: Promise<void> | undefined
    const f = fixture({ activate: (ctx) => {
      ctx.on('internal/status', (fiber) => {
        if (closing === undefined && 'uiRenderer' in fiber.inject) closing = f.entry.dispose()
      })
    } })
    const published: string[] = []
    const collect = (records: MutationRecord[]): void => {
      for (const record of records) {
        for (const node of record.addedNodes) published.push(node.textContent ?? '')
      }
    }
    const observer = new MutationObserver(collect)
    observer.observe(f.container, { childList: true, subtree: true })
    await f.entry.run()
    expect(closing).toBeDefined()
    await closing
    collect(observer.takeRecords())
    observer.disconnect()
    expect(published).not.toContain('native application')
    expect(f.mount).not.toHaveBeenCalled()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('joins reentrant disposal during mount setup and async native cleanup', async () => {
    const cleanup = Promise.withResolvers<undefined>()
    const cleaning = Promise.withResolvers<undefined>()
    let closing: Promise<void> | undefined
    const released = vi.fn()
    const f = fixture({
      activate: (ctx) => {
        ctx.effect(() => async () => {
          cleaning.resolve(undefined)
          await cleanup.promise
          released()
        })
      },
      mount: (container) => {
        container.textContent = 'native application'
        closing = f.entry.dispose()
        return () => { container.replaceChildren() }
      },
    })
    const boot = f.entry.run()
    await cleaning.promise
    expect(closing).toBeDefined()
    expect(released).not.toHaveBeenCalled()
    const done = completion(f.entry.dispose())
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    await Promise.all([boot, closing])
    expect(f.mount).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledOnce()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('rejects disposal with a real asynchronous Cordis cleanup error after other cleanup settles', async () => {
    const cleanup = Promise.withResolvers<undefined>()
    const cleaning = Promise.withResolvers<undefined>()
    const reason = new Error('renderer resource could not be released')
    const f = fixture({ activate: (ctx) => {
      ctx.effect(() => async () => {
        cleaning.resolve(undefined)
        await cleanup.promise
        throw reason
      })
    } })
    await f.entry.run()
    const closing = f.entry.dispose()
    const done = completion(closing)
    await cleaning.promise
    expect(done).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    await expect(closing).rejects.toBe(reason)
    expect(f.entry.dispose()).toBe(closing)
    expect(f.unmount).toHaveBeenCalledOnce()
    expect(f.container.childNodes).toHaveLength(0)
  })

  it('preserves both a page cleanup failure and a late startup failure', async () => {
    const gate = Promise.withResolvers<undefined>()
    vi.stubGlobal('__DSH_BOOT_READY__', gate)
    const f = fixture()
    const page = f.container.querySelector('[data-dsh-boot]')
    if (page === null) throw new Error('missing fixture boot page')
    const cleanupFailure = new Error('boot page detach failed')
    const startupFailure = new Error('late gate failure')
    vi.spyOn(page, 'remove').mockImplementation(() => { throw cleanupFailure })
    const failure = vi.fn()
    const boot = f.entry.run(failure)
    const closing = f.entry.dispose()
    gate.reject(startupFailure)
    await expect(boot).rejects.toBe(startupFailure)
    await expect(closing).rejects.toMatchObject({ errors: [cleanupFailure, startupFailure] })
    expect(failure).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  })

  it('runs one normal native graph and unmounts it once', async () => {
    const f = fixture()
    const boot = f.entry.run()
    expect(f.entry.run()).toBe(boot)
    await boot
    expect(f.apply).toHaveBeenCalledOnce()
    expect(f.mount).toHaveBeenCalledOnce()
    expect(f.container.textContent).toBe('native application')
    const closing = f.entry.dispose()
    expect(f.entry.dispose()).toBe(closing)
    await closing
    expect(f.unmount).toHaveBeenCalledOnce()
    expect(f.container.childNodes).toHaveLength(0)
  })
})


describe('AppWebEntry page persistence', () => {
  it('rejects a required missing port before loading any module', () => {
    expect(() => fixture({ requirePersistence: true })).toThrow('required page persistence is missing')
  })

  it('provides the captured port before native activation without forwarding it to the module system', async () => {
    const values = new Map<string, string>([['boot.cache', '"saved"']])
    const persistence: ClientPersistence = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) }, keys: () => [...values.keys()],
    }
    const f = fixture({ persistence, requirePersistence: true, activate: (ctx) => {
      expect(ctx.get('clientPersistence')).toBe(persistence)
      const source = createSnapshotStore('', { persist: { name: 'boot.cache', storage: ctx.get('clientPersistence') } })
      expect(source.getSnapshot()).toBe('saved')
    } })
    await f.entry.run()
    expect(values.get('boot.cache')).toBe('"saved"')
    const options = f.create.mock.calls[0]![0]
    expect(options).not.toHaveProperty('persistence')
    expect(options).not.toHaveProperty('requirePersistence')
    await f.entry.dispose()
  })
})
