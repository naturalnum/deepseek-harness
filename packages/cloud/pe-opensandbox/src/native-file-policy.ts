/** Native Session policy captured before a cloud command obtains a signed execution range. */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { ExecutionStateError } from './errors.ts'
import type { NativeFilePolicy } from './agent-data/file-policy.ts'

function denied(): never {
  throw new ExecutionStateError('cloud/execution-unavailable', 'The requested Session file policy is unavailable in this sandbox.')
}

/**
 * Resolve an original command's immutable file policy from its real native Session.
 * Subprocess callers omit an override. A Shell override cannot change the selected
 * Session/project or widen a read-only Session; this cloud recipe disables approval escalation.
 * @param ctx Calling account provider scope, after original execution-scope admission.
 * @param session Actual registered native Session from the retained execution scope.
 * @param workspaceRoot Original approved project path in the execution world.
 * @param override Optional native per-call policy; no model or HTTP field supplies it.
 * @returns The two-valued policy that must be covered by the original Root operation signature.
 * @throws ExecutionStateError if native policy is absent or selects an unsupported scope/mode.
 */
export function selectNativeFilePolicy(
  ctx: Context, session: Session, workspaceRoot: string, override?: SandboxExecutionPolicy,
): NativeFilePolicy {
  const provider = ctx.get('sandboxPolicy')
  if (!(provider instanceof SandboxPolicyService)) denied()
  const standing = provider.resolve({ session })
  if (standing.workspaceRoot !== workspaceRoot || standing.sessionId !== session.id
    || standing.mode !== 'read-only' && standing.mode !== 'workspace-write') denied()
  const selected = override ?? standing
  if (selected.workspaceRoot !== workspaceRoot || selected.sessionId !== session.id
    || selected.mode !== 'read-only' && selected.mode !== 'workspace-write'
    || standing.mode === 'read-only' && selected.mode !== 'read-only') denied()
  return Object.freeze({ mode: selected.mode })
}
