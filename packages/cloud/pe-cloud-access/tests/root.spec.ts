import { Context, FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { boot, StartupError } from '@deepseek-ai/dsh-app-boot'
import { CredentialProvider, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BetterAuthAccess } from '../src/auth.ts'
import { PeAuthService } from '../src/auth-root.ts'
import { assertAuthSchemaCurrent } from '../src/auth-schema.ts'
import { AuthRootConfigSchema, parseAuthRootConfig, type AuthRootConfig } from '../src/root-config.ts'
import * as root from '../src/root.ts'
import { CloudIngress } from '../src/ingress.ts'
import { ingressConfig } from './ingress-fixture.ts'

const contexts: Context[] = []
const gates: Array<() => void> = []
const directories: string[] = []
const requestId = 'root-schema-test' as Branded<'pe-request-id'>
const testSecret = 'root-resource-test-secret-thirty-two-bytes-123456'

// Only the external credential read is controlled. Authentication and PostgreSQL use the real libraries.
class TestCredentials extends CredentialProvider {
  resolveRead: (ref: CredentialRef) => Promise<ResolvedCredential | undefined> = () =>
    Promise.resolve({ value: testSecret, source: 'test' })
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> { return this.resolveRead(ref) }
  override describe(): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: false }) }
  override set(): Promise<void> { return Promise.reject(new Error('test credentials are read-only')) }
  override unset(): Promise<void> { return Promise.reject(new Error('test credentials are read-only')) }
  override readRecord(): Promise<undefined> { return Promise.resolve(undefined) }
  override describeRecord(): Promise<{ configured: false; writable: false }> {
    return Promise.resolve({ configured: false, writable: false })
  }
  override listRecords(): Promise<[]> { return Promise.resolve([]) }
  override modifyRecord(
    _key: CredentialKey, _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<undefined> {
    return Promise.reject(new Error('test credentials are read-only'))
  }
  override deleteRecord(): Promise<void> { return Promise.reject(new Error('test credentials are read-only')) }
}

function config(): AuthRootConfig {
  return {
    publicOrigin: 'http://127.0.0.1:4100', deploymentMode: 'development', trustedProxyAddresses: [], authSecretRef: 'AUTH_ROOT_SPEC_SECRET',
    sessionRecheckMs: 50, authCheckTimeoutMs: 1000, maxPeers: 4, maxPeersPerAccount: 2,
    maxPeerWaiters: 8, maxPeerWaitersPerAccount: 4, maxPeerCarriers: 8, maxPeerCarriersPerAccount: 4,
    maxPeerCarriersPerLogin: 2, peerCloseTimeoutMs: 100, maxAuthOperations: 4,
    maxTrackedLogins: 8, maxTrackedLoginsPerAccount: 4, maxAuthInvalidations: 4,
    bindingFields: { accountHeader: 'x-pe-account', generationHeader: 'x-pe-generation', accountQuery: 'peAccount', generationQuery: 'peGeneration' },
    database: { host: '127.0.0.1', port: 1, user: 'root_spec', database: 'unavailable', passwordRef: 'AUTH_ROOT_SPEC_PASSWORD', ssl: false },
    pool: {
      maxConnections: 2, connectionTimeoutMs: 50, statementTimeoutMs: 1000, lockTimeoutMs: 100,
      idleTimeoutMs: 100, idleTransactionTimeoutMs: 1000, maxLifetimeSeconds: 10,
    },
    startupTimeoutMs: 5000, secretResolveTimeoutMs: 500, maxSecretOperations: 2, maxSecretBytes: 128,
  }
}

async function context(): Promise<{ ctx: Context; credentials: TestCredentials }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TestCredentials)
  return { ctx, credentials: ctx.credentials as TestCredentials }
}

afterEach(async () => {
  for (const release of gates.splice(0)) release()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function bootAuthentication(read: TestCredentials['resolveRead']): {
  readonly actual: Promise<Context>
  readonly context: () => Context
  readonly credentialDisposed: () => boolean
} {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'access-root-loader-')))
  directories.push(directory)
  const path = join(directory, 'cordis.yml')
  // boot's required-entry policy uses entry ids. This id makes authentication failure fatal without installing a Web server.
  writeFileSync(path, JSON.stringify([
    { id: 'credentials', name: 'cordis:controlled-root-credentials' },
    { id: 'webserver', name: 'cordis:actual-access-root', config: { ...config(), secretResolveTimeoutMs: 2000 } },
  ]))
  let context: Context | undefined
  let credentialDisposed = false
  const actual = boot('access-root-loader-regression', path, [], (ctx) => {
    context = ctx
    contexts.push(ctx)
    Object.assign(ctx.loader.builtins, {
      'actual-access-root': root,
      'controlled-root-credentials': {
        apply(scope: Context): void {
          const credentials = new TestCredentials(scope)
          credentials.resolveRead = read
          scope.effect(() => () => { credentialDisposed = true }, 'access test: observe credential provider disposal')
        },
      },
    })
  })
  return {
    actual,
    context: () => {
      if (context === undefined) throw new Error('Actual boot preparation did not run')
      return context
    },
    credentialDisposed: () => credentialDisposed,
  }
}

describe('root authentication resources remain closed on incomplete or failed initialization', () => {
  it('preserves the explicit library sign-up policy through Root configuration parsing', () => {
    expect(parseAuthRootConfig({ ...config(), disableSignUp: true }).disableSignUp).toBe(true)
    expect(parseAuthRootConfig({ ...config(), disableSignUp: false }).disableSignUp).toBe(false)
    expect(() => z.resolve({ ...config(), disableSignUp: 'yes' }, AuthRootConfigSchema, {})).toThrow()
  })
  it('keeps real Loader boot pending and propagates a missing secret through startup failure and provider cleanup', async () => {
    const secret = Promise.withResolvers<ResolvedCredential | undefined>()
    const entered = Promise.withResolvers<undefined>()
    gates.push(() => { secret.resolve(undefined) })
    const read = vi.fn(() => { entered.resolve(undefined); return secret.promise })
    const close = vi.spyOn(PeAuthService.prototype, 'close')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const loading = bootAuthentication(read)
    let settled = false
    const outcome = loading.actual.then(
      (value) => { settled = true; return { state: 'fulfilled' as const, value } },
      (error: unknown) => { settled = true; return { state: 'rejected' as const, error } },
    )
    try {
      await entered.promise
      const ctx = loading.context()
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'webserver')
      expect(entry?.fiber?.state).toBe(FiberState.LOADING)
      expect(ctx.get('peAuth')).toBeUndefined()
      await nextTurn()
      expect(settled).toBe(false)
      expect(loading.credentialDisposed()).toBe(false)
      secret.resolve(undefined)
      const result = await outcome
      expect(result.state).toBe('rejected')
      if (result.state !== 'rejected') throw new Error('Missing authentication secret did not reject boot')
      expect(result.error).toBeInstanceOf(StartupError)
      if (!(result.error instanceof StartupError)) throw new Error('Expected native boot startup diagnostics')
      const failure = result.error.entries.find(entry => entry.id === 'webserver')
      expect(failure?.module).toBe('cordis:actual-access-root')
      expect(failure?.required).toBe(true)
      if (failure?.outcome.kind !== 'failed') throw new Error('Authentication activation failure was not retained')
      expect(failure.outcome.error).toMatchObject({ code: 'cloud/account-unavailable' })
      const service = close.mock.contexts[0]
      if (!(service instanceof PeAuthService)) throw new Error('Actual authentication cleanup was not called')
      expect(service.observe()).toMatchObject({ phase: 'closed', pendingSecrets: 0, poolAllocated: false, requestAdmission: 'closed' })
      expect(ctx.get('peAuth')).toBeUndefined()
      expect(ctx.get('credentials')).toBeUndefined()
      expect(loading.credentialDisposed()).toBe(true)
      expect(read).toHaveBeenCalledTimes(1)
      await nextTurn()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      secret.resolve(undefined)
      await outcome
      await loading.context().fiber.dispose()
      process.off('unhandledRejection', unhandled)
    }
  })

  it('holds actual Loader disposal until the pending credential read settles without an unhandled rejection', async () => {
    const secret = Promise.withResolvers<ResolvedCredential | undefined>()
    const entered = Promise.withResolvers<undefined>()
    gates.push(() => { secret.resolve(undefined) })
    const close = vi.spyOn(PeAuthService.prototype, 'close')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const loading = bootAuthentication(() => { entered.resolve(undefined); return secret.promise })
    const outcome = loading.actual.then(value => value, (error: unknown) => error)
    try {
      await entered.promise
      const ctx = loading.context()
      expect(ctx.get('peAuth')).toBeUndefined()
      let disposed = false
      const closing = ctx.fiber.dispose().then(() => { disposed = true })
      await nextTurn()
      expect(disposed).toBe(false)
      const service = close.mock.contexts[0]
      if (!(service instanceof PeAuthService)) throw new Error('Actual authentication cleanup was not called')
      expect(service.observe()).toMatchObject({ pendingSecrets: 1, poolAllocated: false, requestAdmission: 'closed' })
      secret.resolve(undefined)
      await closing
      await outcome
      expect(disposed).toBe(true)
      expect(service.observe()).toMatchObject({ phase: 'closed', pendingSecrets: 0, poolAllocated: false })
      expect(ctx.get('peAuth')).toBeUndefined()
      expect(loading.credentialDisposed()).toBe(true)
      await nextTurn()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      secret.resolve(undefined)
      await outcome
      await loading.context().fiber.dispose()
      process.off('unhandledRejection', unhandled)
    }
  })

  it('requires every database and pool setting instead of accepting ambient connection defaults', () => {
    for (const field of Object.keys(config().database)) {
      const missing = { ...config(), database: Object.fromEntries(Object.entries(config().database).filter(([key]) => key !== field)) }
      expect(() => AuthRootConfigSchema(missing as AuthRootConfig)).toThrow()
    }
    for (const field of Object.keys(config().pool)) {
      const missing = { ...config(), pool: Object.fromEntries(Object.entries(config().pool).filter(([key]) => key !== field)) }
      expect(() => AuthRootConfigSchema(missing as AuthRootConfig)).toThrow()
    }
    const parsed = parseAuthRootConfig(config())
    expect(parsed.database.port).toBe(1)
    expect(parsed.pool.maxConnections).toBe(2)
    expect(parsed).not.toBe(config())
  })

  it('rejects invalid references, unbounded budgets and incompatible secret/SQL limits without echoing configuration', () => {
    const invalid = [
      { ...config(), authSecretRef: 'embedded/private-secret' },
      { ...config(), maxSecretBytes: 31 },
      { ...config(), secretResolveTimeoutMs: Infinity },
      { ...config(), startupTimeoutMs: 0 },
      { ...config(), maxSecretOperations: 0 },
      { ...config(), pool: { ...config().pool, lockTimeoutMs: 1001 } },
      { ...config(), pool: { ...config().pool, maxConnections: 0 } },
      { ...config(), database: { ...config().database, ssl: undefined } },
    ]
    for (const input of invalid) {
      expect(() => parseAuthRootConfig(input as AuthRootConfig)).toThrow('Cloud authentication root requires explicit valid database')
      try { parseAuthRootConfig(input as AuthRootConfig) } catch (error) { expect(String(error)).not.toContain('embedded/private-secret') }
    }
  })

  it('requires the official credentials service before allocating a pool', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const end = vi.spyOn(pg.Pool.prototype, 'end')
    await expect(root.apply(ctx, config())).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(ctx.get('peAuth')).toBeUndefined()
    expect(end).not.toHaveBeenCalled()
    expect(root.inject).toEqual(['credentials'])
  })

  it.each([undefined, { value: '', source: 'test' }, { value: 'short', source: 'test' }, { value: '界'.repeat(50), source: 'test' }])(
    'does not create a pool when the official secret read is missing or exceeds its byte budget', async (resolved) => {
      const { ctx, credentials } = await context()
      credentials.resolveRead = () => Promise.resolve(resolved)
      const end = vi.spyOn(pg.Pool.prototype, 'end')
      await expect(root.apply(ctx, config())).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
      await ctx.peAuth.close()
      expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closed', requestAdmission: 'closed', poolAllocated: false, pendingSecrets: 0 })
      expect(end).not.toHaveBeenCalled()
    },
  )

  it('retains a timed-out credential read and disposal until its actual settlement, without allocating a late pool', async () => {
    const { ctx, credentials } = await context()
    const gate = Promise.withResolvers<ResolvedCredential>()
    gates.push(() => { gate.resolve({ value: testSecret, source: 'test' }) })
    credentials.resolveRead = () => gate.promise
    const end = vi.spyOn(pg.Pool.prototype, 'end')
    await expect(root.apply(ctx, { ...config(), secretResolveTimeoutMs: 10 })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closing', pendingSecrets: 1, requestAdmission: 'closed', poolAllocated: false })
    const closed = vi.fn()
    const actualClose = ctx.peAuth.close().then(closed)
    await Promise.resolve()
    expect(closed).not.toHaveBeenCalled()
    await expect(PeAuthService.mountRoot(ctx, config())).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    gate.resolve({ value: testSecret, source: 'test' })
    await actualClose
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closed', pendingSecrets: 0, poolAllocated: false })
    expect(end).not.toHaveBeenCalled()
  })

  it('does not continue startup after the root observation deadline even if its secret read finishes later', async () => {
    const { ctx, credentials } = await context()
    const gate = Promise.withResolvers<ResolvedCredential>()
    gates.push(() => { gate.resolve({ value: testSecret, source: 'test' }) })
    credentials.resolveRead = () => gate.promise
    await expect(root.apply(ctx, { ...config(), startupTimeoutMs: 10 })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    const closing = ctx.peAuth.close()
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closing', pendingSecrets: 1, poolAllocated: false })
    gate.resolve({ value: testSecret, source: 'test' })
    await closing
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closed', poolAllocated: false })
  })

  it('closes the real finite pool after a real PostgreSQL connection failure and returns a credential-free error', async () => {
    const { ctx, credentials } = await context()
    const read = vi.spyOn(credentials, 'resolve')
    const end = vi.spyOn(pg.Pool.prototype, 'end')
    const failure = await root.apply(ctx, config()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'cloud/account-unavailable', status: 503 })
    expect(JSON.stringify(failure)).not.toContain(testSecret)
    expect(JSON.stringify(failure)).not.toContain('root_spec')
    await ctx.peAuth.close()
    expect(read.mock.calls[0]?.[0]).toBe('AUTH_ROOT_SPEC_SECRET')
    expect(end).toHaveBeenCalledTimes(1)
    const pool = end.mock.instances[0] as pg.Pool & { readonly options: pg.PoolConfig }
    expect(pool.options).toMatchObject({
      host: '127.0.0.1', port: 1, user: 'root_spec', database: 'unavailable', ssl: false,
      max: 2, connectionTimeoutMillis: 50, statement_timeout: 1000, lock_timeout: 100,
      idleTimeoutMillis: 100, idle_in_transaction_session_timeout: 1000, query_timeout: 0,
      maxLifetimeSeconds: 10, options: '-c search_path=public',
    })
    const password = pool.options.password
    expect(typeof password).toBe('function')
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closed', pendingAuthentication: 0, pendingSecrets: 0, requestAdmission: 'closed' })
    expect(ctx.peAuth.observe()).not.toHaveProperty('ingress')
    if (typeof password !== 'function') throw new Error('Expected a per-connection credential resolver')
    await expect(password()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('keeps initialization pending without allocating authentication resources when routing dependencies are absent', async () => {
    const { ctx } = await context()
    const mount = vi.spyOn(PeAuthService, 'mountRoot')
    const inspect = vi.spyOn(BetterAuthAccess.prototype, 'planMigrations')
    const install = vi.spyOn(CloudIngress.prototype, 'install')
    await root.apply(ctx, { ...config(), ingress: ingressConfig() })
    expect(ctx.get('peAuth')).toBeUndefined()
    expect(mount).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    expect(ctx.get('peAuth')).toBeUndefined()
    expect(mount).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('retains the real pool through late library creation and timed-out per-connection secret work', async () => {
    const { ctx, credentials } = await context()
    const libraryGate = Promise.withResolvers<undefined>()
    const passwordGate = Promise.withResolvers<ResolvedCredential>()
    const created = Promise.withResolvers<undefined>()
    gates.push(() => { libraryGate.resolve(undefined); passwordGate.resolve({ value: 'test-password', source: 'test' }) })
    credentials.resolveRead = ref => ref === 'AUTH_ROOT_SPEC_SECRET'
      ? Promise.resolve({ value: testSecret, source: 'test' }) : passwordGate.promise
    const original = BetterAuthAccess.create.bind(BetterAuthAccess)
    const create = vi.spyOn(BetterAuthAccess, 'create').mockImplementation(async (...args) => {
      const adapter = await original(...args)
      created.resolve(undefined)
      await libraryGate.promise
      return adapter
    })
    const end = vi.spyOn(pg.Pool.prototype, 'end')
    const started = root.apply(ctx, { ...config(), startupTimeoutMs: 100, secretResolveTimeoutMs: 10, maxSecretOperations: 1 })
      .catch((error: unknown) => error)
    await created.promise
    const pool = create.mock.calls[0]![1] as pg.Pool & { readonly options: pg.PoolConfig }
    const password = pool.options.password
    if (typeof password !== 'function') throw new Error('Expected a per-connection credential resolver')
    await expect(password()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(password()).rejects.toMatchObject({ code: 'cloud/capacity' })
    expect(ctx.peAuth.observe()).toMatchObject({ pendingSecrets: 1, poolAllocated: true, requestAdmission: 'closed' })
    expect(await started).toMatchObject({ code: 'cloud/account-unavailable' })
    const closed = ctx.peAuth.close()
    expect(end).not.toHaveBeenCalled()
    libraryGate.resolve(undefined)
    await Promise.resolve()
    expect(end).not.toHaveBeenCalled()
    passwordGate.resolve({ value: 'test-password', source: 'test' })
    await closed
    expect(end).toHaveBeenCalledTimes(1)
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closed', pendingSecrets: 0, poolAllocated: false })
  })

  it('retains unconfirmed pool cleanup and exposes only a fixed safe failure without retrying end', async () => {
    const { ctx } = await context()
    const log = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const create = vi.spyOn(BetterAuthAccess, 'create')
    const end = vi.spyOn(pg.Pool.prototype, 'end').mockImplementation(() => { throw new Error('private SQL and password text') })
    await expect(root.apply(ctx, config())).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
    await expect(ctx.peAuth.close()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    await expect(ctx.peAuth.close()).rejects.toMatchObject({ code: 'cloud/stop-unconfirmed' })
    expect(ctx.peAuth.observe()).toMatchObject({ phase: 'closing', requestAdmission: 'closed', poolAllocated: true })
    expect(end).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain('private SQL')
    end.mockRestore()
    // Release the test-owned real pool after asserting that the provider retains its failed cleanup observation.
    await create.mock.calls[0]![1].end()
  })

  it.each(['toBeCreated', 'toBeAdded', 'toBeAddedIndexes', 'unsafeChanges', 'schemaProblems'] as const)(
    'rejects library migration category %s without executing or exposing SQL', (field) => {
      const runMigrations = vi.fn(async () => {})
      const compileMigrations = vi.fn(async () => 'private SQL')
      const base = {
        toBeCreated: [], toBeAdded: [], toBeAddedIndexes: [], unsafeChanges: [], schemaProblems: [], runMigrations, compileMigrations,
      }
      const plan: Parameters<typeof assertAuthSchemaCurrent>[0] = {
        ...base,
        toBeCreated: field === 'toBeCreated' ? [{ table: 'private table', fields: {}, order: 0 }] : [],
        toBeAdded: field === 'toBeAdded' ? [{ table: 'private table', fields: {}, order: 0 }] : [],
        toBeAddedIndexes: field === 'toBeAddedIndexes'
          ? [{ table: 'private table', name: 'private index', index: { name: 'private index', columns: ['id'], unique: false } }] : [],
        unsafeChanges: field === 'unsafeChanges' ? ['private SQL'] : [],
        schemaProblems: field === 'schemaProblems' ? ['private SQL'] : [],
      }
      expect(() => { assertAuthSchemaCurrent(plan, requestId) }).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
      expect(runMigrations).not.toHaveBeenCalled()
      expect(compileMigrations).not.toHaveBeenCalled()
    },
  )
})
