/** Independent API review: owned HTTP adapters and real isolated PG, without a full Profile or TLS browser. */
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PoolClient } from 'pg'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { BrowserAgentAuth, type AgentVerifier } from '../src/host/browser-auth.ts'
import { bearer, readJson, sendFailure, sendJson } from '../src/http.ts'
import { digest, type IdentityService } from '../src/platform/identity.ts'
import { NativePreferences, nativeModelSelect, nativePreferenceWrite } from '../src/platform/native-preferences.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { requestId } from '../src/contracts.ts'
import { ACCOUNT_ERROR_CODES } from '../src/account-contracts.ts'
import { serveTrustedAccountUi } from '../src/trusted-account-ui.ts'
import { cloudFixture } from './cloud-fixture.ts'

const platformOrigin = 'https://platform.example.test'
const eventLimits = { maxEventBytes: 524_288, maxHistoryBytes: 67_108_864, maxHistoryEvents: 100_000 }
const taskLimits = { maxEventBytes: 524_288, leaseMs: 30_000, maxPendingPerUser: 8, maxActivePerUser: 1 }
type CloudCase = Parameters<Parameters<typeof cloudFixture>[0]>[0]

function first<T>(items: readonly T[]): T {
  const item = items[0]
  if (item === undefined) throw new Error('Owned review fixture returned no result')
  return item
}

async function listener<T>(handle: (request: IncomingMessage, response: ServerResponse, origin: string) => Promise<void>,
  run: (origin: string) => Promise<T>): Promise<T> {
  let origin = ''
  const server = createServer((request, response) => {
    void handle(request, response, origin).catch((error: unknown) => { sendFailure(response, error) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Owned review HTTP listener did not bind')
    origin = `http://127.0.0.1:${address.port}`
    return await run(origin)
  } finally {
    server.close(); await once(server, 'close')
  }
}

async function hosts<T>(identities: IdentityService,
  run: (a: string, b: string, calls: readonly string[]) => Promise<T>): Promise<T> {
  const calls: string[] = []
  const authentications = new Map<string, BrowserAgentAuth>()
  const verifier: AgentVerifier = {
    async call(path, token) {
      calls.push(path)
      if (path === '/identity/exchange') return { token: await identities.exchange(token) }
      if (path === '/identity/me') return identities.authenticate(token)
      throw new Error('Unexpected authentic review verifier endpoint')
    },
  }
  const handle = async (request: IncomingMessage, response: ServerResponse, origin: string) => {
    let auth = authentications.get(origin)
    if (!auth) { auth = new BrowserAgentAuth(origin, platformOrigin, verifier); authentications.set(origin, auth) }
    if (request.url === '/auth/exchange') await auth.exchange(request, response)
    else {
      const result = await auth.authenticate(request, request.url === '/native/api/navigation')
      sendJson(response, { fromCookie: result.fromCookie, username: result.user.username })
    }
  }
  return listener(handle, a => listener(handle, b => run(a, b, calls)))
}

async function refusal(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ error })
}

test('single-path tuple accepts exactly the original length-one string array cases at a JSON boundary', () => {
  const previous = z.array(z.string()).length(1)
  const paths: unknown[] = [[], [''], ['enabled'], ['welcomeNoticeVersion'], ['__proto__'], ['constructor'], ['启用'],
    ['enabled', 'nested'], [null], [true], [1], [{}], [['enabled']], 'enabled', null, {}]
  for (const path of paths) {
    const wire: unknown = JSON.parse(JSON.stringify({ ns: 'ui-settings', mode: 'mutate', value: [{ op: 'unset', path }] }))
    expect(nativePreferenceWrite.safeParse(wire).success).toBe(previous.safeParse(path).success)
  }
})

test('cookie prefix lookalikes, malformed duplicate values and unsafe navigations fail before the real verifier', () =>
  cloudFixture(async ({ identities, alice }) => hosts(identities, async (a, _b, calls) => {
    const cookie = `pe_agent=${alice.token}`
    const cases: { path: string; headers: Record<string, string>; status: number; error: string }[] = [
      { path: '/native/api-extra', headers: { origin: a, cookie }, status: 401, error: 'unauthorized' },
      { path: '/api/powerEvolve-extra', headers: { origin: a, cookie }, status: 401, error: 'unauthorized' },
      { path: '/native/api/check', headers: { origin: a, cookie: `pe_agent=short; ${cookie}` }, status: 401, error: 'ambiguous_credential' },
      { path: '/native/api/check', headers: { origin: a, cookie: `${cookie}; pe_agent=` }, status: 401, error: 'ambiguous_credential' },
      { path: '/native/api/navigation', headers: { origin: 'null', cookie, 'sec-fetch-site': 'none' }, status: 403, error: 'invalid_origin' },
      { path: '/native/api/navigation', headers: { cookie, 'sec-fetch-site': 'same-site' }, status: 403, error: 'invalid_origin' },
    ]
    for (const item of cases) await refusal(await fetch(a + item.path, { headers: item.headers }), item.status, item.error)
    await refusal(await fetch(`${a}/native/api/navigation`, { method: 'POST', headers: { cookie } }), 403, 'invalid_origin')
    expect(calls).toEqual([])
    for (const path of ['/native/api', '/native/api/check', '/api/powerEvolve', '/api/powerEvolve/check']) {
      const response = await fetch(a + path, { headers: { cookie, origin: a } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ fromCookie: true, username: 'alice' })
    }
    expect(calls).toHaveLength(4)
  })))

test('one winner of simultaneous cross-Host exchanges is admitted on both replicas and its replacement revocation reaches both', () =>
  cloudFixture(async ({ identities, pool, alice, bob }) => hosts(identities, async (a, b) => {
    const exchange = (origin: string) => fetch(`${origin}/auth/exchange`, { method: 'POST',
      headers: { origin: platformOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ token: alice.token }) })
    const responses = await Promise.all([exchange(a), exchange(b)])
    expect(responses.map(response => response.status).sort((x, y) => x - y)).toEqual([200, 401])
    const winner = responses.find(response => response.status === 200)
    if (!winner) throw new Error('Expected one exchanged browser credential')
    const cookies = winner.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    const cookie = first(first(cookies).split(';'))
    const replacement = cookie.slice('pe_agent='.length)
    expect(first(cookies).split(';')[0]).toBe(cookies[1]?.split(';')[0])
    for (const response of responses) await response.arrayBuffer()
    expect((await pool.query<{ digest: string }>('SELECT digest FROM pe_credentials WHERE digest=$1', [digest(alice.token)])).rows).toEqual([])
    for (const origin of [a, b]) {
      const response = await fetch(`${origin}/native/api/check`, { headers: { origin, cookie } })
      expect(response.status).toBe(200); await response.arrayBuffer()
    }
    await identities.logout(replacement)
    for (const origin of [a, b]) {
      await refusal(await fetch(`${origin}/native/api/check`, { headers: { origin, cookie } }), 401, 'unauthorized')
      await refusal(await fetch(`${origin}/native/api/check`, { headers: { authorization: `Bearer ${alice.token}` } }), 401, 'unauthorized')
      const unrelated = await fetch(`${origin}/native/api/check`, { headers: { authorization: `Bearer ${bob.token}` } })
      expect(unrelated.status).toBe(200); await unrelated.arrayBuffer()
    }
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_credentials WHERE user_id=$1', [alice.user.userId])).rows)
      .toEqual([{ n: 0 }])
  })))

test('trusted manifests reject additional durable path and MIME hazards while query-bearing listed assets retain exact bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pe-employee7-auth-assets-'))
  try {
    await writeFile(join(directory, 'index.html'), 'owned index')
    await writeFile(join(directory, 'asset.js'), 'owned script')
    await listener(async (request, response, origin) => {
      const path = new URL(request.url ?? '/', origin).pathname
      if (!await serveTrustedAccountUi(path, response, directory)) { response.writeHead(404); response.end() }
    }, async (origin) => {
      for (const path of ['nested/./asset.js', 'nested\\asset.js', 'asset.js/', 'asset.PNG', 'asset.constructor',
        '%2e%2e/asset.js', '.hidden.js', 'asset.js\0']) {
        await writeFile(join(directory, 'asset-list.json'), JSON.stringify(['index.html', path]))
        await refusal(await fetch(`${origin}/account`), 503, 'service_unavailable')
      }
      await writeFile(join(directory, 'asset-list.json'), '{')
      await refusal(await fetch(`${origin}/account`), 503, 'service_unavailable')
      await writeFile(join(directory, 'asset-list.json'), JSON.stringify(['index.html', 'asset.js']))
      const listed = await fetch(`${origin}/account/asset.js?cache=owned`)
      expect(listed.status).toBe(200)
      expect(listed.headers.get('content-type')).toBe('text/javascript')
      expect(listed.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await listed.text()).toBe('owned script')
      const unknown = await fetch(`${origin}/account/%61sset.js`)
      expect(unknown.status).toBe(404); expect(await unknown.text()).toBe('')
      expect(await readFile(join(directory, 'asset.js'), 'utf8')).toBe('owned script')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('wire Settings schema and field refusals preserve public error codes and durable personal values', () =>
  cloudFixture(async ({ pool, identities, alice }) => {
    const preferences = new NativePreferences(pool, eventLimits)
    await preferences.write(alice.user, alice.token, nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'replace',
      value: { enabled: true }, expectedRevision: 1 }))
    await listener(async (request, response) => {
      const token = bearer(request), user = await identities.authenticate(token)
      sendJson(response, await preferences.write(user, token, nativePreferenceWrite.parse(await readJson(request, 16_384))))
    }, async (origin) => {
      const post = (input: unknown) => fetch(origin, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`,
        'content-type': 'application/json' }, body: JSON.stringify(input) })
      for (const path of [[], ['enabled', 'nested'], [42]]) await refusal(await post({ ns: 'ui-settings', mode: 'mutate',
        value: [{ op: 'unset', path }], expectedRevision: 2 }), 400, 'invalid_request')
      for (const path of [['__proto__'], ['constructor'], ['unknown']]) await refusal(await post({ ns: 'ui-settings', mode: 'mutate',
        value: [{ op: 'unset', path }], expectedRevision: 2 }), 400, 'native_settings_rejected')
      await refusal(await post({ ns: 'ui-settings', mode: 'replace', value: { enabled: 'false' }, expectedRevision: 2 }), 400, 'invalid_request')
      await refusal(await post({ ns: 'ui-settings', mode: 'replace', value: {}, expectedRevision: 1 }), 409, 'native_settings_conflict')
      await refusal(await post({ ns: 'power-evolve-platform', mode: 'replace', value: {} }), 400, 'invalid_request')
      expect(await preferences.read(alice.user, 'ui-settings')).toEqual({ value: { enabled: true }, revision: 2 })
    })
  }))

/** Hold this case's account row until the actual write waits, then change durable admission state. */
async function invalidateWaitingWrite(f: CloudCase, mode: 'revoked' | 'expired' | 'disabled', preferences: NativePreferences) {
  const blocker: PoolClient = await f.pool.connect()
  let locked = false
  let work: Promise<PromiseSettledResult<Awaited<ReturnType<NativePreferences['write']>>>[]> | undefined
  try {
    await blocker.query('BEGIN'); locked = true
    await blocker.query('SELECT id FROM pe_users WHERE id=$1 FOR NO KEY UPDATE', [f.alice.user.userId])
    const pid = first((await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows).pid
    work = Promise.allSettled([preferences.write(f.alice.user, f.alice.token, nativePreferenceWrite.parse({ ns: 'ui-settings',
      mode: 'replace', value: { enabled: true }, expectedRevision: 1 }))])
    const deadline = Date.now() + 5000
    for (;;) {
      const waiting = await f.pool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))`, [pid])
      if (first(waiting.rows).n === 1) break
      if (Date.now() >= deadline) throw new Error('Preference write did not reach the owned account lock')
      await delay(25)
    }
    if (mode === 'revoked') await blocker.query('DELETE FROM pe_credentials WHERE digest=$1', [digest(f.alice.token)])
    else if (mode === 'expired') await blocker.query('UPDATE pe_credentials SET expires_at=clock_timestamp()-interval \'1 second\' WHERE digest=$1', [digest(f.alice.token)])
    else await blocker.query('UPDATE pe_users SET enabled=false WHERE id=$1', [f.alice.user.userId])
    await blocker.query('COMMIT'); locked = false
    return first(await work)
  } finally {
    if (locked) await blocker.query('ROLLBACK')
    blocker.release(); await work
  }
}

test.each(['revoked', 'expired', 'disabled'] as const)('native write refuses %s admission after an observed real account-lock wait', mode =>
  cloudFixture(async (f) => {
    const preferences = new NativePreferences(f.pool, eventLimits)
    const result = await invalidateWaitingWrite(f, mode, preferences)
    if (result.status !== 'rejected') throw new Error('Invalidated credential persisted preferences')
    expect(result.reason).toMatchObject({ status: 401,
      code: mode === 'disabled' ? ACCOUNT_ERROR_CODES.disabled : ACCOUNT_ERROR_CODES.unauthorized })
    expect((await f.pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_native_preferences WHERE user_id=$1',
      [f.alice.user.userId])).rows).toEqual([{ n: 0 }])
    expect(await preferences.write(f.bob.user, f.bob.token, nativePreferenceWrite.parse({ ns: 'ui-settings', mode: 'replace',
      value: { enabled: false }, expectedRevision: 1 }))).toEqual({ value: { enabled: false }, revision: 2 })
  }))

test('real missing rows and writer leases retain model-selection refusals without appending preferences or events', () =>
  cloudFixture(async ({ pool, alice, bob }) => {
    const tasks = new TaskStore(pool, taskLimits), preferences = new NativePreferences(pool, eventLimits)
    const session = await tasks.create(alice.user, requestId.parse(randomUUID()), alice.token)
    const selection = nativeModelSelect.parse({ sessionId: session.sessionId, provider: 'power-evolve', model: 'trial-model' })
    const missing = nativeModelSelect.parse({ ...selection, sessionId: randomUUID() })
    await expect(preferences.selectModel(alice.user, alice.token, missing))
      .rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await expect(preferences.selectModel(bob.user, bob.token, selection)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
    await tasks.accept(alice.user, session.sessionId, requestId.parse(randomUUID()), 'owned writer', alice.token)
    if (!await tasks.claim(randomUUID())) throw new Error('Owned writer lease was not claimed')
    const before = first((await pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [session.sessionId])).rows)
    await pool.query('UPDATE pe_user_models SET enabled=false WHERE user_id=$1 AND model_id=$2', [alice.user.userId, 'trial-model'])
    await expect(preferences.selectModel(alice.user, alice.token, selection)).rejects.toMatchObject({ status: 409, code: 'native_session_busy' })
    expect((await pool.query<{ event_count: number }>('SELECT event_count FROM pe_sessions WHERE id=$1', [session.sessionId])).rows).toEqual([before])
    expect((await pool.query<{ n: number }>('SELECT count(*)::integer AS n FROM pe_native_preferences WHERE user_id=$1', [alice.user.userId])).rows)
      .toEqual([{ n: 0 }])
  }))
