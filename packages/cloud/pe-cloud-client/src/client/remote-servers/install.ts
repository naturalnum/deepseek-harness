/** Server settings and @ source over the original generated namespace and account page lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { RemoteServerReply, RemoteServerRequest, RemoteServerView } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-api/remote'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PreparedCloudPage } from '../prepared-page.ts'
import { observeCloudDisposal } from '../observe-disposal.ts'
import { ServersSection, type RemoteServersInjected } from './ServersSection.tsx'
import { REMOTE_SERVERS_NAMESPACE, remoteServerDictionaries, type RemoteServersKey } from './locales.ts'

/** Build a structured mention source. Every serialized reference is refreshed against the same captured account.
 * @param call Original page-bound management call.
 * @param current Captured page check.
 * @param t Locale lookup.
 * @returns Native input-trigger provider; contributes no model content until explicitly selected.
 */
export function remoteServerMentionSource(call: (request: RemoteServerRequest, signal?: AbortSignal) => Promise<RemoteServerReply>,
  current: () => void, t: (key: RemoteServersKey) => string): InputTriggerSource {
  let rows: readonly RemoteServerView[] = []
  const refresh = async (signal?: AbortSignal): Promise<readonly RemoteServerView[]> => {
    current(); signal?.throwIfAborted()
    const reply = await call({ action: 'list' }, signal)
    current(); signal?.throwIfAborted(); rows = reply.servers
    return rows
  }
  return {
    name: REMOTE_SERVERS_NAMESPACE, trigger: '@', order: 0,
    async candidates(_session, request) {
      const actual = (await refresh(request.signal)).filter(row => row.configured)
      if (!actual.length) return [{ name: t('noPick') }]
      const query = request.query.toLocaleLowerCase()
      return actual.filter(row => [row.entry.alias, row.entry.host, row.entry.description, ...row.entry.tags]
        .some(value => value.toLocaleLowerCase().includes(query)))
        .map(row => ({ name: row.entry.alias, value: row.reference, description: row.entry.host }))
    },
    onPick(pick) {
      current()
      const row = rows.find(row => row.reference === pick.candidate.value && row.configured)
      if (row === undefined) return undefined
      return { insert: { source: REMOTE_SERVERS_NAMESPACE, ref: row.reference, label: row.entry.alias,
        clipboardText: '@' + row.entry.alias } }
    },
    codec: {
      clipboardText: (ref) => { current(); const row = rows.find(row => row.reference === ref); return '@' + (row?.entry.alias ?? t('title')) },
      async serialize(ref, signal) {
        const row = (await refresh(signal)).find(row => row.reference === ref && row.configured)
        if (row === undefined) throw new Error('cloud/stale-server-reference')
        return 'Remote server reference: ' + JSON.stringify({ server: row.reference, alias: row.entry.alias })
      },
    },
  }
}

/** Attach only when the original bootstrap approves remote management.
 * @param ctx Existing Cloud Loader scope.
 * @param page Exact prepared page and original transport lifetime.
 */
export function installCloudRemoteServers(ctx: Context, page: PreparedCloudPage): void {
  if (page.bootstrap.capabilities.configuration.remoteServers?.manage !== true || page.lifetime.transport.signal.aborted) return
  const dependency = ctx.inject(['connection', 'remote', 'remote.cloudRemoteServers', 'slots', 'locale', 'inputTriggers'], (owner) => {
    const signal = page.lifetime.transport.signal
    const current = (): void => { signal.throwIfAborted(); page.assertAccountManagementCurrent(owner) }
    current()
    const namespace = owner.remote.cloudRemoteServers
    const call = async (request: RemoteServerRequest, observer?: AbortSignal): Promise<RemoteServerReply> => {
      current(); observer?.throwIfAborted()
      const result = await namespace.action(request, observer === undefined ? signal : AbortSignal.any([signal, observer]))
      current(); observer?.throwIfAborted()
      if (!result.ok) throw new Error('cloud/remote-operation-unconfirmed')
      return result.value
    }
    owner.effect(() => owner.locale.register(REMOTE_SERVERS_NAMESPACE, remoteServerDictionaries), 'pe-cloud-client: server copy')
    const t = owner.locale.bind(REMOTE_SERVERS_NAMESPACE)
    owner.effect(() => owner.inputTriggers.registerSource(remoteServerMentionSource(call, current, t)),
      'pe-cloud-client: server references')
    owner.slots.inject('settings.section', () => owner.slots.register({ name: 'settings.section', id: 'cloud-remote-servers', order: 40,
      locale: REMOTE_SERVERS_NAMESPACE, label: () => t('title'), inject: (): RemoteServersInjected => ({
        scope: page.bootstrap.connectionGeneration + ':' + String(owner.fiber.uid), call,
      }) }, ServersSection))
  })
  const stop = (): void => { void observeCloudDisposal(dependency.dispose).catch(() => { console.error('Cloud server page withdrawal unconfirmed.') }) }
  page.lifetime.transport.signal.addEventListener('abort', stop, { once: true })
  ctx.effect(() => async () => { page.lifetime.transport.signal.removeEventListener('abort', stop); await dependency.dispose() },
    'pe-cloud-client: revoke original server page and references')
}
