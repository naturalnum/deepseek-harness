/** Real native HTTP carrier; Platform acknowledgement and queue state are explicit substitutes, not PG. */
import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { nativeHost, nativePost, type Call, type NativeFixture } from './employee7-native-wire-fixture.ts'

function post(fixture: NativeFixture, args: unknown, options: {
  readonly rpcId?: string
  readonly method?: string
  readonly cookie?: boolean
  readonly origin?: string
} = {}): Promise<Response> {
  return nativePost(fixture, 'session/cancel', args, { rpcId: 'employee7-native-cancel', ...options })
}

function cancellations(fixture: NativeFixture): Call[] {
  return fixture.platform.calls.filter(call => call.path !== '/identity/me')
}

test('native cancel uses the active-only Platform route and does not enter the legacy queued cancellation route', () =>
  nativeHost(async (fixture) => {
    const queued = structuredClone(fixture.platform.queued)
    const response = await post(fixture, { request: { sessionId: fixture.sessionId } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'employee7-native-cancel',
      result: { ok: true, value: { accepted: true } } })
    expect(cancellations(fixture)).toEqual([{ path: '/native/sessions/cancel', token: fixture.token,
      input: { sessionId: fixture.sessionId } }])
    expect(fixture.platform.queued).toEqual(queued)
    // Positive control: the same real RuntimeScope reaches the intentionally destructive legacy substitute.
    expect(await fixture.runtime.call('/sessions/cancel', fixture.token, { sessionId: fixture.sessionId }))
      .toEqual({ accepted: true })
    expect(fixture.platform.queued.map(item => item.state)).toEqual(['failed', 'queued'])
  }))

test('same-origin cookie retries echo each RPC identity and forward only the addressed Session', () =>
  nativeHost(async (fixture) => {
    const queued = structuredClone(fixture.platform.queued)
    for (const rpcId of ['employee7-first', 'employee7-repeat']) {
      const response = await post(fixture, { request: { sessionId: fixture.sessionId } }, { cookie: true, rpcId })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ type: 'server-response', rpcId,
        result: { ok: true, value: { accepted: true } } })
    }
    expect(cancellations(fixture)).toEqual(Array.from({ length: 2 }, () => ({ path: '/native/sessions/cancel',
      token: fixture.token, input: { sessionId: fixture.sessionId } })))
    expect(fixture.platform.queued).toEqual(queued)
  }))

test('native cancel refuses unknown fields and invalid Session addresses before a cancellation call', () =>
  nativeHost(async (fixture) => {
    const queued = structuredClone(fixture.platform.queued)
    for (const args of [
      { request: { sessionId: 'not-a-session' } },
      { request: { sessionId: fixture.sessionId, stopActivity: true } },
      { request: { sessionId: fixture.sessionId, itemId: randomUUID() } },
      { request: { sessionId: fixture.sessionId }, unexpected: true },
    ]) {
      const response = await post(fixture, args)
      expect(await response.json()).toMatchObject({ type: 'server-response', result: { ok: false,
        error: { code: 'gateway/arguments-invalid' } } })
    }
    expect(cancellations(fixture)).toEqual([])
    expect(fixture.platform.queued).toEqual(queued)
  }))

test('a mismatched method, foreign origin or revoked identity never reaches native cancellation', () =>
  nativeHost(async (fixture) => {
    const queued = structuredClone(fixture.platform.queued)
    const args = { request: { sessionId: fixture.sessionId } }
    const mismatch = await post(fixture, args, { method: 'session/prompt' })
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ error: 'method_mismatch' })
    const foreign = await post(fixture, args, { cookie: true, origin: 'https://foreign.example.test' })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: 'invalid_origin' })
    fixture.platform.identityDenied = true
    const revoked = await post(fixture, args)
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: 'account_unauthorized' })
    expect(cancellations(fixture)).toEqual([])
    expect(fixture.platform.queued).toEqual(queued)
  }))

test('Platform ownership and credential refusals return failed native results without a successful acknowledgement', () =>
  nativeHost(async (fixture) => {
    const queued = structuredClone(fixture.platform.queued)
    for (const denial of [
      { status: 404, code: 'session_not_found', remote: 'session/not-found' },
      { status: 401, code: 'account_unauthorized', remote: 'gateway/forbidden' },
    ]) {
      fixture.platform.cancelDenial = { status: denial.status, code: denial.code }
      const response = await post(fixture, { request: { sessionId: fixture.sessionId } })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ type: 'server-response', result: { ok: false,
        error: { code: denial.remote } } })
    }
    expect(cancellations(fixture).map(call => call.path)).toEqual(['/native/sessions/cancel', '/native/sessions/cancel'])
    expect(fixture.platform.queued).toEqual(queued)
  }))

test('a false or extended Platform acknowledgement cannot masquerade as accepted native cancellation', () =>
  nativeHost(async (fixture) => {
    const queued = structuredClone(fixture.platform.queued)
    for (const acknowledgement of [{ accepted: false }, { accepted: true, queuedDeleted: true }]) {
      fixture.platform.acknowledgement = acknowledgement
      const response = await post(fixture, { request: { sessionId: fixture.sessionId } })
      expect(await response.json()).toMatchObject({ type: 'server-response', result: { ok: false,
        error: { code: 'gateway/arguments-invalid' } } })
    }
    expect(cancellations(fixture).map(call => call.path)).toEqual(['/native/sessions/cancel', '/native/sessions/cancel'])
    expect(fixture.platform.queued).toEqual(queued)
  }))
