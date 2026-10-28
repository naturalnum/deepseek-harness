/** Private wire normalization; these checks do not execute or attest a native workload. */
import { expect, it } from 'vitest'
import { filePolicy } from '../src/agent-data/file-policy.ts'

it.each(['read-only', 'workspace-write'])('normalizes the supported file mode %s', (mode) => {
  const source = { mode }, result = filePolicy(source)
  expect(result).toEqual(source)
  expect(result).not.toBe(source)
  expect(Object.isFrozen(result)).toBe(true)
})

it.each([undefined, null, [], {}, { mode: 'danger-full-access' }, { mode: 'readonly' },
  { mode: true }, { mode: 'workspace-write', workspaceRoot: '/other' }])('refuses an invalid file policy %#', (value) => {
  expect(() => filePolicy(value)).toThrow(expect.objectContaining({ code: 'invalid_file_policy' }))
})
