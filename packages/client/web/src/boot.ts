/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { bootClient } from './boot-client.ts'
import { BootPage } from './boot-page.ts'
import { mountClient } from './mount.ts'
import { getStaticModules } from './seed.ts'
import { installWindowDragRecall } from './window-drag/recall.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private running: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private cleanupFailure: Error | undefined
  private readonly fibers = new Set<Fiber>()
  private readonly stopping: Promise<unknown[]>[] = []
  private stopDragRecall: (() => void) | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Repeated calls join the first run; calls after disposal do
   * not start another tree. Plugin failures remain visible on the boot page.
   * @param onFailure - Optional carrier-owned fatal presentation; keeps the boot page visible.
   * @returns Resolves after mount, failure reporting, or a stopped run settles.
   * @throws The original failure if reporting throws or disposal has started.
   */
  run(onFailure?: (reason: unknown) => void): Promise<void> {
    if (this.running !== undefined) return this.running
    if (this.disposal !== undefined) return Promise.resolve()
    return this.running = this.start(onFailure)
  }

  private isDisposed(): boolean {
    return this.disposal !== undefined
  }

  private async start(onFailure?: (reason: unknown) => void): Promise<void> {
    try {
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      if (this.isDisposed()) return
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      if (this.isDisposed()) return
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      await prefetching
      if (this.isDisposed()) return
      const ctx = new Context()
      this.ctx = ctx
      // Cordis reports async disposer errors through its logger even when the
      // fiber settles successfully. Retain one cause until disposal finishes.
      ctx.logger.exporter({ levels: { default: 1 }, export: (message) => {
        if (message.type !== 'error' || !this.isDisposed() || this.cleanupFailure !== undefined) return
        const reason: unknown = message.args[0]
        this.cleanupFailure = reason instanceof Error
          ? reason : new Error('web boot: native cleanup reported an error', { cause: reason })
      } })
      // Root disposal restarts a Context and unloads children asynchronously.
      // Retain each child so disposal can seal pending activation immediately.
      ctx.on('internal/plugin', (fiber) => {
        if (fiber.uid === null) this.fibers.delete(fiber)
        else {
          this.fibers.add(fiber)
          if (this.isDisposed()) this.stopFiber(fiber)
        }
      })
      this.page.setTotal(this.manifest.plugins.length)
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: this.manifest,
        onEntryState: (name, state) => {
          if (!this.isDisposed() && (onFailure === undefined || state !== 'failed')) {
            this.page.setState(name, state)
          }
        },
      })
      if (this.isDisposed()) return
      // The shell owns the one watcher that keeps Electron's window drag rects in
      // step with the rows that own them (electron#32341), so no chrome row has to
      // know that trap. It installs before the first mount, so the surface the
      // renderer draws is the one the first frame measures.
      this.stopDragRecall = installWindowDragRecall({ document: this.container.ownerDocument })
      if (this.isDisposed()) return
      await mountClient(ctx, this.container)
    } catch (reason) {
      if (this.isDisposed()) throw reason
      console.error(reason)
      if (this.isDisposed()) throw reason
      if (onFailure !== undefined) onFailure(reason)
      else this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * Permanently stop further activation and mounting, then join the actual run
   * and native cleanup. Repeated calls share completion, including failures.
   * External readiness and bundle work must settle; disposal does not cancel it.
   * @returns Resolves once startup and owned cleanup have settled.
   * @throws The startup or cleanup failure, including the first native cleanup
   * error reported through Cordis logging; aggregates when several failures remain.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    const completion = Promise.withResolvers<void>()
    this.disposal = completion.promise
    void this.finishDisposal().then(completion.resolve, completion.reject)
    return this.disposal
  }

  private stopFiber(fiber: Fiber): void {
    this.stopping.push((async () => {
      try {
        await fiber.dispose()
        return []
      } catch (reason) {
        return [reason]
      }
    })())
  }

  private async finishDisposal(): Promise<void> {
    const failures: unknown[] = []
    const running = Promise.allSettled(this.running === undefined ? [] : [this.running])
    const stopDragRecall = (): void => {
      const stop = this.stopDragRecall
      this.stopDragRecall = undefined
      try { stop?.() } catch (reason) { failures.push(reason) }
    }
    stopDragRecall()
    try { this.page.dispose() } catch (reason) { failures.push(reason) }
    for (const fiber of [...this.fibers].reverse()) this.stopFiber(fiber)
    for (const result of await running) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
    // Late imports are still observed until startup and every sealed child settle.
    for (const stopped of this.stopping) {
      failures.push(...await stopped)
    }
    const ctx = this.ctx
    this.ctx = undefined
    try { await ctx?.fiber.dispose() } catch (reason) { failures.push(reason) }
    stopDragRecall()
    if (this.cleanupFailure !== undefined && !failures.includes(this.cleanupFailure)) failures.push(this.cleanupFailure)
    if (failures.length === 1) {
      const reason = failures[0]
      throw reason instanceof Error ? reason : new Error('web boot: disposal failed', { cause: reason })
    }
    if (failures.length > 1) throw new AggregateError(failures, 'web boot: startup and disposal failed')
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }
}
