/** Actual native tool pipeline; only its unrelated directory collaborator is substituted. */
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { installAccountExecutionPort } from '../src/closed-owner.ts'
import * as account from '../src/account.ts'
import { assertClosedAccountExecution, withAccountApplicationService, accountServiceAvailability } from '../src/index.ts'
import type { DevelopmentServiceId } from '../src/types.ts'
import { ClosedShellExecutor } from '../src/closed-providers.ts'
import { closedRoot, closedAccount, installedAccount } from './closed-fixture.ts'

it('refuses application borrowing through the original closed port and preserves original caller cancellation', async () => {
  const root = await closedRoot(), input = await closedAccount(root.owner, 'closed-preview')
  const selection = { sessionId: SessionId('no-session-created'), serviceId: brandString<DevelopmentServiceId>('no-service-created') }
  const consume = vi.fn(async () => {}), caller = new AbortController(), cause = new Error('original request cancelled')
  await expect(withAccountApplicationService(input.ctx, selection, caller.signal, Date.now() + 1000, consume))
    .rejects.toMatchObject({ message: 'Cloud execution is disabled by this deployment.' })
  caller.abort(cause)
  await expect(withAccountApplicationService(input.ctx, selection, caller.signal, Date.now() + 1000, consume)).rejects.toBe(cause)
  const foreign = installedAccount('uninstalled-preview')
  await expect(withAccountApplicationService(foreign.ctx, selection, new AbortController().signal, Date.now() + 1000, consume))
    .rejects.toMatchObject({ code: 'cloud/stale-generation' })
  expect(consume).not.toHaveBeenCalled()
})

it('routes a real native bash tool call to the closed provider and never executes its marker command', async () => {
  const root = await closedRoot(), input = installedAccount('native-consumer')
  const directory = await mkdtemp(join(tmpdir(), 'pe-execution-closed-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const ctx = await boot('closed-execution-consumer',
    fileURLToPath(new URL('./fixtures/closed-consumer.cordis.yml', import.meta.url)), [], (setup) => {
      const binding = installAccountBinding(setup, input.binding)
      const port = root.owner.bindAccount(setup, binding, input.current)
      installAccountExecutionPort(setup, port)
      provideWorkingDirectoryFixture(setup, directory)
      setup.loader.builtins['closed-execution-account'] = account
      setup.loader.builtins['closed-system-prompt'] = SystemPrompt
      setup.loader.builtins['closed-tools'] = ToolRuntime
      setup.loader.builtins['closed-shell-env'] = ShellEnv
      setup.loader.builtins['closed-bash-consumer'] = ToolBash
    })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  expect([...ctx.loader.entries()].filter(entry => entry.options.id !== 'include')).toHaveLength(5)
  const resolve = vi.spyOn(ClosedShellExecutor.prototype, 'resolve')
  onTestFinished(() => { resolve.mockRestore() })
  expect(() => { assertClosedAccountExecution(ctx) }).not.toThrow()
  expect(accountServiceAvailability(ctx)).toEqual({ developmentServices: false, servicePreview: false })
  const marker = join(directory, 'must-not-exist')
  const result = await ctx.tools.execute({
    callId: ToolCallId('closed-bash'), name: 'bash', signal: new AbortController().signal,
    arguments: { command: 'printf forbidden > must-not-exist', description: 'Closed execution refusal', workdir: directory },
  })
  expect(resolve).toHaveBeenCalledOnce()
  expect(result.isError).toBe(true)
  const message = result.content.filter(item => item.type === 'text').map(item => item.text).join('')
  expect(message).toContain('Cloud execution is disabled by this deployment.')
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(ctx.peAccount).not.toBe(input.binding)
  expect(await root.owner.stopEpoch(ctx.peAccount, Date.now())).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
})
