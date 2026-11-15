/** Headless replay through the original coordinator; only allocation transport and Files facts are synthetic. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { CloudAccountFiles, FdMutationFailure, SkillProjectCapacityFailure } from '@deepseek-ai/dsh-pe-cloud-files'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { SessionAllocationOwner } from '../../src/allocation-owner.ts'
import { remoteManagedFixture } from '../remote-managed-fixture.ts'

export const name = 'skill-capacity-snapshot'
export const inject = ['agents', 'tools', 'sessions', 'workingDirectory']

/** Files refusal selected by the scenario; it never represents a real deployment limit. */
export interface Config { resource: 'associations' | 'parent-borrows' }
export const Config: Schema<Config> = Schema.object({
  resource: Schema.union(['associations', 'parent-borrows']).default('associations'),
})

/**
 * @param owner Shipped headless profile's scenario-owned effect context.
 * @param config Explicit refusal selected by the recorded scenario.
 */
export async function apply(owner: Context, config: Config): Promise<void> {
  const ctx = owner.root, managed = await remoteManagedFixture({ skillCopies: 2 }), project = process.cwd()
  const lifetime = new AbortController(), methods = Object.getOwnPropertyDescriptors(SessionAllocationOwner.prototype)
  let attempts = 0, stops = 0, mountReleases = 0, refusals = 0
  const audit = (): void => { writeFileSync(join(project, 'skill-capacity-audit.json'),
    JSON.stringify({ attempts, stops, mountReleases, backendRequests: 0, refusals }) + '\n') }
  audit()
  const warn = console.warn
  SessionAllocationOwner.prototype.prepare = async (request) => {
    attempts++; audit(); await request.prepareMount(); throw new Error('A refused project cannot prepare compute')
  }
  SessionAllocationOwner.prototype.stop = async () => { stops++; audit() }
  ctx.effect(() => async () => {
    try { await managed.close() }
    finally { console.warn = warn
      Object.defineProperties(SessionAllocationOwner.prototype, { prepare: methods.prepare, stop: methods.stop }) }
  })
  // Headless stderr remains strict. Audit only this scenario's exact expected server telemetry; forward every other warning.
  console.warn = (...args) => {
    const fields: unknown = args[1]
    const field = (name: string): unknown => fields !== null && typeof fields === 'object'
      ? Object.getOwnPropertyDescriptor(fields, name)?.value : undefined
    if (args[0] === 'Cloud managed execution preparation refused: %j'
      && field('event') === 'managed-execution-preparation-refused' && field('accountId') === 'snapshot-account'
      && field('code') === 'cloud/capacity' && field('filesCode') === 'FS_TOO_LARGE'
      && field('reasonCode') === 'cloud/capacity' && field('resource') === config.resource) {
      refusals++; audit(); return
    }
    warn(...args)
  }
  const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('snapshot-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'skill-capacity-snapshot', lifetime: lifetime.signal })
  const members: Array<Workspace['sessionIds'][number]> = []
  const workspace: Workspace = { id: brandString<Workspace['id']>('snapshot-project'), path: project, sessionIds: members, title: '',
    createdAt: '', updatedAt: '', setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {},
    detachSession: async () => {}, status: async () => 'ok' }
  const scripted = { projectFor: async () => ({ binding, workspace }),
    prepareExecutionMounts: async () => ({ value: undefined, release() { mountReleases++; audit() } }),
    prepareSkillProject: async () => { throw new FdMutationFailure('not-published', 'FS_TOO_LARGE', undefined,
      { cause: new SkillProjectCapacityFailure(config.resource, 'Synthetic capacity refusal') }) } }
  const files = new Proxy(CloudAccountFiles.prototype, { get(_target, key): unknown { return Reflect.get(scripted, key) } })
  const port = managed.bind(ctx, binding, { assertBusinessCurrent() { lifetime.signal.throwIfAborted() },
    getAgent: id => ctx.agents.get(id), projectForAgent: (agent) => {
      if (!members.includes(agent.session.id)) members.push(agent.session.id)
      return workspace
    }, projectForSession: () => workspace,
    assertRetainedExecutionOwner() { throw new Error('No background work in this replay') }, files: () => files })
  managed.installProviders(ctx, port)
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'remote_exec',
    description: 'Replay a skill-project capacity refusal and an explicit retry through Native Shell.', parameters: {},
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('Original Agent is required')
      if (!members.includes(exec.agent.session.id)) members.push(exec.agent.session.id)
      const shell = await ctx.shell.execute(ctx.shell.resolve({ command: 'printf capacity', onExpiry: 'none' }))
      await shell.done; throw new Error('A refused project must not execute a command')
    },
  })))
}
