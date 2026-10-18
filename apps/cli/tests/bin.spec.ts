/** Parsed launcher shutdown budgets reach the selected profile runner without booting an application. */
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli } from '../src/bin.ts'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('../src/profile-boot.ts', () => ({ runProfile: vi.fn() }))
vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  loadLayeredEnv: vi.fn(),
}))

const originalArgv = process.argv
afterEach(() => {
  process.argv = originalArgv
  vi.resetAllMocks()
})

it.each([['cloud'], ['--profile', 'cloud']])('passes a parsed shutdown budget from %j to runProfile', async (...prefix: string[]) => {
  const environment = createLaunchEnvironmentSnapshot([])
  vi.mocked(loadLayeredEnv).mockReturnValue(environment)
  process.argv = ['node', 'dsh', ...prefix, '--shutdown-timeout-ms', '120000', '--no-open']
  await runCli()
  expect(runProfile).toHaveBeenCalledOnce()
  expect(runProfile).toHaveBeenCalledWith(expect.objectContaining({
    environment, profile: 'cloud', shutdownTimeoutMs: 120000, args: ['--no-open'],
  }))
})

it('leaves the default budget to runProfile when the option belongs to app arguments', async () => {
  vi.mocked(loadLayeredEnv).mockReturnValue(createLaunchEnvironmentSnapshot([]))
  process.argv = ['node', 'dsh', 'cloud', '--app-option', '--shutdown-timeout-ms', '120000']
  await runCli()
  expect(runProfile).toHaveBeenCalledWith(expect.objectContaining({ args: ['--app-option', '--shutdown-timeout-ms', '120000'] }))
  expect(vi.mocked(runProfile).mock.calls[0]?.[0].shutdownTimeoutMs).toBeUndefined()
})
