import { Context } from '@deepseek-ai/cordis'
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

const contexts: Context[] = []
const gates: Array<() => void> = []
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
  vi.restoreAllMocks()
})

describe('root authentication resources remain closed on incomplete or failed initialization', () => {
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
    if (typeof password !== 'function') throw new Error('Expected a per-connection credential resolver')
    await expect(password()).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
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
