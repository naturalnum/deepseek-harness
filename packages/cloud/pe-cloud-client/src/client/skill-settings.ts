/** Original Cloud skill namespace dependency retains the page-owned skill adapters. */
import { observeCloudDisposal } from './observe-disposal.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ClientFailure } from './errors.ts'
import type { PreparedCloudPage } from './prepared-page.ts'
import { managedSkillCallbacks } from './managed-skill-remote.ts'
import { prepareCloudSkillEdit } from './skill-edit.ts'
import { SKILLS_MANAGEMENT_NAMESPACE } from './management/skills/locales.ts'

/**
 * Bind skill adapters after the original generated namespace is available, without a second UI entry.
 * @param ctx Existing Cloud Loader owner; Projects retains the sole generated contribution mount.
 * @param page Original PreparedCloudPage; transport and dependency withdrawal revoke its skill sources.
 */
export function installCloudSkillSettings(ctx: Context, page: PreparedCloudPage): void {
  const config = page.skillSettings, signal = page.lifetime.transport.signal
  const aborted = (): boolean => signal.aborted
  if (config === undefined || !page.bootstrap.capabilities.configuration.skills.manage || aborted()) return
  const dependency = ctx.inject(['remote', 'remote.cloudSkills', 'locale'], (owner) => {
    signal.throwIfAborted()
    if (owner.get('peCloudPage') !== page) throw new ClientFailure('closed')
    const remote = owner.remote.cloudSkills
    const input = { signal, timeoutMs: config.requestTimeoutMs, assertCurrent: () => { page.assertSkillSettingsCurrent(owner) } }
    owner.effect(() => page.attachManagedSkills(owner, managedSkillCallbacks(remote, input), {
      prepare: observer => prepareCloudSkillEdit(remote, input, observer),
      title: () => owner.locale.bind(SKILLS_MANAGEMENT_NAMESPACE)('sampleTitle'),
    }), 'pe-cloud-client: managed and legacy skill source')
  })
  const stop = (): void => {
    void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud skill adapter withdrawal unconfirmed.') })
  }
  signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => {
    signal.removeEventListener('abort', stop)
    await dependency.dispose()
  }, 'pe-cloud-client: withdraw original skill adapter')
  if (aborted()) stop()
}
