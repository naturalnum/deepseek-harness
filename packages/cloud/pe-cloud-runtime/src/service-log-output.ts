/** Closed Root-only log projection; unknown text and dynamic data have no output fallback. */
import { Context, type Exporter } from '@deepseek-ai/cordis'
import { types } from 'node:util'

const PREFIX = 'Cloud service log: '
const ROOT_ALIAS = 'cloud-root'
const MAX_LINE_BYTES = 4096
const MISSING = Symbol('missing data field')
type Level = 'error' | 'info' | 'warn'
type Parameter = 'omit' | 'error' | 'ready'
interface Template {
  readonly input: string
  readonly arity: 1 | 2
  readonly output: string
  readonly parameter?: Parameter
}

const templates: readonly Template[] = [
  { input: 'Runtime root shutdown observation expired; actual work and owner responsibility remain retained', arity: 1,
    output: 'Runtime root shutdown observation expired; actual work and owner responsibility remain retained' },
  { input: 'Actual account drain remains unresolved; original Root control resources and ownership remain retained', arity: 1,
    output: 'Actual account drain remains unresolved; original Root control resources and ownership remain retained' },
  { input: 'Runtime root control or shutdown is unconfirmed; account ownership was not released and automatic recovery remains closed', arity: 1,
    output: 'Runtime root control or shutdown is unconfirmed; account ownership was not released and automatic recovery remains closed' },
  { input: 'Cloud runtime observation is unavailable; business state is unchanged.', arity: 1,
    output: 'Cloud runtime observation is unavailable; business state is unchanged.' },
  { input: 'Approved plugin rebuild %s failed; application is unconfirmed. Reconnect and read current state before another edit.', arity: 2,
    output: 'Approved plugin rebuild failed; application is unconfirmed. Reconnect and read current state before another edit.', parameter: 'omit' },
  { input: 'Cloud Root recipe audit did not seal; account admission remains closed. Inspect the retained audit.', arity: 1,
    output: 'Cloud Root recipe audit did not seal; account admission remains closed. Inspect the retained audit.' },
  { input: 'Runtime root control failed or became uncertain; new account admission is closed and status requires inspection', arity: 1,
    output: 'Runtime root control failed or became uncertain; new account admission is closed and status requires inspection' },
  { input: 'Cloud runtime observation: %o', arity: 2, output: 'Cloud runtime observation.', parameter: 'ready' },
  { input: 'Cloud authentication cleanup is unconfirmed; admission remains closed.', arity: 1,
    output: 'Cloud authentication cleanup is unconfirmed; admission remains closed.' },
  { input: 'Cloud authentication database failed; admission remains closed.', arity: 1,
    output: 'Cloud authentication database failed; admission remains closed.' },
  { input: 'Cloud login Peer cleanup is unconfirmed: %j', arity: 2,
    output: 'Cloud login Peer cleanup is unconfirmed.', parameter: 'error' },
  { input: 'Cloud ingress body cleanup is unconfirmed; admission remains closed.', arity: 1,
    output: 'Cloud ingress body cleanup is unconfirmed; admission remains closed.' },
  { input: 'Cloud owner forwarding closure is unconfirmed; no replay was attempted: %j', arity: 2,
    output: 'Cloud owner forwarding closure is unconfirmed; no replay was attempted.', parameter: 'omit' },
  { input: 'Cloud owner forwarding failed after possible delivery; no replay was attempted: %j', arity: 2,
    output: 'Cloud owner forwarding failed after possible delivery; no replay was attempted.', parameter: 'omit' },
  { input: 'Cloud owner request observation is unavailable; request state is unchanged.', arity: 1,
    output: 'Cloud owner request observation is unavailable; request state is unchanged.' },
  { input: 'Cloud ingress request failed: %j', arity: 2,
    output: 'Cloud ingress request failed.', parameter: 'omit' },
  { input: 'Cloud ingress borrow cleanup is unconfirmed; admission remains closed.', arity: 1,
    output: 'Cloud ingress borrow cleanup is unconfirmed; admission remains closed.' },
]

const errorNames = new Map<string, string>([
  ['Error', 'Error'], ['TypeError', 'TypeError'], ['RangeError', 'RangeError'], ['SyntaxError', 'SyntaxError'],
  ['ReferenceError', 'ReferenceError'], ['URIError', 'URIError'], ['EvalError', 'EvalError'],
  ['AggregateError', 'AggregateError'], ['AccountRuntimeError', 'AccountRuntimeError'],
])
const errorPrototypes = new Map<object, string>([
  [Error.prototype, 'Error'], [TypeError.prototype, 'TypeError'], [RangeError.prototype, 'RangeError'],
  [SyntaxError.prototype, 'SyntaxError'], [ReferenceError.prototype, 'ReferenceError'],
  [URIError.prototype, 'URIError'], [EvalError.prototype, 'EvalError'], [AggregateError.prototype, 'AggregateError'],
])
const errorCodes = new Map<string, string>([
  ['cloud/account-unavailable', 'cloud/account-unavailable'], ['cloud/stop-unconfirmed', 'cloud/stop-unconfirmed'],
  ['cloud/config-conflict', 'cloud/config-conflict'], ['cloud/invalid-config', 'cloud/invalid-config'],
])
interface SafeError { readonly type: string; readonly code?: string }
interface Projection { readonly content: string; readonly event?: 'ordinary-profile-ready'; readonly error?: SafeError }

function data(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : MISSING
}

function errorFacts(error: Error): SafeError {
  const nameDescriptor = Object.getOwnPropertyDescriptor(error, 'name')
  const name: unknown = nameDescriptor !== undefined && Object.hasOwn(nameDescriptor, 'value') ? nameDescriptor.value : MISSING
  const type = nameDescriptor === undefined ? errorPrototypes.get(Object.getPrototypeOf(error)) ?? 'unknown'
    : typeof name === 'string' ? errorNames.get(name) ?? 'unknown' : 'unknown'
  const suppliedCode = data(error, 'code')
  const code = typeof suppliedCode === 'string' ? errorCodes.get(suppliedCode) : undefined
  return { type, ...(code === undefined ? {} : { code }) }
}

function project(args: unknown[]): Projection | undefined {
  const arity = data(args, 'length')
  if (arity !== 1 && arity !== 2) return
  const first = data(args, '0')
  if (arity === 1 && types.isNativeError(first)) return { content: 'Root logger error.', error: errorFacts(first) }
  if (typeof first !== 'string') return
  const template = templates.find(value => value.input === first && value.arity === arity)
  if (template === undefined) return
  if (template.parameter === 'ready') {
    const observation = data(args, '1')
    if (observation === null || typeof observation !== 'object' || Array.isArray(observation)
      || data(observation, 'event') !== 'ordinary-profile-ready') return
    return { content: template.output, event: 'ordinary-profile-ready' }
  }
  if (template.parameter === 'error') {
    const error = data(args, '1')
    if (types.isNativeError(error)) return { content: template.output, error: errorFacts(error) }
  }
  return { content: template.output }
}

/**
 * Register one effect-owned Root sink with closed text, field and error mappings.
 * @param ctx Original Root service scope; no account Logger is wrapped or installed.
 * @param closeActual Join the original Root close result when its owning fiber unloads.
 * @returns Idempotent notification that this same close has settled; never call it to cancel pending Root work.
 */
export function installServiceLogOutput(ctx: Context, closeActual: () => Promise<void>): () => void {
  let active = true
  let setupComplete = false
  let actualSettled = false
  let observer: Context | undefined
  let withdraw: (() => void | Promise<void>) | undefined
  let cleaning: Promise<void> | undefined
  const cleanObserver = (): Promise<void> => cleaning ??= (async () => {
    active = false
    try { await withdraw?.() } catch (_cause) { /* A logging effect never replaces the original shutdown result. */ }
    try { await observer?.fiber.dispose() } catch (_cause) { /* The private observer owns no business resource. */ }
  })()
  const exporter: Exporter = {
    levels: { default: 2 },
    export(message) {
      if (!active) return
      try {
        const type = data(message, 'type'), level = data(message, 'level')
        if (type !== 'error' && type !== 'info' && type !== 'warn') return
        const allowed: Record<Level, number> = { error: 0, info: 1, warn: 2 }
        if (level !== allowed[type]) return
        const args = data(message, 'args')
        if (!Array.isArray(args)) return
        const projection = project(args)
        if (projection === undefined) return
        let line = PREFIX + JSON.stringify({ level: type, name: ROOT_ALIAS, ...projection })
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          line = PREFIX + JSON.stringify({ level: type, name: ROOT_ALIAS, content: 'Root service log entry omitted: output limit.' })
        }
        console.warn(line)
      } catch (_cause) { /* Unknown reflection, serialization and console failures have no diagnostic fallback. */ }
    },
  }
  try {
    observer = new Context()
    // Its effect owner survives the runtime fiber; the original Root Logger and its other exporters are shared.
    observer.logger = ctx.logger
    withdraw = observer.logger.exporter(exporter)
    ctx.effect(() => async () => {
      if (setupComplete && !actualSettled) {
        try { await closeActual() } catch (_cause) { /* The original Root close retains and reports this same failure. */ }
        actualSettled = true
      }
      await cleanObserver()
    }, 'pe-cloud-runtime: join Root closure before disposing its log observer')
    setupComplete = true
  } catch (_cause) { void cleanObserver() }
  return () => {
    actualSettled = true
    void cleanObserver()
  }
}
