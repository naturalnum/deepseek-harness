import { describe, expect, it } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { accountRole, parseAccountAdministration } from '../src/account-administration.ts'

const requestId = 'account-admin-test' as Branded<'pe-request-id'>
const limits = { maxAccounts: 10, maxPageSize: 4, initialAdministratorIds: [] }

describe('account administration inputs', () => {
  it('resolves only the two platform roles and leaves pre-role accounts ordinary', () => {
    expect(accountRole({})).toBe('user')
    expect(accountRole({ role: 'user' })).toBe('user')
    expect(accountRole({ role: 'admin' })).toBe('admin')
    expect(accountRole({ role: 'admin,user' })).toBe('user')
  })
  it('resolves an omitted list limit from the explicit deployment policy', () => {
    expect(parseAccountAdministration({ op: 'list', search: '', offset: 0 }, limits, requestId)).toEqual({ op: 'list', search: '', offset: 0, limit: 4 })
  })
  it.each([
    { op: 'list', search: '', offset: 0, limit: 5 },
    { op: 'list', search: '', offset: -1, limit: 1 },
    { op: 'list', search: '', offset: 0, actorId: 'admin' },
    { op: 'role', id: 'target', role: 'superuser' },
    { op: 'enabled', id: 'target', enabled: 'true' },
    { op: 'password', id: 'target', password: 'short' },
    { op: 'create', email: 'new@example.test', displayName: 'New', password: 'long-safe-password', role: 'user', banned: false },
    { op: 'impersonate', id: 'target' },
    { op: 'delete', id: 'target' },
  ])('refuses unsupported fields and operations before mutation: %j', (input) => {
    expect(() => parseAccountAdministration(input, limits, requestId)).toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  })
})
