/** Session hooks fail loudly when a focused component unexpectedly acquires native Session state. */
import type {} from '../../../../packages/client/ui-session/src/client/index.ts'
import type {} from '../../../../packages/client/ui-workspace/src/client/index.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

/** Native global seats present in composed programs; these component cases do not supply Session behavior. */
export const unusedSessionStandards: Pick<GlobalStandardProps,
  'useSessions' | 'useSessionStatus' | 'useSessionRetainInfo' | 'useWorkspaces'> = {
  useSessions: () => { throw new Error('Unexpected Session list dependency') },
  useSessionStatus: () => { throw new Error('Unexpected Session status dependency') },
  useSessionRetainInfo: () => { throw new Error('Unexpected Session retention dependency') },
  useWorkspaces: () => { throw new Error('Unexpected Workspace list dependency') },
}
