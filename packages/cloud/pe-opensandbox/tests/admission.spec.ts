import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as root from '../src/root.ts'
import * as account from '../src/account.ts'
import { assessExecution } from '../src/capabilities.ts'
import { ExecutionUnavailableError } from '../src/errors.ts'

describe('unverified execution admission', () => {
  it('does not treat deployment declarations as verified capabilities', () => {
    const report = assessExecution({ requiredCapabilities: ['argv-collect', 'pipes', 'argv-collect'] })
    expect(report.availableCapabilities).toEqual([])
    expect(report.missingCapabilities).toEqual(['argv-collect', 'pipes'])
    expect(report.missingPrerequisites).toContain('managed-range-stop-proof')
    expect(report.missingPrerequisites).toContain('allocation-store-and-reconciliation')
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.missingCapabilities)).toBe(true)
  })

  it.each([root, account])('refuses an empty mode list before publishing services: $name', async (entry) => {
    const ctx = new Context()
    try {
      expect('default' in entry).toBe(false)
      await expect(ctx.plugin(entry, { requiredCapabilities: [] })).rejects.toBeInstanceOf(ExecutionUnavailableError)
      expect(ctx.get('peSandboxCoordinator')).toBeUndefined()
      expect(ctx.get('shell')).toBeUndefined()
      expect(ctx.get('subprocess')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects undeclared mode names at configuration parsing', () => {
    expect(() => { Reflect.apply(root.Config, undefined, [{ requiredCapabilities: ['host-shell'] }]) }).toThrow()
    expect(() => account.Config({})).toThrow()
  })
})
