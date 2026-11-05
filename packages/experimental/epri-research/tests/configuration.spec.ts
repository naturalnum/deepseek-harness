/** Recipe adaptation preserves the platform's single Preset and finite deployment policy. */
import { expect, it } from 'vitest'
import { prepareResearchConfiguration } from '../scripts/prepare.ts'
import { accountPresetConfigDigest } from '@deepseek-ai/dsh-pe-cloud-runtime/src/account-policy.ts'

function input() {
  return { installationDirectory: '/opt/harness', recipeVersion: 'with-research',
    service: { python: '/opt/epri-python/bin/python3', maxJsonBytes: 4_194_304, maxOutputBytes: 8_388_608, graceMs: 5000 },
    web: { requestTimeoutMs: 180000, maxPendingRequests: 8 },
    root: [
      { id: 'runtime', name: '@deepseek-ai/dsh-pe-cloud-runtime/root', config: { recipeVersion: 'base',
        native: { requiredEntryIds: ['preset'], maxEntries: 100 },
        accountPolicy: { presetId: 'chat', presetEntryId: 'preset', maxPresetConfigBytes: 65536 } } },
      { id: 'api', name: '@deepseek-ai/dsh-pe-cloud-api/root', config: { recipeVersion: 'base', rpcEndpoints: [],
        approvedConfiguration: { recipeVersion: 'base', skills: { mode: 'managed' }, plugins: [], maxEntries: 100 } } },
    ],
    account: [{ id: 'preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'chat', plugins: [] } }],
  }
}

it('adds only research owners and exact RPC while repinning the existing Preset', () => {
  const source = input(), result = prepareResearchConfiguration(source)
  expect(source.account[0]?.config.plugins).toEqual([])
  expect(result.recipeVersion).toBe('with-research')
  expect(result.dependencies).toEqual({
    '@deepseek-ai/dsh-experimental-epri-research': 'file:///opt/harness/packages/experimental/epri-research',
    'deepscientist-harness-suite': 'file:///opt/harness/integrations/epri-research',
  })
  expect(result.presetConfigSha256).toBe(accountPresetConfigDigest({ id: 'chat', plugins: [
    { id: 'epri-research-tools', name: '@deepseek-ai/dsh-experimental-epri-research/tools' },
    { id: 'epri-research-skills', name: '@deepseek-ai/dsh-experimental-epri-research/skills' },
  ] }, 65536))
  expect(result.root).toMatchObject([
    { config: { recipeVersion: 'with-research', native: { maxEntries: 100 } } },
    { config: { rpcEndpoints: [{ endpoint: 'epriResearch/execute', handlerId: 'native:epriResearch', guard: 'account-session' }] } },
    { name: '@deepseek-ai/dsh-experimental-epri-research/web', config: { assetsRoot: '/opt/harness/integrations/epri-research/dist/ui' } },
  ])
})

it('rejects an unreviewed version, unavailable skill owner and insufficient original capacity', () => {
  expect(() => prepareResearchConfiguration({ ...input(), recipeVersion: 'base' })).toThrow('new recipe version')
  const closed = input()
  closed.root[1]!.config.approvedConfiguration!.skills.mode = 'closed'
  expect(() => prepareResearchConfiguration(closed)).toThrow('managed-skill')
  closed.root[1]!.config.approvedConfiguration!.skills.mode = 'sample'
  expect(() => prepareResearchConfiguration(closed)).toThrow('managed-skill')
  const small = input()
  small.root[0]!.config.native!.maxEntries = 1
  expect(() => prepareResearchConfiguration(small)).toThrow('capacities')
})
