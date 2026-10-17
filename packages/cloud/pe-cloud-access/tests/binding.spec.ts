import { describe, expect, it } from 'vitest'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { assertExpectedAccount, assertExpectedGeneration, parseRequestExpectation, RequestBindingError } from '../src/binding.ts'

const requestId = 'server-request-1' as Branded<'pe-request-id'>
const accountA = 'account-a' as AccountId
const generationA = 'opaque-a-9007199254740993' as Branded<'pe-connection-generation'>
const expected = { accountId: accountA, connectionGeneration: generationA }

describe('request binding admission', () => {
  it('preserves an opaque generation without numeric conversion', () => {
    const parsed = parseRequestExpectation({ accountIds: [accountA], connectionGenerations: [generationA] }, requestId)
    expect(parsed).toEqual(expected)
    expect(() => { assertExpectedAccount(parsed, accountA, requestId) }).not.toThrow()
    expect(() => { assertExpectedGeneration(parsed, generationA, requestId) }).not.toThrow()
  })

  it.each([[], [''], [' '], ['account-a '], [' account-a'], ['account\na'], ['account\u007fa'], ['account-a', 'account-a']])(
    'rejects invalid account occurrences %j', (...accountIds: string[]) => {
      expect(() => parseRequestExpectation({ accountIds, connectionGenerations: [generationA] }, requestId)).toThrow(RequestBindingError)
    },
  )

  it.each([[], [''], [' '], ['old '], ['old', 'new']])('rejects invalid generation occurrences %j', (...connectionGenerations: string[]) => {
    expect(() => parseRequestExpectation({ accountIds: [accountA], connectionGenerations }, requestId)).toThrow(RequestBindingError)
  })

  it('rejects an A page authenticated as B without disclosing either identity', () => {
    try {
      assertExpectedAccount(expected, 'account-b' as AccountId, requestId)
      throw new Error('expected stale binding')
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBindingError)
      if (!(error instanceof RequestBindingError)) throw error
      expect(error.status).toBe(409)
      expect(error.toJSON()).toEqual({
        code: 'cloud/stale-generation',
        message: 'Account connection is no longer current. Bootstrap before sending a new operation.',
        requestId,
        retry: 'after-status-check',
      })
      expect(JSON.stringify(error)).not.toContain('account-a')
      expect(JSON.stringify(error)).not.toContain('account-b')
      expect(JSON.stringify(error)).not.toContain(generationA)
    }
  })

  it('rejects a late request for a previous graph of the same account', () => {
    expect(() => {
      assertExpectedGeneration(expected, 'new-generation' as Branded<'pe-connection-generation'>, requestId)
    }).toThrow(RequestBindingError)
  })
})
