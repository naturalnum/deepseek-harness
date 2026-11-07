/** Cross-owner timeout validation prevents PG from silently releasing the administrator lock during actual preparation. */
import { expect, it } from 'vitest'
import { accountAdministrationTransactionBudget } from '../src/static-account-bindings.ts'

it('requires the actual native and bounded inventory work plus the authentication tail before opening management', () => {
  const queryBounds = { queueTimeoutMs: 100, statementTimeoutMs: 200 }
  const budgets = { idleTransactionTimeoutMs: 20_000, authOperationTimeoutMs: 10_000,
    authStatementTimeoutMs: 200, authConnectionTimeoutMs: 100 }
  const required = accountAdministrationTransactionBudget(2000, queryBounds, 2, budgets)
  expect(required).toBe(16800)
  expect(() => accountAdministrationTransactionBudget(2000, queryBounds, 2,
    { ...budgets, idleTransactionTimeoutMs: required - 1 })).toThrow('transaction timeout')
  expect(accountAdministrationTransactionBudget(2000, queryBounds, 2,
    { ...budgets, idleTransactionTimeoutMs: required })).toBe(required)
  expect(accountAdministrationTransactionBudget(2000, queryBounds, 0, budgets)).toBe(12600)
  expect(() => accountAdministrationTransactionBudget(2000, queryBounds, 2,
    { ...budgets, authOperationTimeoutMs: 6799 })).toThrow('operation timeout')
  expect(accountAdministrationTransactionBudget(2000, queryBounds, 2,
    { ...budgets, authOperationTimeoutMs: 6800 })).toBe(13600)
})
