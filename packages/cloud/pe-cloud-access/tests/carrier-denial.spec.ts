/** Unissued-handle denial only; no principal, Peer readiness or login freshness is fabricated. */
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { BetterAuthAccess } from '../src/auth.ts'
import { LoginPeerRegistry, type LoginPeer } from '../src/peers.ts'
import { accessConfig, carrier } from './ingress-fixture.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'

it('rejects an unissued carrier before invoking auth/body/cancellation or taking ownership of its actual promise', async () => {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1, user: 'carrier-denial', password: 'dummy', database: 'not-opened',
    max: 1, connectionTimeoutMillis: 50 })
  const connect = vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('DB/network access is forbidden in this check') })
  const query = vi.spyOn(pool, 'query').mockImplementation(() => { throw new Error('DB/network access is forbidden in this check') })
  const actual = Promise.withResolvers<undefined>(), input = carrier('/cloud/service-preview')
  const auth = await BetterAuthAccess.create(accessConfig(), pool, 'dummy-carrier-secret-with-at-least-thirty-two-characters', async () => {})
  const borrow = vi.fn(async (): Promise<never> => { throw new Error('No account borrow is admitted') })
  const registry = new LoginPeerRegistry(accessConfig(), auth, {
    borrow, beforeHttp: () => {}, beforeStream: () => {}, cleanupFailed: () => {},
  })
  const authenticate = vi.fn(async (): Promise<never> => { throw new Error('Unissued handle cannot authenticate') })
  const consume = vi.fn(async () => undefined), destroy = vi.fn()
  const requestId = 'carrier-denial' as Branded<'pe-request-id'>, unissued = Object.freeze({}) as LoginPeer
  try {
    expect(() => registry.runCarrier(unissued, input.request, requestId,
      { authenticate, consume, destroy, actual: actual.promise })).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    expect(() => registry.handleNodeRequest(unissued, input.request, input.response, 128, requestId))
      .toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
    expect(authenticate).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled()
    expect(borrow).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled()
    expect(registry.reservedCarriers).toBe(0); expect(registry.reservedPeers).toBe(0)
    await registry.closeActual() // Must not wait for a promise belonging to a refused carrier.
    expect(pool.totalCount).toBe(0)
  } finally {
    actual.resolve(undefined); input.request.destroy(); input.response.destroy(); input.socket.destroy()
    await registry.closeActual(); await auth.close(); await pool.end(); connect.mockRestore(); query.mockRestore()
  }
})
