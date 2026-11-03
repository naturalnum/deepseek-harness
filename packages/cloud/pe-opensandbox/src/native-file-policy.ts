/** Native Session policy captured before a cloud command obtains a signed execution range. */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { ExecutionStateError } from './errors.ts'
import type { NativeFilePolicy } from './agent-data/file-policy.ts'

const MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

function denied(): never {
  throw new ExecutionStateError('cloud/execution-unavailable', 'The requested Session file policy is unavailable in this sandbox.')
}

/**
 * Resolve an original command's immutable file policy from its real native Session.
 * Subprocess callers omit an override. Native tools resolve approval before passing
 * a typed per-call override; it may widen that call but cannot change its Session/project.
 * @param ctx Calling account provider scope, after original execution-scope admission.
 * @param session Actual registered native Session from the retained execution scope.
 * @param workspaceRoot Original approved project path in the execution world.
 * @param override Optional native per-call policy; no model or HTTP field supplies it.
 * @returns The original three-valued policy that must be covered by the original Root operation signature.
 * @throws ExecutionStateError if native policy is absent or selects an unsupported scope/mode.
 */
export function selectNativeFilePolicy(
  ctx: Context, session: Session, workspaceRoot: string, override?: SandboxExecutionPolicy,
): NativeFilePolicy {
  const provider = ctx.get('sandboxPolicy')
  if (!(provider instanceof SandboxPolicyService)) denied()
  const standing = provider.resolve({ session })
  if (standing.workspaceRoot !== workspaceRoot || standing.sessionId !== session.id
    || !MODES.includes(standing.mode)) denied()
  const selected = override ?? standing
  if (selected.workspaceRoot !== workspaceRoot || selected.sessionId !== session.id
    || !MODES.includes(selected.mode)) denied()
  return Object.freeze({ mode: selected.mode })
}
