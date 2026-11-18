/** Root reference parsing does not open a file, start an application, or grant recovery authority. */
import { expect, it } from 'vitest'
import { parseRootRecoveryReference } from '../src/bootstrap/recovery-reference.ts'

const input = () => ({ publication: { path: '/root-controlled/recovery.json', sha256: 'a'.repeat(64) }, maxBytes: 16384, maxAgeMs: 60000 })

it('requires an exact protected publication selection and explicit finite maintenance budgets', () => {
  const value = input(), parsed = parseRootRecoveryReference(value)
  expect(parsed).toEqual(value)
  expect(Object.isFrozen(parsed.publication)).toBe(true)
  value.publication.path = '/different-publication'
  expect(parsed.publication.path).toBe('/root-controlled/recovery.json')
  for (const invalid of [undefined, { ...input(), verifier: true }, { ...input(), maxBytes: 131073 },
    { ...input(), maxAgeMs: 0 }, { ...input(), publication: { path: '/root-controlled/recovery.json', sha256: 'not-a-hash' } }]) {
    expect(() => parseRootRecoveryReference(invalid)).toThrow(/explicit protected reference/)
  }
})

it('admits one exact maintenance target and a bounded operator reference', () => {
  const target = { accountId: 'target-account', oldInstanceId: 'old-instance', epoch: '9223372036854775807', operatorRef: 'admin:42' }
  const parsed = parseRootRecoveryReference({ ...input(), target })
  expect(parsed.target).toEqual(target)
  expect(Object.isFrozen(parsed.target)).toBe(true)
  for (const invalid of [null, [], { ...target, accountIds: [target.accountId] }, { ...target, epoch: 21 },
    { ...target, epoch: '9223372036854775808' }, { ...target, operatorRef: '' }, { ...target, operatorRef: 'untrusted operator' }]) {
    expect(() => parseRootRecoveryReference({ ...input(), target: invalid })).toThrow(/explicit protected reference/)
  }
})
