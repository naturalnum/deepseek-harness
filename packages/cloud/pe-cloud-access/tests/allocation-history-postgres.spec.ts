import { readFileSync } from 'node:fs'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { PgOwnerExecutor } from '@deepseek-ai/dsh-pe-cloud-runtime/src/owner-pg-executor.ts'
import { OwnerPgNotSubmittedError } from '@deepseek-ai/dsh-pe-cloud-runtime/src/owner-pg-errors.ts'
import type { RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { allocationHistoryReader } from '@deepseek-ai/dsh-pe-opensandbox/src/allocation-history.ts'
import { allocationDatabase } from '@deepseek-ai/dsh-pe-opensandbox/src/allocation-database.ts'
import { PostgresAllocationStore } from '@deepseek-ai/dsh-pe-opensandbox/src/allocation-store.ts'
import { expect, it, vi } from 'vitest'
import { queryAllocationDiagnostics } from '../src/allocation-diagnostics.ts'

const requestId = 's13-history-fixture' as Branded<'pe-request-id'>
const fromMs = Date.parse('2026-11-18T07:00:00.000Z'), toMs = Date.parse('2026-11-18T08:00:00.000Z')
const input = { accountId: 'account-a', sessionId: 'session-a', fromMs, toMs, limit: 50 }
const authorized = { role: 'admin' as const, actorId: 'admin-a', authSessionId: 'login-a',
  accountId: input.accountId, sessionId: input.sessionId }
const fixturePath = process.env.DSH_S13_HISTORY_PG_FILE

function connection(path: string) {
  const fixture: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof fixture !== 'object' || fixture === null) throw new Error('Owned S13 fixture missing.')
  const { port, database, user, secretFile } = fixture as Record<string, unknown>
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof database !== 'string' || !/^s13_history_[a-f0-9]{12}$/.test(database)
    || user !== database || typeof secretFile !== 'string' || !secretFile.startsWith('/') || secretFile.includes('\n')) {
    throw new Error('Only the disposable S13 loopback PostgreSQL fixture is supported.')
  }
  const password = readFileSync(secretFile, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(password)) throw new Error('Invalid fixture login proof.')
  return { host: '127.0.0.1', port, database, user, password, ssl: false as const }
}

const seed = `INSERT INTO public.pe_sandbox_allocations (
    allocation_id,account_id,session_id,workspace_id,epoch,environment_version,provider,state,
    project_mount_version,requested_at,create_deadline_at,last_activity_at,last_checked_at,failure_code
  )
  SELECT allocation,account,session,'internal-workspace',row_number() over (), 'test-environment','test-provider',state,
    'internal-mount',observed::timestamptz,observed::timestamptz,observed::timestamptz,observed::timestamptz,reason
  FROM (VALUES
    ('tie-a','account-a','session-a','failed','2026-11-18T07:30:00.1001Z','provider-create-refused-before-create'),
    ('tie-z','account-a','session-a','failed','2026-11-18T07:30:00.1009Z','provider-rejected-before-execution-resource'),
    ('terminal-release','account-a','session-a','released','2026-11-18T07:25:00.000Z',NULL),
    ('uncertain-rejection','account-a','session-a','uncertain','2026-11-18T07:20:00.000Z','startup-expired'),
    ('masked','account-a','session-a','failed','2026-11-18T07:15:00.000Z','private-backend-token'),
    ('included-floor','account-a','session-a','failed','2026-11-18T07:00:00.000Z','cancelled-before-provider-create'),
    ('excluded-ceiling','account-a','session-a','failed','2026-11-18T08:00:00.000Z','startup-expired'),
    ('different-account','account-b','session-a','failed','2026-11-18T07:25:00.000Z','startup-expired'),
    ('different-session','account-a','session-b','failed','2026-11-18T07:25:00.000Z','startup-expired'),
    ('ordinary-create','account-a','session-a','creating','2026-11-18T07:25:00.000Z',NULL),
    ('ordinary-stopping','account-a','session-a','stopping','2026-11-18T07:25:00.000Z',NULL)
  ) AS fixture(allocation,account,session,state,observed,reason)`

it.skipIf(fixturePath === undefined)('reads actual allocation history through the production migration, Root driver, and Access authorization boundary', async () => {
  if (fixturePath === undefined) throw new Error('Explicit S13 PG fixture required.')
  const executor = new PgOwnerExecutor(connection(fixturePath), {
    maxConnections: 1, maxQueued: 0, queueTimeoutMs: 100, connectionTimeoutMs: 1500,
    statementTimeoutMs: 1500, lockTimeoutMs: 250, maxObservedOperations: 2, maxObservers: 2,
  })
  const query = vi.fn(executor.query.bind(executor))
  const database: RootMetadataDatabase = { query, wasNotSubmitted: cause => cause instanceof OwnerPgNotSubmittedError }
  const read = allocationHistoryReader(database, 1)
  try {
    const { rows } = await executor.query('SHOW server_version_num', [])
    expect(rows).toEqual([{ server_version_num: expect.stringMatching(/^17\d{4}$/) }])
    const store = new PostgresAllocationStore(allocationDatabase(database), {
      maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384, maxRows: 4,
      maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144,
    })
    await store.migrate()
    await executor.query(seed, [])
    await executor.query(`INSERT INTO public.pe_sandbox_allocations (
        allocation_id,account_id,session_id,workspace_id,epoch,environment_version,provider,state,
        project_mount_version,requested_at,create_deadline_at,last_activity_at,last_checked_at,failure_code
      )
      SELECT 'series-' || lpad(n::text,3,'0'),'account-a','session-many','workspace-a',n,'env','provider','failed','mount',
        $1::timestamptz,$1::timestamptz,$1::timestamptz,$1::timestamptz,'startup-expired' FROM generate_series(1,55) AS n`,
    ['2026-11-18T07:45:00.000Z'])
    query.mockClear()
    const authorize = async () => authorized
    const result = await queryAllocationDiagnostics(input, requestId, { authorize, read })
    expect(result.more).toBe(false)
    expect(result.entries.map(({ allocationId, state, reasonCode, stage }) => [allocationId, state, reasonCode, stage])).toEqual([
      ['tie-a', 'failed', 'provider-create-refused-before-create', 'provider-create'],
      ['tie-z', 'failed', 'provider-rejected-before-execution-resource', 'provider-execution'],
      ['terminal-release', 'released', null, null],
      ['uncertain-rejection', 'uncertain', 'startup-expired', 'startup-recovery'],
      ['masked', 'failed', null, null],
      ['included-floor', 'failed', 'cancelled-before-provider-create', 'before-provider-create'],
    ])
    expect(query.mock.calls[0]?.[1]).toEqual(['account-a', 'session-a', '2026-11-18T07:00:00.000Z',
      '2026-11-18T08:00:00.000Z', '51', 'cancelled-before-provider-create', 'startup-expired',
      'provider-create-refused-before-create', 'provider-rejected-before-execution-resource'])
    const driverResult = await query.mock.results[0]?.value
    expect(driverResult?.rows).toHaveLength(6)
    expect(JSON.stringify(driverResult)).not.toContain('private-backend-token')

    const many = await queryAllocationDiagnostics({ ...input, sessionId: 'session-many' }, requestId, {
      authorize: async () => ({ ...authorized, sessionId: 'session-many' }), read,
    })
    expect(many).toMatchObject({ more: true })
    expect(many.entries).toHaveLength(50)
    expect(many.entries.at(-1)?.allocationId).toBe('series-050')

    query.mockClear()
    await expect(queryAllocationDiagnostics({ ...input, sessionId: 'unknown-session' }, requestId, { authorize, read }))
      .rejects.toMatchObject({ code: 'cloud/forbidden' })
    await expect(queryAllocationDiagnostics(input, requestId,
      { authorize: async () => ({ ...authorized, role: 'user' }), read })).rejects.toMatchObject({ code: 'cloud/forbidden' })
    expect(query).not.toHaveBeenCalled()

    const revoked = vi.fn<() => Promise<typeof authorized | null>>().mockResolvedValueOnce(authorized).mockResolvedValueOnce(null)
    await expect(queryAllocationDiagnostics(input, requestId, { authorize: revoked, read }))
      .rejects.toMatchObject({ code: 'cloud/unauthenticated' })
    expect(query).toHaveBeenCalledOnce()

    await expect(queryAllocationDiagnostics({ ...input, sessionId: 'verified-empty' }, requestId, {
      authorize: async () => ({ ...authorized, sessionId: 'verified-empty' }), read,
    })).resolves.toEqual({ entries: [], more: false })
  } finally { await executor.close() }
})

it('rejects over-limit, cross-scope, out-of-range, and unmasked driver rows', async () => {
  const row = { accountId: 'account-a', sessionId: 'session-a', allocationId: 'bad-row',
    lastCheckedAt: '2026-11-18T07:00:00.000Z', state: 'failed', failureCode: 'startup-expired' }
  const query = vi.fn<RootMetadataDatabase['query']>()
  const read = allocationHistoryReader({ query, wasNotSubmitted: () => false }, 1)
  await expect(read({ ...input, limit: 52 })).rejects.toThrow('Invalid allocation history scope')
  expect(query).not.toHaveBeenCalled()
  for (const invalid of [
    [row, row],
    [{ ...row, accountId: 'other-account' }],
    [{ ...row, sessionId: 'other-session' }],
    [{ ...row, lastCheckedAt: '2026-11-18T08:00:00.000Z' }],
    [{ ...row, failureCode: 'private-backend-token' }],
  ]) {
    query.mockResolvedValueOnce({ rows: invalid })
    await expect(read({ ...input, limit: 1 })).rejects.toThrow('Invalid allocation history row')
  }
})

it('keeps its finite statement slot until actual completion and reopens it after driver refusal', async () => {
  const actual = Promise.withResolvers<{ rows: never[] }>()
  const query = vi.fn<RootMetadataDatabase['query']>().mockReturnValueOnce(actual.promise).mockResolvedValue({ rows: [] })
  const read = allocationHistoryReader({ query, wasNotSubmitted: () => false }, 1)
  const first = read(input)
  await expect(read(input)).rejects.toThrow('Allocation history concurrency is full')
  expect(query).toHaveBeenCalledOnce()
  actual.reject(new Error('synthetic statement interruption'))
  await expect(first).rejects.toThrow('synthetic statement interruption')
  await expect(read(input)).resolves.toEqual([])
})
