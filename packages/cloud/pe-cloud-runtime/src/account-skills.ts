/** Native skill resources use the original Agent, project guards and files-issued projection results. */
import { posix } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { SkillResourcePreparation, ManagedSkillResourcePreparation } from '@deepseek-ai/dsh-pe-cloud-api'
import { FdMutationFailure, type CloudAccountFiles, type SkillBundleVersion, type SkillVersion,
  type SkillBundleSource, type SkillVersionSource } from '@deepseek-ai/dsh-pe-cloud-files'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { AccountNativeGuards } from './account-native-integration.ts'
import type { AccountBinding } from './types.ts'
import { AccountRuntimeError } from './errors.ts'

type SkillFiles = Pick<CloudAccountFiles, 'binding' | 'assertInstalled' | 'projectFor' | 'prepareSkillProject'
  | 'materializeWorkspaceSkill' | 'assertSkillProjectGrant'
  | 'borrowAllBundleWorkingCopies' | 'assertBundleOperationCopies'>
type SkillGuards = Pick<AccountNativeGuards, 'sessions' | 'projectForAgent' | 'assertWorkspace'>

function original(value: object): object {
  const target: unknown = Reflect.get(value, symbols.original)
  return target !== null && typeof target === 'object' ? target : value
}
function denied(): never {
  throw new AccountRuntimeError('cloud/stale-generation', 'The original skill caller or project is unavailable.')
}

/**
 * Prepare stateless admission and projection callbacks for legacy and full-tree native skill sources.
 * @param ctx Original account graph with its native AgentRegistry and WorkingDirectory providers.
 * @param binding Exact graph binding, retained by the original factory.
 * @param files Resolve the original installed files owner for the checked caller.
 * @param guards Resolve the original shared Session, Agent and Workspace checks.
 * @param assertCurrent Original API, Root and business-admission checks, repeated after every await.
 * @returns Native guidance after a complete issued copy; callers retain a bundle source operation lease through materialization.
 */
export function prepareAccountSkillResources(ctx: Context, binding: AccountBinding,
  files: (caller: Context) => SkillFiles, guards: (caller: Context) => SkillGuards,
  assertCurrent: (caller: Context) => void): SkillResourcePreparation & ManagedSkillResourcePreparation {
  const agents = ctx.get('agents'), directory = ctx.get('workingDirectory')
  if (!(agents instanceof AgentRegistry) || directory === undefined) denied()
  const admit = (options: Parameters<SkillResourcePreparation['assertCaller']>[0]) => {
    options.signal?.throwIfAborted(); binding.lifetime.throwIfAborted()
    assertCurrent(ctx)
    const scope: unknown = options.scope
    if (scope === null || typeof scope !== 'object') denied()
    const id: unknown = Reflect.get(scope, 'id')
    if (typeof id !== 'string') denied()
    const agent = agents.get(SessionId(id))
    if (agent === undefined || agent !== scope) denied()
    if (agent.ctx.root !== ctx.root || agent.ctx.get('peAccount') !== binding
      || ctx.get('peAccount') !== binding || ctx.root.get('peAccount') !== binding) denied()
    for (const owner of [ctx, ctx.root, agent.ctx]) {
      const registry = owner.get('agents'), working = owner.get('workingDirectory')
      if (registry === undefined || working === undefined || original(registry) !== original(agents)
        || original(working) !== original(directory)) denied()
    }
    assertCurrent(agent.ctx)
    const sources = files(agent.ctx)
    sources.assertInstalled(agent.ctx)
    if (sources.binding !== binding) denied()
    const approved = guards(agent.ctx)
    approved.sessions.assertActiveScope(agent)
    const workspace = approved.projectForAgent(agent)
    approved.assertWorkspace(workspace)
    const cwd = directory.get(agent.session)
    if (options.cwd !== undefined && options.cwd !== cwd) denied()
    return { agent, sources, approved, workspace, cwd }
  }
  return {
    assertCaller(options) { admit(options) },
    async materialize(version: SkillVersion | SkillBundleVersion, options: Parameters<SkillResourcePreparation['materialize']>[1],
      source: SkillVersionSource | SkillBundleSource) {
      const selected = admit(options), { sources, workspace } = selected
      if (version.binding !== binding || source.version !== version) denied()
      const current = (): void => {
        const checked = admit(options)
        if (checked.agent !== selected.agent || original(checked.sources) !== original(sources)
          || checked.approved !== selected.approved || checked.workspace !== workspace || checked.cwd !== selected.cwd) denied()
      }
      // Observer cancellation is checked around I/O; it cannot end the wait while native work still uses the parent.
      const settlement = new AbortController().signal
      const installed = await sources.projectFor(workspace, settlement)
      current()
      if (installed.binding !== binding || installed.workspace !== workspace || installed.projectDirectory.binding !== binding) denied()
      const parent = await sources.prepareSkillProject(installed, settlement)
      const cleanup = { releaseParent: true }
      try {
        current(); sources.assertSkillProjectGrant(parent.value)
        if (parent.value.binding !== binding || parent.value.workspaceId !== workspace.id
          || parent.value.project.rootPath !== workspace.path) denied()
        const operation = await sources.borrowAllBundleWorkingCopies(parent.value, settlement)
        try {
          current(); sources.assertSkillProjectGrant(parent.value); sources.assertBundleOperationCopies(operation.value)
          if (operation.value.project !== parent.value || !posix.isAbsolute(workspace.path)) denied()
          const copy = operation.value.copies.find(value => value.version.id === version.id)
          if (copy !== undefined) {
            if (copy.binding !== binding || copy.workspaceId !== workspace.id || copy.version.binding !== binding
              || copy.resourceBase !== `.pe/skills/${version.id}/`) denied()
            if ('format' in version) {
              if (!('format' in copy.version) || copy.version.treeSha256 !== version.treeSha256) denied()
            } else if (copy.version !== version) denied()
            const base = `${posix.join(workspace.path, copy.resourceBase)}/`
            return { resourceBase: { kind: 'directory', path: base }, path: `${base}SKILL.md` }
          }
        } finally { operation.release() }
        const relative = await sources.materializeWorkspaceSkill(installed, parent.value, source, current, settlement)
        current(); sources.assertSkillProjectGrant(parent.value)
        if (posix.isAbsolute(relative) || !relative.startsWith('.skills/') || posix.normalize(relative) !== relative) denied()
        const base = `${posix.join(workspace.path, relative)}/`
        return { resourceBase: { kind: 'directory', path: base }, path: `${base}SKILL.md` }
      } catch (error) {
        if (error instanceof FdMutationFailure && error.outcome === 'unknown') cleanup.releaseParent = false
        throw error
      } finally { if (cleanup.releaseParent) parent.release() }
    },
  }
}
