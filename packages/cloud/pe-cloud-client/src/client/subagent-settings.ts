/** Deployment namespace hint joined to the current account's approved native fields. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentSettingsIntegration } from '@deepseek-ai/dsh-client-ui-settings-subagent/client'
import type { PreparedCloudPage } from './prepared-page.ts'
import { observeCloudDisposal } from './observe-disposal.ts'

/** Install a display-only binding; actual reads and writes remain native Settings operations.
 * @param ctx Original page fiber.
 * @param page Prepared account page.
 */
export function installCloudSubagentSettings(ctx: Context, page: PreparedCloudPage): void {
  const namespace = page.nativeSubagentSettingsNamespace
  if (namespace === undefined) return
  const signal = page.lifetime.transport.signal
  if (signal.aborted) return
  const fields = page.bootstrap.capabilities.configuration.fields.filter(field => field.namespace === namespace
    && (field.path === 'maxDepth' || field.path === 'maxActiveSubagents')).map(field => field.path)
  const binding: SubagentSettingsIntegration = Object.freeze({ namespace, fields: Object.freeze(fields) })
  const remove = ctx.reflect.provide('subagentSettingsIntegration', binding)
  let removed = false
  const stop = (): void => {
    if (removed) return
    removed = true
    void observeCloudDisposal(remove).catch(() => { console.error('Subagent settings withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => () => { signal.removeEventListener('abort', stop); stop() }, 'pe-cloud-client: withdraw subagent binding')
}
