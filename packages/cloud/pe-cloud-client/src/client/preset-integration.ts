/** Account-bound read-only adapter for the native agent-preset surfaces. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresetIntegration } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type { PreparedCloudPage } from './prepared-page.ts'
import { ClientFailure } from './errors.ts'

/** Install the original inventory projection for this page's lifetime.
 * @param ctx Original Cloud client scope.
 * @param page Original prepared account page.
 */
export function installCloudPresetIntegration(ctx: Context, page: PreparedCloudPage): void {
  const current = (): void => { page.assertAccountManagementCurrent(ctx) }
  const snapshot = async () => {
    current()
    const result = await ctx.remote.pluginInventory.list()
    current()
    if (!result.ok || result.value.agentPresets === undefined) throw new ClientFailure('closed')
    return result.value.agentPresets
  }
  const source: AgentPresetIntegration = {
    async list() {
      const groups = await snapshot()
      return { presets: groups.map(({ id, name, isDefault, broken }) => ({ id, isDefault,
        ...name === undefined ? {} : { name }, ...broken === undefined ? {} : { broken } })) }
    },
    async read(id) {
      const groups = await snapshot()
      const matches = groups.filter(group => group.id === id)
      if (matches.length !== 1 || matches[0] === undefined) throw new ClientFailure('closed')
      const group = matches[0]
      const lines = ['# 实际插件组成；配置值未提供。', '# Actual plugin composition; configuration values are not included.',
        ...group.rows.map(row => `- ${JSON.stringify(row.moduleName)}  enabled=${String(row.enabled)}  state=${row.fiberPhase ?? 'not-mounted'}`)]
      return { agentPreset: group.id, ...group.name === undefined ? {} : { name: group.name }, content: lines.join('\n') }
    },
  }
  ctx.reflect.provide('agentPresetIntegration', source)
}
