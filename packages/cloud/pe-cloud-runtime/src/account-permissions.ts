/** Original per-Session file policy at the cloud provider's mutation call. */
import { symbols, type Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

const MODE_RANK: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

function denied(): never {
  throw new FsError('The current Session file policy does not permit this mutation.', 'FS_SANDBOX_DENIED')
}

/**
 * Capture the original native policy provider for one verified Session/project selection.
 * The files provider calls the returned guard immediately before its mutation; an omitted
 * per-call override resolves the Session's current durable mode rather than the account default.
 * Only the trusted Native tool path supplies an override after its approval decision;
 * that call may widen its mode while keeping the exact Session and registered project.
 * @param ctx Original account graph whose policy provider owns the native Session projection.
 * @param session Exact native Session selected by the existing account/project admission.
 * @param workspaceRoot Original registered project path, never a caller-selected prefix.
 * @param assertCurrent Existing selection/Agent/Session/account-generation recheck.
 * @returns Synchronous mutation guard; it owns no resources or independent permission state.
 * @throws FsError if the provider changed, the selected scope differs, or the effective mode denies writes.
 */
export function createAccountFileMutationGuard(
  ctx: Context, session: Session, workspaceRoot: string, assertCurrent: () => void,
): (override?: SandboxExecutionPolicy) => void {
  assertCurrent()
  const policy = ctx.get('sandboxPolicy')
  if (!(policy instanceof SandboxPolicyService)) denied()
  const original: unknown = Reflect.get(policy, symbols.original) ?? policy
  return (override) => {
    assertCurrent()
    const current = ctx.get('sandboxPolicy')
    if (!(current instanceof SandboxPolicyService) || (Reflect.get(current, symbols.original) ?? current) !== original) denied()
    const standing = current.resolve({ session })
    assertCurrent()
    if (standing.workspaceRoot !== workspaceRoot || standing.sessionId !== session.id || !Object.hasOwn(MODE_RANK, standing.mode)) denied()
    const selected = override ?? standing
    if (selected.workspaceRoot !== workspaceRoot || selected.sessionId !== session.id
      || !Object.hasOwn(MODE_RANK, selected.mode) || selected.mode === 'read-only') denied()
  }
}

/**
 * Keep a live delegated Session within every actual runtime ancestor's readonly policy.
 * @param ctx Original account graph with its native Agent registry and policy provider.
 * @param session Exact Session being switched by the native preset service.
 * @param mode Requested file mode; readonly changes cannot broaden an ancestor.
 */
export function assertAccountPermissionAncestry(
  ctx: Context, session: Session, mode: SandboxMode,
): void {
  if (mode === 'read-only') return
  const agents = ctx.get('agents'), policy = ctx.get('sandboxPolicy')
  if (agents === undefined || !(policy instanceof SandboxPolicyService)) denied()
  const initial = agents.get(session.id)
  if (initial === undefined) return
  let child: Agent = initial
  const live = agents.list(), visited = new Set([child.id])
  for (;;) {
    const childId = child.id
    const parent = live.find(candidate => agents.isOwnedBy(childId, candidate))
    if (parent === undefined) return
    if (visited.has(parent.id) || MODE_RANK[policy.resolve({ session: parent.session }).mode] < MODE_RANK[mode]) denied()
    visited.add(parent.id)
    child = parent
  }
}
