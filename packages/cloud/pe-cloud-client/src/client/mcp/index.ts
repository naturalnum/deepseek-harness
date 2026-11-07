/** Optional account MCP contribution to the original native Settings shell. */
import type { Context } from '@deepseek-ai/cordis'
import type { CloudMcpConnectionRequest, CloudMcpConnectionReply } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PreparedCloudPage } from '../prepared-page.ts'
import { observeCloudDisposal } from '../observe-disposal.ts'
import { McpConnectionsSection, type McpConnectionsInjected } from './McpConnectionsSection.tsx'
import { MCP_SETTINGS_NAMESPACE, mcpSettingsDictionaries } from './locales.ts'

/** Attach only the explicitly approved account-local MCP capability.
 * @param ctx Original Cloud browser plugin context.
 * @param page Original prepared page, identity and transport lifetime.
 */
export function installCloudMcpConnections(ctx: Context, page: PreparedCloudPage): void {
  const signal = page.lifetime.transport.signal
  const aborted = (): boolean => signal.aborted
  if (page.bootstrap.capabilities.configuration.mcp?.manage !== true || aborted()) return
  const dependency = ctx.inject(['connection', 'remote', 'remote.cloudMcpConnections', 'slots', 'locale'], (owner) => {
    const current = (): void => { signal.throwIfAborted(); page.assertAccountManagementCurrent(owner) }
    current()
    const call = async (request: CloudMcpConnectionRequest): Promise<CloudMcpConnectionReply> => {
      current()
      const result = await owner.remote.cloudMcpConnections.action(request, signal)
      current()
      if (!result.ok) throw new Error('cloud/mcp-operation-unconfirmed')
      return result.value
    }
    owner.effect(() => owner.locale.register(MCP_SETTINGS_NAMESPACE, mcpSettingsDictionaries), 'pe-cloud-client: MCP settings copy')
    const t = owner.locale.bind(MCP_SETTINGS_NAMESPACE)
    owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section', id: 'cloud-mcp-connections', order: 41,
      locale: MCP_SETTINGS_NAMESPACE, label: () => t('title'), inject: (): McpConnectionsInjected => ({
        scope: page.bootstrap.connectionGeneration + ':' + String(owner.fiber.uid), call,
      }) }, McpConnectionsSection))
  })
  const stop = (): void => { void observeCloudDisposal(dependency.dispose).catch(() => { console.error('MCP settings withdrawal unconfirmed.') }) }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => { signal.removeEventListener('abort', stop); await dependency.dispose() }, 'pe-cloud-client: retire MCP settings')
  if (aborted()) stop()
}
