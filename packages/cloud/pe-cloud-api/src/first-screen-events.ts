/** Bounded readonly native events registered on the original account Gateway; no ready frame or waterfall implementation. */
import { isAbsolute } from 'node:path'
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import Gateway, { type TypertRemoteEventFrame } from '@deepseek-ai/dsh-api-gateway'
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-settings'
import type { CloudAccountApi } from './account-service.ts'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'
import { firstScreenNativeOwner, type NativeFirstScreen } from './native-first-screen.ts'

/** Required deployment bounds for this single account event source; no production defaults. */
export interface FirstScreenEventInput {
  readonly api: CloudAccountApi
  readonly native: NativeFirstScreen
  /** The actual graph profile home, supplied and verified by runtime; never process homedir. */
  readonly home: string
  readonly maxHomeBytes: number
  readonly maxInventoryEntries: number
  readonly maxQueuedEvents: number
  readonly maxQueuedBytes: number
  /** Complete encoded emit-frame bound, including event name and envelope. */
  readonly maxFrameBytes: number
}

/** Real registration facts; Root must still connect and audit the original external C04/Peer guard. */
export interface FirstScreenEvents {
  /** Check the original active registration, graph, Gateway and native owners without granting business admission. */
  inspect(): {
    readonly endpoint: '$events'
    readonly gateway: Gateway
    readonly fiber: Fiber
    readonly owner: Fiber
    readonly home: string
    readonly queuedEvents: number
    readonly queuedBytes: number
  }
  /** Recheck actual C04 business admission for the external opener; registration alone never grants it. */
  assertAdmitted(): void
  /** Join actual native registration/source withdrawal and report any retained source or cleanup failure. */
  dispose(): Promise<void>
}

function unavailable(): never {
  throw new CloudApiError('cloud/account-unavailable', 'The original first-screen event source is unavailable.')
}

/**
 * Register the first trial's actual readonly native notification subset.
 * Listeners attach synchronously before the public Gateway registration returns;
 * the Gateway owns ready, client ids and all wire framing. No model/credential
 * catalog events, waterfall or $events/result operation is opened here.
 * @param ctx - original event registration Loader fiber inside the independent account graph.
 * @param input - original owners, exact profile home and required finite budgets.
 * @returns the retained registration and actual withdrawal handle, not a ready certificate.
 */
export function registerFirstScreenEvents(ctx: Context, input: FirstScreenEventInput): FirstScreenEvents {
  for (const value of [input.maxHomeBytes, input.maxInventoryEntries, input.maxQueuedEvents, input.maxQueuedBytes, input.maxFrameBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) unavailable()
  }
  const profile = ctx.get('profileContext'), gateway = ctx.get('typertGateway')
  if (profile === undefined || profile.home !== input.home || !isAbsolute(input.home)
    || Buffer.byteLength(input.home, 'utf8') > input.maxHomeBytes || !(gateway instanceof Gateway)) unavailable()
  const original = firstScreenNativeOwner(ctx, 'typertGateway', gateway, input.maxInventoryEntries)
  const canonical = original.value
  if (!(canonical instanceof Gateway)) unavailable()
  const register: unknown = Reflect.get(canonical, 'registerRemoteEvents')
  const queue = new Deque<{ readonly frame: TypertRemoteEventFrame; readonly bytes: number }>()
  const removers: Array<() => void> = []
  let bytes = 0, closed = false, failure: { readonly error: unknown } | undefined
  let wake: (() => void) | undefined, closing: Promise<void> | undefined
  const graph = (): void => {
    input.api.assertInstalled(ctx)
    input.native.assertCurrent()
    const actualProfile = ctx.get('profileContext'), rootProfile = ctx.root.get('profileContext')
    const actual = firstScreenNativeOwner(ctx, 'typertGateway', canonical, input.maxInventoryEntries)
    if (input.api.binding !== input.native.binding || actualProfile !== profile || rootProfile !== profile
      || profile.home !== input.home || actual.value !== canonical || actual.fiber !== original.fiber
      || canonical.registerRemoteEvents !== register) unavailable()
  }
  graph()
  const notify = (): void => { const pending = wake; wake = undefined; pending?.() }
  const stop = (error?: { readonly error: unknown }): void => {
    failure ??= error
    if (closed) return
    closed = true
    input.api.invalidate()
    queue.clear()
    bytes = 0
    for (const remove of removers.splice(0)) {
      try { remove() } catch (cause) { failure ??= { error: cause } }
    }
    notify()
  }
  const push = (frame: TypertRemoteEventFrame): void => {
    if (closed) return
    try {
      graph()
      const size = firstScreenJsonBytes({ type: 'emit', event: frame.event, args: frame.args }, input.maxFrameBytes)
      if (!frame.args.every(value => isRemoteJsonValue(value))) unavailable()
      if (size > input.maxFrameBytes || queue.size >= input.maxQueuedEvents || size > input.maxQueuedBytes - bytes) unavailable()
      queue.pushBack({ frame, bytes: size })
      bytes += size
      notify()
    } catch (error) { stop({ error }) }
  }
  const session = (frame: TypertRemoteEventFrame, id: Parameters<NativeFirstScreen['assertSessionRead']>[0]): void => {
    if (closed) return
    try { input.native.assertSessionRead(id); push(frame) } catch (error) { stop({ error }) }
  }
  const unregister = gateway.registerRemoteEvents((signal) => {
    removers.push(
      ctx.on('api-session/added', (summary) => { session({ event: 'api-session/added', args: [summary] }, summary.sessionId) }),
      ctx.on('api-session/removed', (id) => { session({ event: 'api-session/removed', args: [id] }, id) }),
      ctx.on('api-session/activity', (id, at) => { session({ event: 'api-session/activity', args: [id, at] }, id) }),
      ctx.on('api-session/status', (id, running) => { session({ event: 'api-session/status', args: [id, running] }, id) }),
      ctx.on('api-session/error', (id, message) => { session({ event: 'api-session/error', args: [id, message] }, id) }),
      ctx.on('settings/document-updated', (ns, revision) => {
        if (ns === 'locale') push({ event: 'settings/document-updated', args: [ns, revision] })
      }),
    )
    const abort = (): void => { stop() }
    signal.addEventListener('abort', abort, { once: true })
    removers.push(() => { signal.removeEventListener('abort', abort) })
    return (async function *(): AsyncIterable<TypertRemoteEventFrame> {
      try {
        while (!closed) {
          const next = queue.popFront()
          if (next !== undefined) {
            bytes -= next.bytes
            graph()
            yield next.frame
          } else await new Promise<void>((resolve) => { wake = resolve })
        }
      } finally {
        stop()
        if (failure !== undefined) throw failure.error
      }
    })()
  }, { home: input.home }, { maxQueuedEvents: input.maxQueuedEvents,
    maxQueuedBytes: input.maxQueuedBytes, maxFrameBytes: input.maxFrameBytes })
  const dispose = (): Promise<void> => closing ??= (async () => {
    try { await unregister() } catch (error) { failure ??= { error } }
    stop()
    if (failure !== undefined) throw failure.error
  })()
  const abortGraph = (): void => { void dispose().catch((error: unknown) => { failure ??= { error } }) }
  input.native.binding.lifetime.addEventListener('abort', abortGraph, { once: true })
  removers.push(() => { input.native.binding.lifetime.removeEventListener('abort', abortGraph) })
  ctx.effect(() => dispose, 'pe-cloud-api: readonly first-screen native event source')
  return Object.freeze({
    inspect() {
      graph()
      if (closed || closing !== undefined || failure !== undefined || ctx.fiber.state !== FiberState.ACTIVE) unavailable()
      return Object.freeze({ endpoint: '$events' as const, gateway: canonical, fiber: original.fiber, owner: ctx.fiber,
        home: input.home, queuedEvents: queue.size, queuedBytes: bytes })
    },
    assertAdmitted(): void {
      graph()
      if (closed || closing !== undefined || input.api.requireStream('$events').guard !== 'authenticated-account') unavailable()
      graph()
    },
    dispose,
  })
}
