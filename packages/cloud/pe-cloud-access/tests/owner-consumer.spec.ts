/** Original Loader/Web/Auth/Runtime owners; external SQL and login answers only. No ready or storage seal is fabricated. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { getDefaultHighWaterMark } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { ExposureService } from '@deepseek-ai/dsh-pe-cloud-api'
import * as RuntimeRoot from '../../pe-cloud-runtime/src/root.ts'
import { AccountFactory } from '../../pe-cloud-runtime/src/account-factory.ts'
import { rootConfig as runtimeConfig, RootCredentials } from '../../pe-cloud-runtime/tests/root-control-fixture.ts'
import { registerInstanceSql, heartbeatInstanceSql, closeInstanceSql } from '../../pe-cloud-runtime/src/instance-sql.ts'
import { accountOwnerMigrationSql } from '../../pe-cloud-runtime/src/migrations/account-owners.ts'
import { instanceMigrationSql } from '../../pe-cloud-runtime/src/migrations/instances.ts'
import { type Auth } from 'better-auth'
import pg from 'pg'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as AccessRoot from '../src/root.ts'
import { BetterAuthAccess } from '../src/auth.ts'
import { CloudIngress } from '../src/ingress.ts'
import { OwnerRouting } from '../src/owner-routing.ts'
import { type OwnerForwardingConfig } from '../src/root-config.ts'
import { rootConfig as authConfig } from './ingress-fixture.ts'
import { identityFixture } from './identity-fixture.ts'
import { encodeOwnerHop, OWNER_HOP_HEADER, type OwnerHop } from '../src/owner-hop.ts'

const driver = vi.hoisted(() => ({ events: [] as string[], calls: [] as string[],
  run: undefined as undefined | ((text: string, values: readonly (string | null)[]) => Promise<{ rows: readonly unknown[] }>) }))
vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof import('pg')>()
  class Client {
    constructor(private readonly config: { password?: string | (() => Promise<string>) }) {}
    on() { return this }
    async connect() { if (typeof this.config.password === 'function') await this.config.password() }
    query(input: { text: string; values: readonly (string | null)[] }) {
      driver.calls.push(input.text)
      if (driver.run === undefined) throw new Error('Unconfigured SQL fixture')
      return driver.run(input.text, input.values)
    }
    async end() { driver.events.push('metadata-client-end') }
  }
  return { ...original, Client, Pool: original.default.Pool, defaults: { query_timeout: 0 },
    default: { ...original.default, Client } }
})
vi.mock('better-auth/db/migration', () => ({ getMigrations: async () => ({ toBeCreated: [], toBeAdded: [], toBeAddedIndexes: [],
  unsafeChanges: [], schemaProblems: [], runMigrations: async () => {}, compileMigrations: async () => '' }) }))

function materials() {
  const pki = identityFixture(), directory = realpathSync(mkdtempSync(join(tmpdir(), 'owner-consumer-')))
  if (!Buffer.isBuffer(pki.server.ca) || !Buffer.isBuffer(pki.server.cert) || !Buffer.isBuffer(pki.server.key)) throw new Error('Missing test PKI')
  for (const [name, bytes] of Object.entries({ 'ca.pem': pki.server.ca, 'server.pem': pki.server.cert, 'server.key': pki.server.key,
    'client.pem': pki.identity.cert, 'client.key': pki.identity.key })) {
    writeFileSync(join(directory, name), bytes, { mode: 0o600 })
  }
  const forwarding: OwnerForwardingConfig = {
    maxIdentities: 1, maxPemBytes: 32768, maxPemPathBytes: 4096, maxPeerPins: 2, maxHopBytes: 2048,
    peerCertificateSha256: [pki.clientPin], identities: [{ id: 'fixed-service', caFile: join(directory, 'ca.pem'),
      certFile: join(directory, 'client.pem'), keyFile: join(directory, 'client.key'),
      serverCertificateSha256: pki.identity.serverCertificateSha256,
      servername: 'owner.test' }], targets: [{ id: 'fixed-owner', origin: 'https://127.0.0.1:1', serviceIdentityRef: 'fixed-service' }],
    limits: { maxTargets: 2, maxTargetBytes: 512, maxTlsIdentityBytes: 65536, maxPathBytes: 4096, maxConcurrent: 4, maxQueued: 4,
      maxConnections: 16, maxHeaderPairs: 64, maxHeaderBytes: 16384, maxHeadBytes: 4096, maxChunkBytes: 4096, maxBufferedBytes: 131072,
      maxPendingBytes: 16 * 1024 * 1024, maxBodyBytes: 1048576, maxTunnelBytes: 1048576, queueTimeoutMs: 1000,
      connectTimeoutMs: 1000, operationTimeoutMs: 10000, closeTimeoutMs: 100 } }
  return { pki, directory, forwarding }
}

async function fixture() {
  const m = materials(), recipeVersion = 'owner-consumer-fixture', base = runtimeConfig(m.directory)
  vi.stubEnv('DSH_HOME', join(m.directory, 'dsh-home'))
  const rconfig = { ...base, recipeVersion, internalAddress: 'https://127.0.0.1:1', heartbeatIntervalMs: 60000 }
  driver.events.length = 0; driver.calls.length = 0
  vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation(() => { throw new Error('No authentication SQL transport is permitted') })
  const poolEnds = vi.spyOn(pg.Pool.prototype, 'end')
  driver.run = async (text, values) => {
    if (text === accountOwnerMigrationSql || text === instanceMigrationSql) return { rows: [] }
    if ([registerInstanceSql, heartbeatInstanceSql, closeInstanceSql].includes(text)) {
      if (text === closeInstanceSql) driver.events.push('instance-close')
      return { rows: [{ instance: { instanceId: values[0], internalAddress: values[1], recipeVersion: values[2],
        phase: text === closeInstanceSql ? 'closed' : 'registered', heartbeatAt: '2026-10-25T00:00:00.000000Z' } }] }
    }
    return { rows: [] }
  }
  const config = { ...authConfig(), publicOrigin: 'https://public.example.test', sessionRecheckMs: 1000, authCheckTimeoutMs: 40,
    startupTimeoutMs: 10000, secretResolveTimeoutMs: 1000,
    ingress: { ...authConfig().ingress!, sessionRecheckLeadMs: 100, ownerForwarding: m.forwarding } }
  const path = join(m.directory, 'cordis.yml')
  writeFileSync(path, JSON.stringify([
    { id: 'credentials', name: 'cordis:fixture-credentials' },
    { id: 'runtime', name: 'cordis:runtime-root', config: rconfig },
    { id: 'exposure', name: 'cordis:exposure-root', config: { recipeVersion, rpcEndpoints: [], streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] } },
    { id: 'webserver', name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0, compression: 'none',
      tls: { certFile: join(m.directory, 'server.pem'), keyFile: join(m.directory, 'server.key'),
        clientCa: { certFile: join(m.directory, 'ca.pem'), maxBytes: 32768 } },
      transportLimits: { maxHeaderPairs: 64, maxHeaderBytes: 16384, maxConnections: 16, highWaterMark: getDefaultHighWaterMark(false) } } },
    { id: 'access', name: 'cordis:access-root', config },
  ]))
  let root: Context | undefined
  const mounting = vi.spyOn(AccessRoot.PeAuthService, 'mountRoot')
  const release: { query?: () => void } = {}
  onTestFinished(async () => {
    release.query?.()
    try { await root?.fiber.dispose() }
    finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(m.directory, { recursive: true, force: true }) }
  })
  const graph = await boot('owner-consumer-private', path, [], (ctx) => {
    root = ctx
    Object.assign(ctx.loader.builtins, { 'fixture-credentials': { apply(scope: Context) {
      new RootCredentials(scope, async () => ({ value: 'owner-consumer-synthetic-secret-01234567890123456789', source: 'fixture' }))
    } }, 'runtime-root': RuntimeRoot, 'exposure-root': ExposureService, webserver: WebServer, 'access-root': AccessRoot })
  })
  expect(graph.get('peExposure')).toBeInstanceOf(ExposureService)
  await vi.waitFor(() => { expect(graph.get('peAuth')).toBeInstanceOf(AccessRoot.PeAuthService) }, { timeout: 3000, interval: 10 })
  expect(mounting).toHaveBeenCalledTimes(1)
  const runtime = graph.get('peAccountRuntime'), web = graph.get('webServer'), access = graph.get('peAuth')
  if (!(runtime instanceof RuntimeRoot.PeAccountRuntime)) throw new Error('Original Runtime Root missing')
  if (!(web instanceof WebServer)) throw new Error('Original WebServer missing')
  if (!(access instanceof AccessRoot.PeAuthService)) throw new Error('Original PeAuth missing')
  const auth: unknown = Reflect.get(access, 'auth')
  if (!(auth instanceof BetterAuthAccess)) throw new Error('Original auth adapter missing')
  const library = Reflect.get(auth, 'auth') as Auth
  const now = new Date(), login = { user: { id: 'original-account', name: 'Original library answer', email: 'original@example.test',
    emailVerified: true, createdAt: now, updatedAt: now }, session: { id: 'original-login', userId: 'original-account',
    token: 'synthetic-cookie-token', expiresAt: new Date(Date.now() + 60000), createdAt: now, updatedAt: now, ipAddress: null, userAgent: null } }
  const sessions = vi.spyOn(library.api, 'getSession').mockImplementation(async () => login)
  const call = (path: string, extra: string[] = [], client = false) => {
    const request = httpsRequest({ host: '127.0.0.1', port: web.port, servername: 'owner.test', ca: Buffer.from(m.pki.identity.ca),
      rejectUnauthorized: true, agent: false, path, headers: ['Host', 'public.example.test', 'Origin', config.publicOrigin, 'Cookie', 'original-cookie=one', ...extra],
      ...(client ? { cert: Buffer.from(m.pki.identity.cert), key: Buffer.from(m.pki.identity.key) } : {}) })
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      request.on('error', reject); request.on('response', (response) => {
        const chunks: Buffer[] = []; response.on('error', reject); response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }) })
      })
    })
    request.end(); return result
  }
  return { ...m, graph, runtime, web, access, auth, sessions, login, call, release, config, poolEnds }
}

it('uses real Loader client-CA ingress and rejects forged hop before auth or any account creation under an unsealed Root', async () => {
  const f = await fixture(), claim = vi.spyOn(AccountFactory.prototype, 'claimAndMount'), mount = vi.spyOn(AccountFactory.prototype, 'startNativeMount')
  const borrowed = vi.spyOn(f.runtime, 'borrowOwnedAccount')
  expect(f.runtime.activeInstanceId).toBeDefined()
  expect((await f.call('/cloud/bootstrap', [OWNER_HOP_HEADER, 'forged'])).status).toBe(403)
  const hop: OwnerHop = { accountId: brandString<OwnerHop['accountId']>('original-account'),
    recipientInstanceId: brandString<OwnerHop['recipientInstanceId']>('foreign-root'), epoch: brandString<OwnerHop['epoch']>('17'), recipeVersion: 'owner-consumer-fixture' }
  const marker = encodeOwnerHop(hop, 2048, brandString<Branded<'pe-request-id'>>('fixture-request'))
  expect((await f.call('/cloud/bootstrap', [OWNER_HOP_HEADER, marker], true)).status).toBe(403)
  expect((await f.call('/cloud/bootstrap', [], true)).status).toBe(403)
  const excess = Array.from({ length: 65 }, (_value, index) => ['X-Pad', String(index)]).flat()
  expect((await f.call('/cloud/bootstrap', excess)).status).toBe(429)
  expect((await f.call('/cloud/bootstrap')).status).toBe(503)
  expect(f.sessions).not.toHaveBeenCalled(); expect(borrowed).not.toHaveBeenCalled()
  expect(claim).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled()
})

it('retains the actual original Cookie recheck after caller timeout and Root close joins auth before instance closure', async () => {
  const f = await fixture(), id = brandString<Branded<'pe-request-id'>>('fixture-query')
  const principal = Promise.withResolvers<Awaited<ReturnType<BetterAuthAccess['authenticate']>>>()
  const remove = f.web.register({ kind: 'exact', path: '/fixture-authenticate', handler: async (request, response) => {
    const value = await f.auth.authenticate(request, id); principal.resolve(value); response.end('authenticated')
  } })
  expect((await f.call('/fixture-authenticate')).status).toBe(200)
  remove()
  const original = await principal.promise, gate = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.release.query = () => { gate.resolve(undefined) }
  f.sessions.mockImplementation(async () => { entered.resolve(undefined); await gate.promise; return f.login })
  let retained: Promise<void> | undefined, actualSettled = false, rootSettled = false
  const check = f.auth.recheckLogin(original, id, (actual) => { retained = actual; void actual.then(() => { actualSettled = true }) })
  await entered.promise
  await expect(check).rejects.toBeDefined()
  expect(retained).toBeDefined(); expect(actualSettled).toBe(false); expect(f.auth.pendingOperations).toBe(1)
  const closeAuth = f.access.close.bind(f.access)
  vi.spyOn(f.access, 'close').mockImplementation(() => {
    const actual = closeAuth()
    void actual.then(() => { driver.events.push('authentication-closed') })
    return actual
  })
  const closing = f.runtime.close(); void closing.then(() => { rootSettled = true })
  expect(rootSettled).toBe(false); expect(f.poolEnds).not.toHaveBeenCalled(); expect(driver.events).not.toContain('instance-close')
  gate.resolve(undefined); await retained; await closing
  expect(actualSettled).toBe(true); expect(rootSettled).toBe(true)
  expect(f.poolEnds).toHaveBeenCalledTimes(1)
  expect(driver.events.indexOf('authentication-closed')).toBeGreaterThanOrEqual(0)
  expect(driver.events.indexOf('authentication-closed')).toBeLessThan(driver.events.indexOf('instance-close'))
})

it('bounds protected TLS material reads and refuses an unprotected key before transport admission', async () => {
  const m = materials(); onTestFinished(() => { rmSync(m.directory, { recursive: true, force: true }) })
  await expect(OwnerRouting.prepare({ ...m.forwarding, maxPemBytes: 1 }, () => {})).rejects.toThrow()
  chmodSync(join(m.directory, 'client.key'), 0o644)
  await expect(OwnerRouting.prepare(m.forwarding, () => {})).rejects.toThrow()
  chmodSync(join(m.directory, 'client.key'), 0o600)
  writeFileSync(join(m.directory, 'client.key'), 'invalid-key')
  await expect(OwnerRouting.prepare(m.forwarding, () => {})).rejects.toThrow('Owner TLS identity is invalid.')
  writeFileSync(join(m.directory, 'client.key'), m.pki.identity.key)
  const routing = await OwnerRouting.prepare(m.forwarding, () => {})
  expect(routing.peerPins.has(m.pki.clientPin)).toBe(true)
  expect(routing.transport.observe()).toMatchObject({ retained: 0, reservedConnections: 0 })
  await routing.closeActual()
})

it('publishes the original PeAuth close Promise before ingress can synchronously reenter it', async () => {
  const f = await fixture(), ingress: unknown = Reflect.get(f.access, 'ingress')
  if (!(ingress instanceof CloudIngress)) throw new Error('Original ingress is absent')
  const closeIngress = ingress.closeActual.bind(ingress)
  let reentered: Promise<void> | undefined
  vi.spyOn(ingress, 'closeActual').mockImplementationOnce(() => {
    reentered = f.access.close()
    return closeIngress()
  })
  const closing = f.access.close()
  expect(reentered).toBe(closing); expect(f.access.close()).toBe(closing)
  await closing
  expect(f.poolEnds).toHaveBeenCalledTimes(1)
})
