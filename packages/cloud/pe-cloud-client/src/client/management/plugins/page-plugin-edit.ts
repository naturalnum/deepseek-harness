/** Apply-world adapter to the original PreparedCloudPage and its captured native Connection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PreparedCloudPage } from '../../prepared-page.ts'
import { ClientFailure } from '../../errors.ts'
import type { AccountPluginId } from './types.ts'
import { prepareAccountPluginEdit, type AccountPluginEditState, type PreparedAccountPluginEdit } from './plugin-edit.ts'

/**
 * Read qualified native facts for the original account presentation source, retaining no edit token.
 * @param owner Original namespace-dependent Cloud fiber.
 * @param page Original immutable prepared page and Connection.
 * @param id Approved row selected by the caller.
 * @param observer Explicit original reader lifetime; no polling or retry starts here.
 * @returns Native plugin/configuration facts without the private version or a reusable edit.
 */
export async function readPagePluginState(owner: Context, page: PreparedCloudPage, id: AccountPluginId,
  observer: AbortSignal): Promise<AccountPluginEditState> {
  const edit = await preparePagePluginEdit(owner, page, id, observer)
  page.assertAccountManagementCurrent(owner); observer.throwIfAborted()
  return edit.state
}

/**
 * Prepare one plugin edit using the existing page's currentness and revocation checks.
 * @param owner Original Cloud dependency fiber, not a replacement Context or account borrow.
 * @param page Original PreparedCloudPage installed before the native app activated.
 * @param id Original page-approved row id.
 * @param observer Explicit interaction lifetime; no metadata read is started until called.
 * @returns The actual account read and one-attempt submission callback.
 */
export async function preparePagePluginEdit(owner: Context, page: PreparedCloudPage, id: AccountPluginId,
  observer: AbortSignal): Promise<PreparedAccountPluginEdit> {
  if (!page.bootstrap.capabilities.configuration.plugins.some(plugin => plugin.id === id)) throw new ClientFailure('closed')
  page.assertAccountManagementCurrent(owner)
  const edit = await prepareAccountPluginEdit(owner.remote.cloudPlugins, id, { signal: page.lifetime.transport.signal,
    assertCurrent: () => { page.assertAccountManagementCurrent(owner) } }, observer)
  page.assertAccountManagementCurrent(owner); observer.throwIfAborted()
  return edit
}
