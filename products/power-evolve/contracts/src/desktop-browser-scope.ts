/** Current account and immutable Session membership for a main-process browser reservation. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { accountUserId } from './account.ts'

/** Native Session selected by the requesting document; parsing does not grant membership. */
export type DesktopBrowserSessionId = Branded<'SessionId'>
/** Platform-owned Workspace identity; it never names a local directory. */
export type DesktopBrowserWorkspaceId = Branded<'PowerEvolveWorkspaceId'>

/** Fixed authenticated Host RPC; Electron uses its own Cloud Session cookie. */
export const DESKTOP_BROWSER_SCOPE_HOST_PATH = '/api/powerEvolve/desktopBrowserScope'
/** Trusted Platform query; the Host forwards only the captured Agent credential. */
export const DESKTOP_BROWSER_SCOPE_PLATFORM_PATH = '/desktop/browser/scope'

/** Only a Session may be requested; the caller cannot choose the owner or storage account. */
export const desktopBrowserScopeRequest = z.object({
  sessionId: z.uuid().transform(value => brandString<DesktopBrowserSessionId>(value.toLowerCase())),
}).strict()

/** One current authorization observation, without credentials, paths or a lasting browser grant. */
export const desktopBrowserScopeView = desktopBrowserScopeRequest.extend({
  userId: accountUserId.transform(value => brandString<typeof value>(value.toLowerCase())),
  workspaceId: z.uuid().transform(value => brandString<DesktopBrowserWorkspaceId>(value.toLowerCase())),
}).strict()

/** Validated request sent by the owned main process through the Host. */
export type DesktopBrowserScopeRequest = z.infer<typeof desktopBrowserScopeRequest>
/** Validated owner and membership; main must still reject stale document or account observations. */
export type DesktopBrowserScopeView = z.infer<typeof desktopBrowserScopeView>
