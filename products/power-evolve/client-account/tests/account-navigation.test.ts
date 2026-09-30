import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountDestination } from '../src/client/navigation.ts'

test('trusted navigation carries only its account page selection', () => {
  assert.equal(accountDestination('https://platform.test/account', 'password'), 'https://platform.test/account#password')
  assert.equal(accountDestination('https://platform.test/account/#password', 'admin'), 'https://platform.test/account/#admin')
})

test('trusted navigation refuses credentials, foreign page paths and query data', () => {
  for (const entry of ['javascript:alert(1)', 'https://user:password@platform.test/account',
    'https://platform.test/admin', 'https://platform.test/account?token=credential']) {
    assert.throws(() => accountDestination(entry, 'admin'))
  }
})
