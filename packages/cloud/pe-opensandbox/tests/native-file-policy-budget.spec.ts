/** Complete original guardian frame budget, before native reservation; no process, mount or allocation. */
import { expect, it } from 'vitest'
import { guardianEncodedBudget, guardianWorkingCopiesBudget } from '../src/agent-data/encoded-budget.ts'
import type { OperationSpec } from '../src/agent-data/types.ts'

const project = '/srv/project'
const mode = { mode: 'workspace-write' as const }
const base: OperationSpec = { argv: ['/bin/echo', ''], cwd: project, stdin: { mode: 'ignore' } }
const extra = Buffer.byteLength(',"filePolicy":' + JSON.stringify(mode), 'ascii')

it('adds the complete signed mode to both the ordinary and maximum-skill-copy guardian frame', () => {
  expect(guardianEncodedBudget(project, base, undefined, mode)).toBe(guardianEncodedBudget(project, base) + extra)
  expect(guardianWorkingCopiesBudget(project, base, 2, mode)).toBe(guardianWorkingCopiesBudget(project, base, 2) + extra)
  expect(guardianEncodedBudget(project, base, undefined, { mode: 'read-only' })).toBeLessThan(guardianEncodedBudget(project, base, undefined, mode))
})

it.each([false, true])('refuses the first byte above the unchanged 4KiB limit with policy selected (skillCopies=%s)', (copies) => {
  const bytes = (spec: OperationSpec) => copies ? guardianWorkingCopiesBudget(project, spec, 2, mode)
    : guardianEncodedBudget(project, spec, undefined, mode)
  const padding = 'a'.repeat(4096 - bytes(base))
  const exact: OperationSpec = { ...base, argv: ['/bin/echo', padding] }
  expect(bytes(exact)).toBe(4096)
  expect(() => bytes({ ...exact, argv: ['/bin/echo', padding + 'a'] })).toThrow(expect.objectContaining({ code: 'guardian_config_budget' }))
})
