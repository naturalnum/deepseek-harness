import type { Branded } from '@deepseek-ai/dsh-brand'
import { describe, expect, it, vi } from 'vitest'
import { queryAllocationDiagnostics, type AllocationDiagnosticRow } from '../src/allocation-diagnostics.ts'

const requestId = 's13-offline' as Branded<'pe-request-id'>
const fromMs = Date.parse('2026-11-18T07:00:00.000Z')
const toMs = Date.parse('2026-11-18T08:00:00.000Z')
const input = { accountId: 'account-a', sessionId: 'session-a', fromMs, toMs, limit: 2 }
const actor = { role: 'admin' as const, actorId: 'admin-a', authSessionId: 'login-a', accountId: input.accountId, sessionId: input.sessionId }
const row: AllocationDiagnosticRow = {
  accountId: input.accountId, sessionId: input.sessionId, allocationId: 'allocation-a',
  lastCheckedAt: '2026-11-18T07:30:00.000Z', state: 'failed', failureCode: 'provider-create-refused-before-create',
}

describe('allocation diagnostics', () => {
  it('reads one explicit account and conversation and preserves the original reason', async () => {
    const read = vi.fn(async () => [{ ...row, providerMessage: 'synthetic-private-text',
      backendPath: '/synthetic/private', sandboxId: 'synthetic-private-id' }])
    const authorize = vi.fn(async () => actor)
    await expect(queryAllocationDiagnostics(input, requestId, { authorize, read })).resolves.toEqual({
      entries: [{ accountId: input.accountId, sessionId: input.sessionId, allocationId: 'allocation-a',
        observedAt: row.lastCheckedAt, state: 'failed', reasonCode: row.failureCode, stage: 'provider-create' }],
      more: false,
    })
    expect(read).toHaveBeenCalledExactlyOnceWith({ ...input, limit: 3 })
    expect(authorize).toHaveBeenNthCalledWith(1, { accountId: input.accountId, sessionId: input.sessionId })
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it.each([
    [null, 'cloud/unauthenticated'],
    [{ ...actor, role: 'user' as const }, 'cloud/forbidden'],
    [{ ...actor, accountId: 'account-b' }, 'cloud/forbidden'],
    [{ ...actor, sessionId: 'session-b' }, 'cloud/forbidden'],
  ] as const)('requires trusted administrator authorization for the exact scope', async (authorization, code) => {
    const read = vi.fn(async () => [row])
    await expect(queryAllocationDiagnostics(input, requestId, { read, authorize: async () => authorization }))
      .rejects.toMatchObject({ code })
    expect(read).not.toHaveBeenCalled()
  })

  it('withholds results if authorization changes during the read', async () => {
    const authorize = vi.fn<() => Promise<typeof actor | null>>().mockResolvedValueOnce(actor).mockResolvedValueOnce(null)
    await expect(queryAllocationDiagnostics(input, requestId, { read: async () => [row], authorize }))
      .rejects.toMatchObject({ code: 'cloud/unauthenticated' })
  })

  it('withholds results if another login becomes current during the read', async () => {
    const authorize = vi.fn<() => Promise<typeof actor>>().mockResolvedValueOnce(actor)
      .mockResolvedValueOnce({ ...actor, authSessionId: 'login-b' })
    await expect(queryAllocationDiagnostics(input, requestId, { read: async () => [row], authorize }))
      .rejects.toMatchObject({ code: 'cloud/unauthenticated' })
  })

  it.each([
    { ...row, accountId: 'account-b' },
    { ...row, sessionId: 'session-b' },
  ])('rejects an out-of-scope row without returning partial results', async (rogue) => {
    await expect(queryAllocationDiagnostics(input, requestId, { read: async () => [row, rogue], authorize: async () => actor }))
      .rejects.toMatchObject({ code: 'cloud/forbidden' })
  })

  it.each([
    { ...input, role: 'admin' },
    { ...input, accountId: '*' },
    { ...input, sessionId: '' },
    { ...input, fromMs: toMs },
    { ...input, toMs: fromMs + 86_400_001 },
    { ...input, fromMs: NaN },
    { ...input, limit: 51 },
  ])('rejects invalid or unbounded input before reading', async (selection) => {
    const authorize = vi.fn(async () => actor)
    const read = vi.fn(async () => [row])
    await expect(queryAllocationDiagnostics(selection, requestId, { read, authorize })).rejects.toMatchObject({ code: 'cloud/forbidden' })
    expect(authorize).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('distinguishes a confirmed empty result from an unavailable source', async () => {
    const authorize = async () => actor
    await expect(queryAllocationDiagnostics(input, requestId, { read: async () => [], authorize }))
      .resolves.toEqual({ entries: [], more: false })
    await expect(queryAllocationDiagnostics(input, requestId, {
      read: async () => { throw new Error('synthetic-provider-message') }, authorize,
    })).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })

  it('bounds output and reports further rows without exposing an unknown reason', async () => {
    const second = { ...row, allocationId: 'allocation-b', failureCode: 'synthetic-private-token' }
    const third = { ...row, allocationId: 'allocation-c', lastCheckedAt: '2026-11-18T07:00:00.000Z' }
    const result = await queryAllocationDiagnostics(input, requestId, {
      read: async () => [row, second, third], authorize: async () => actor,
    })
    expect(result.more).toBe(true)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]).toMatchObject({ allocationId: 'allocation-b', reasonCode: null, stage: null })
    expect(JSON.stringify(result)).not.toContain('synthetic-private-token')
  })

  it.each([
    [{ ...row, lastCheckedAt: '2026-11-18T08:00:00.000Z' }],
    [row, { ...row }],
    [row, { ...row, allocationId: 'allocation-b', lastCheckedAt: '2026-11-18T07:45:00.000Z' }],
    [row, row, row, row],
  ].map(rows => ({ rows })))('rejects invalid or oversized source results', async ({ rows }) => {
    await expect(queryAllocationDiagnostics(input, requestId, { read: async () => rows, authorize: async () => actor }))
      .rejects.toMatchObject({ code: 'cloud/account-unavailable' })
  })
})
