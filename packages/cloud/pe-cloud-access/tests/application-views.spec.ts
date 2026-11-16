/** Preview credential lifecycle with an explicit authentication double; no database, HTTP or browser acceptance. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ServicePreviewIdentity, DevelopmentServiceId } from '@deepseek-ai/dsh-pe-opensandbox/types'
import type { AuthenticatedPrincipal } from '../src/types.ts'
import type { AuthAccessError } from '../src/auth-error.ts'
import type { BetterAuthAccess } from '../src/auth.ts'
import { ServiceApplicationViews, type ApplicationViewSelection } from '../src/application-views.ts'

const requestId = brandString<AuthAccessError['requestId']>('application-view-test')
const principal: AuthenticatedPrincipal = { accountId: brandString<AuthenticatedPrincipal['accountId']>('account-A'),
  authSessionId: brandString<AuthenticatedPrincipal['authSessionId']>('login-A') }
const selection: ServicePreviewIdentity = { accountId: principal.accountId,
  epoch: brandString<ServicePreviewIdentity['epoch']>('epoch-A'),
  allocationId: brandString<ServicePreviewIdentity['allocationId']>('allocation-A'), sessionId: SessionId('session-A'),
  serviceId: brandString<DevelopmentServiceId>('service-A') }

function fixture(maxViews = 2) {
  let borrows = 0
  const auth = {
    assertLoginCurrent: vi.fn<BetterAuthAccess['assertLoginCurrent']>(),
    recheckLogin: vi.fn<BetterAuthAccess['recheckLogin']>(async () => {}),
    retainedPrincipalBytes: vi.fn<BetterAuthAccess['retainedPrincipalBytes']>(() => 32),
    retainPrincipal: vi.fn<BetterAuthAccess['retainPrincipal']>(() => { borrows++ }),
    releasePrincipal: vi.fn<BetterAuthAccess['releasePrincipal']>(() => {
      if (borrows === 0) throw new Error('Unexpected principal release')
      borrows--
    }),
  }
  const views = new ServiceApplicationViews(auth, { maxViews, maxViewsPerAccount: maxViews,
    maxRetainedBytes: 65536, maxFieldBytes: 128, lifetimeMs: 10000 })
  onTestFinished(() => views.closeActual())
  const lifetime = new AbortController()
  const issue = () => views.issue(principal, selection, 'generation-A', lifetime.signal, requestId)
  const authorize = async (grant: ReturnType<typeof issue>): Promise<string> => {
    let cookie = ''
    await views.authorize(grant.id, grant.proof, requestId, async (value, _seconds, use) => {
      use.assertCurrent(); cookie = value
    })
    return cookie
  }
  return { auth, views, issue, authorize, lifetime, borrows: () => borrows }
}

it('consumes a private launch proof once and binds its separate cookie to the original view and selectors', async () => {
  const f = fixture(), a = f.issue(), b = f.issue()
  expect(() => f.issue()).toThrow()
  expect(f.borrows()).toBe(2)
  const cookie = await f.authorize(a)
  await expect(f.views.authorize(a.id, a.proof, requestId, async () => {})).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
  const consume = vi.fn(async (actual: AuthenticatedPrincipal, selected: ApplicationViewSelection) => {
    expect(actual).toBe(principal)
    expect(selected).toEqual({ accountId: principal.accountId, connectionGeneration: 'generation-A', service: selection })
  })
  await f.views.withCredential(a.id, cookie, requestId, consume)
  await expect(f.views.withCredential(b.id, cookie, requestId, consume)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
  await expect(f.views.withCredential(a.id, a.proof, requestId, consume)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
  expect(consume).toHaveBeenCalledTimes(1)
  await f.views.close(a.id)
  expect(f.borrows()).toBe(1)
  expect(Object.keys(f.views.observe()).sort()).toEqual(['retainedBytes', 'views'])
})

it('revokes immediately but retains the principal and capacity until the original application use actually settles', async () => {
  const f = fixture(), grant = f.issue(), cookie = await f.authorize(grant)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const actual = f.views.withCredential(grant.id, cookie, requestId, async (_principal, _selection, use) => {
    entered.resolve(undefined)
    await release.promise
    expect(use.signal.aborted).toBe(true)
    expect(() => use.assertCurrent()).toThrow()
  })
  await entered.promise
  const closing = f.views.close(grant.id)
  try {
    expect(f.views.close(grant.id)).toBe(closing)
    expect(f.borrows()).toBe(1)
    expect(f.views.observe().views).toBe(1)
    await expect(f.views.withCredential(grant.id, cookie, requestId, async () => {})).rejects.toThrow()
  } finally { release.resolve(undefined); await actual; await closing }
  expect(f.borrows()).toBe(0)
  expect(f.views.observe()).toEqual({ views: 0, retainedBytes: 0 })
})

it('does not wait on its own authentication query when the original login invalidator revokes a view', async () => {
  const f = fixture(), grant = f.issue(), cookie = await f.authorize(grant)
  f.auth.recheckLogin.mockImplementation(async () => { f.views.invalidateLogin(principal.authSessionId) })
  const consume = vi.fn(async () => {})
  await expect(f.views.withCredential(grant.id, cookie, requestId, consume)).rejects.toMatchObject({ code: 'cloud/unauthenticated' })
  await f.views.closeActual()
  expect(consume).not.toHaveBeenCalled()
  expect(f.borrows()).toBe(0)
})

it('joins late authentication completion before dropping the original retained principal', async () => {
  const f = fixture(), grant = f.issue(), cookie = await f.authorize(grant)
  const query = Promise.withResolvers<undefined>()
  f.auth.recheckLogin.mockImplementation(async (_principal, _request, retain) => {
    retain?.(query.promise)
    throw new Error('Authentication observer ended before its actual query')
  })
  await expect(f.views.withCredential(grant.id, cookie, requestId, async () => {})).rejects.toThrow()
  const closing = f.views.close(grant.id)
  try { expect(f.borrows()).toBe(1) }
  finally { query.resolve(undefined); await closing }
  expect(f.borrows()).toBe(0)
})
