/** Keyless native history recovery through the product follow generator. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate as flush } from 'node:timers/promises'
import { test } from 'node:test'
import { PlatformError, sessionId } from '../src/contracts.ts'
import { followNativeSession } from '../src/host/native-session-follow.ts'

const request = { address: { kind: 'session' as const, sessionId: sessionId.parse('18de1cac-0ccb-493f-a270-b28547db0e60') } }
const opening = { type: 'snapshot', cursor: 0, records: [], hasMore: false,
  projections: { asOfSeq: 0, values: {} } }
const pollMs = 50
type ReadCall = Parameters<typeof followNativeSession>[0]
const disconnected = (code: string) => new TypeError('fetch failed', { cause: { code } })

test('a Platform outage resumes from the delivered cursor and emits the continuation once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const reads: { path: string; input: unknown }[] = []
  const replies = [{ events: [{ seq: 1, type: 'user/message', data: { text: 'wait for the approved result' } }] },
    disconnected('ECONNRESET'), new PlatformError(503, 'service_unavailable'),
    { events: [{ seq: 2, type: 'platform/result', data: { actionId: '960968a7-ac55-4f25-b81e-19538534a92a', exitCode: 0 } },
      { seq: 3, type: 'assistant/message', data: { text: 'recovery-finished' } }] }]
  const call: ReadCall = async (path, input) => {
    reads.push({ path, input })
    if (path.endsWith('/snapshot')) return opening
    const reply = replies.shift() ?? { events: [] }
    if (reply instanceof Error) throw reply
    return reply
  }
  const abort = new AbortController()
  const stream = followNativeSession(call, request, pollMs, abort.signal)
  const frames = [(await stream.next()).value, (await stream.next()).value]
  const resumed = stream.next()
  await flush()
  assert.equal(reads.length, 3)
  t.mock.timers.tick(pollMs - 1)
  await flush()
  assert.equal(reads.length, 3)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(reads.length, 4)
  t.mock.timers.tick(pollMs)
  frames.push((await resumed).value, (await stream.next()).value)
  assert.deepEqual(reads.filter(read => read.path.endsWith('/after')).map(read => read.input),
    [0, 1, 1, 1].map(cursor => ({ sessionId: request.address.sessionId, cursor })))
  assert.equal(reads.filter(read => read.path.endsWith('/snapshot')).length, 1)
  assert.deepEqual(frames, JSON.parse(await readFile(new URL('./native-session-follow.expected.json', import.meta.url), 'utf8')))
  const waiting = stream.next()
  await flush()
  assert.deepEqual(reads.at(-1)?.input, { sessionId: request.address.sessionId, cursor: 3 })
  abort.abort()
  assert.equal((await waiting).done, true)
})

for (const [name, error] of [
  ['connection refused', disconnected('ECONNREFUSED')],
  ['body disconnected', disconnected('UND_ERR_SOCKET')],
  ['request timeout', new DOMException('configured read timeout', 'TimeoutError')],
  ['502', new PlatformError(502, 'platform_empty_response')],
  ['503', new PlatformError(503, 'service_unavailable')],
  ['504', new PlatformError(504, 'platform_error')],
] as const) {
  test(`opening snapshot retries a temporary ${name} read using the configured interval`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let attempts = 0
    const call: ReadCall = async () => { if (++attempts === 1) throw error; return opening }
    const abort = new AbortController()
    const stream = followNativeSession(call, request, pollMs, abort.signal)
    const first = stream.next()
    await flush()
    assert.equal(attempts, 1)
    t.mock.timers.tick(pollMs)
    assert.deepEqual((await first).value, opening)
    assert.equal(attempts, 2)
    abort.abort()
    assert.equal((await stream.next()).done, true)
  })
}

test('cancellation during unavailable-read backoff stops all later reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const call: ReadCall = async () => { attempts++; throw disconnected('ECONNREFUSED') }
  const abort = new AbortController()
  const stream = followNativeSession(call, request, pollMs, abort.signal)
  const first = stream.next()
  await flush()
  abort.abort()
  assert.equal((await first).done, true)
  t.mock.timers.tick(pollMs * 10)
  await flush()
  assert.equal(attempts, 1)
})

test('cancellation releases an in-flight read and ignores its late response', async () => {
  let finish: ((value: unknown) => void) | undefined
  let attempts = 0
  const call: ReadCall = () => { attempts++; return new Promise(resolve => { finish = resolve }) }
  const abort = new AbortController()
  const stream = followNativeSession(call, request, pollMs, abort.signal)
  const first = stream.next()
  abort.abort()
  assert.equal((await first).done, true)
  finish!(opening)
  await flush()
  assert.equal((await stream.next()).done, true)
  assert.equal(attempts, 1)
})

for (const error of [new PlatformError(401, 'unauthorized'), new PlatformError(403, 'forbidden'),
  new PlatformError(404, 'session_not_found'), new PlatformError(400, 'native_cursor_invalid'),
  new PlatformError(502, 'platform_response_limit'), new PlatformError(503, 'native_history_gap'),
  new SyntaxError('invalid JSON response'), new TypeError('local read implementation failed')]) {
  test(`${error.name}: ${error.message} terminates without retrying`, async () => {
    let attempts = 0
    const call: ReadCall = async () => { attempts++; throw error }
    const stream = followNativeSession(call, request, pollMs, new AbortController().signal)
    await assert.rejects(stream.next(), cause => cause === error)
    assert.equal(attempts, 1)
  })
}

test('authorization denial after opening terminates the established follower', async () => {
  let attempts = 0
  const denied = new PlatformError(403, 'forbidden')
  const call: ReadCall = async () => { if (++attempts === 1) return opening; throw denied }
  const stream = followNativeSession(call, request, pollMs, new AbortController().signal)
  assert.deepEqual((await stream.next()).value, opening)
  await assert.rejects(stream.next(), cause => cause === denied)
  assert.equal(attempts, 2)
})

test('a duplicated or missing durable sequence terminates before publishing that event', async () => {
  for (const seq of [0, 2]) {
    let attempts = 0
    const call: ReadCall = async () => ++attempts === 1 ? opening : { events: [{ seq }] }
    const stream = followNativeSession(call, request, pollMs, new AbortController().signal)
    await stream.next()
    await assert.rejects(stream.next(), error => error instanceof PlatformError && error.code === 'native_history_gap')
    assert.equal(attempts, 2)
  }
})

test('invalid Platform event records terminate without polling again', async () => {
  let attempts = 0
  const call: ReadCall = async () => ++attempts === 1 ? opening : { events: [{ seq: '2' }] }
  const stream = followNativeSession(call, request, pollMs, new AbortController().signal)
  await stream.next()
  await assert.rejects(stream.next(), { name: 'ZodError' })
  assert.equal(attempts, 2)
})
