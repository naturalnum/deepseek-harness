/** Cross-owner timeout validation prevents PG from silently releasing the administrator lock during actual preparation. */
import { expect, it } from 'vitest'
import { accountAdministrationTransactionBudget } from '../src/static-account-bindings.ts'

it('requires the actual native and bounded inventory work plus the authentication tail before opening management', () => {
  const queryBounds = { queueTimeoutMs: 100, statementTimeoutMs: 200 }
  const budgets = { idleTransactionTimeoutMs: 10_000, authOperationTimeoutMs: 1000,
    authStatementTimeoutMs: 200, authConnectionTimeoutMs: 100 }
  const required = accountAdministrationTransactionBudget(2000, queryBounds, 2, budgets)
  expect(required).toBe(7800)
  expect(() => accountAdministrationTransactionBudget(2000, queryBounds, 2,
    { ...budgets, idleTransactionTimeoutMs: required - 1 })).toThrow('transaction timeout')
  expect(accountAdministrationTransactionBudget(2000, queryBounds, 2,
    { ...budgets, idleTransactionTimeoutMs: required })).toBe(required)
  expect(accountAdministrationTransactionBudget(2000, queryBounds, 0, budgets)).toBe(3600)
})
