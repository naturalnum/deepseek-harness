import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { installCloudSubagentSettings } from '../src/client/subagent-settings.ts'

it('uses only the current account approved fields and withdraws on abort', async () => {
  const ctx = new Context(), first = new AbortController(), second = new AbortController()
  const page = (signal: AbortSignal, namespace: string, paths: string[]) => ({
    nativeSubagentSettingsNamespace: namespace, lifetime: { transport: { signal } },
    bootstrap: { capabilities: { configuration: { fields: paths.map(path => ({ namespace, path, application: 'live' })) } } },
  })
  const one = ctx.plugin((scope) => { installCloudSubagentSettings(scope, page(first.signal, 'native-subagents',
    ['maxActiveSubagents', 'unrelated']) as never) })
  await one.await()
  expect(ctx.get('subagentSettingsIntegration')).toEqual({ namespace: 'native-subagents', fields: ['maxActiveSubagents'] })
  first.abort()
  await vi.waitFor(() => { expect(ctx.get('subagentSettingsIntegration')).toBeUndefined() })
  const two = ctx.plugin((scope) => { installCloudSubagentSettings(scope, page(second.signal, 'other-account', ['maxDepth']) as never) })
  await two.await()
  expect(ctx.get('subagentSettingsIntegration')).toEqual({ namespace: 'other-account', fields: ['maxDepth'] })
  await one.dispose()
  expect(ctx.get('subagentSettingsIntegration')?.namespace).toBe('other-account')
  await two.dispose()
  expect(ctx.get('subagentSettingsIntegration')).toBeUndefined()
})
