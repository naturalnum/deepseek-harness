/** Headless replay of Cloud facts budget over the original command owner and synthetic allocation receipts. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { RemoteServer } from '@deepseek-ai/dsh-remote-server-cloud'
import { SessionAllocationOwner } from '../../src/allocation-owner.ts'
import type { CommandSnapshot } from '../../src/command-operation.ts'
import { PROBE_SCRIPT, parseProbe } from '@deepseek-ai/dsh-remote-server-cloud'
import { guardianWorkingCopiesBudget } from '../../src/agent-data/encoded-budget.ts'
import { runRemoteSsh } from '../../src/remote-ssh.ts'
import { remoteManagedFixture } from '../remote-managed-fixture.ts'

export const name = 'remote-facts-budget-snapshot'
export const inject = ['agents', 'tools', 'sessions', 'workingDirectory']

/** @param owner Shipped headless profile's scenario-owned effect context. */
export async function apply(owner: Context): Promise<void> {
  const ctx = owner.root
  const managed = await remoteManagedFixture(), lifetime = new AbortController(), project = process.cwd()
  const methods = Object.getOwnPropertyDescriptors(SessionAllocationOwner.prototype)
  SessionAllocationOwner.prototype.prepare = async request => ({ sandboxId: String(request.sessionId), runtimeIdentity: '1'.repeat(64),
    protocolVersion: 'synthetic-snapshot-range', capabilities: ['argv-collect'] })
  SessionAllocationOwner.prototype.stop = async () => {}
  ctx.effect(() => async () => {
    try { await managed.close() }
    finally { Object.defineProperties(SessionAllocationOwner.prototype, { prepare: methods.prepare, stop: methods.stop }) }
  })
  managed.runtimes.needsContinuation = () => false
  managed.runtimes.skillProject = () => undefined
  // Only external allocation/SSH is synthetic. The received managed spec uses the original full budget encoder.
  const budgetProject = '/srv/dsh-features-281fb24f-afdd-4266-8f89-bbda8f8a6a4d/accounts/'
    + 'v1-0b3a173da0d6d761b3976f4f776e623a9054503c25df9196208ec4d3fb7f8715/projects/default-workspace'
  const output = 'hostname=synthetic-fixture\nos=Synthetic OS\ncpu_cores=4\n'
  let commits = 0, guardianBytes = 0, ioClosed = false
  const audit = (): void => { writeFileSync(join(project, 'facts-budget-audit.json'),
    JSON.stringify({ synthetic: true, budgetProjectBytes: Buffer.byteLength(budgetProject), skillCopies: 8,
      guardianBytes, commits, ioClosed, output }) + '\n') }
  audit()
  managed.runtimes.command = () => {
    const blank = { bytes: new Uint8Array(), observedBytes: 0, eof: false }
    let view: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
      physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: blank, stderr: blank }
    return {
      async prepare(value) {
        guardianBytes = guardianWorkingCopiesBudget(budgetProject, { ...value, cwd: budgetProject },
          8, { mode: 'danger-full-access' })
        audit(); return view
      },
      async commit() {
        commits++; ioClosed = true
        view = { ...view, submitted: true, rangeEmpty: true, ioClosed: true,
          direct: { exitCode: 0, signal: null },
          stdout: { bytes: Buffer.from(output), observedBytes: Buffer.byteLength(output), eof: true },
          stderr: { ...blank, eof: true } }
        audit(); return view
      },
      async poll() { return view },
      async stop() { return view },
    }
  }
  const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('snapshot-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'remote-facts-budget-snapshot', lifetime: lifetime.signal })
  const members: Array<Workspace['sessionIds'][number]> = []
  const workspace: Workspace = { id: brandString<Workspace['id']>('snapshot-project'), path: project, sessionIds: members, title: '',
    createdAt: '', updatedAt: '', setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {},
    detachSession: async () => {}, status: async () => 'ok' }
  const port = managed.bind(ctx, binding, { assertBusinessCurrent() { lifetime.signal.throwIfAborted() },
    getAgent: id => ctx.agents.get(id), projectForAgent: (agent) => {
      if (!members.includes(agent.id)) members.push(agent.id)
      return workspace
    }, projectForSession: () => workspace,
    assertRetainedExecutionOwner() { throw new Error('No background job in this replay') },
    files() { throw new Error('Synthetic allocation channel replaces remote files') } })
  managed.installProviders(ctx, port)
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'remote_server_info',
    description: 'Replay the fixed Cloud facts probe over synthetic SSH after the original eight-copy guardian budget.', parameters: {},
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('Original Agent is required')
      const target: RemoteServer = { id: brandString<RemoteServer['id']>('snapshot-server'), alias: 'fixture', host: 'fixture.invalid',
        port: 2222, user: 'fixture', tags: [], description: '', alwaysAsk: true }
      const result = await runRemoteSsh(ctx, target,
        { privateKey: 'synthetic-not-a-key', knownHosts: 'synthetic-known-hosts' }, PROBE_SCRIPT, exec.signal,
        { pythonPath: '/usr/local/bin/python3', sshPath: '/usr/bin/ssh', timeoutMs: 10000, probeTimeoutMs: 10000,
          connectTimeoutSeconds: 1, outputMaxBytes: 4096, stopWaitMs: 2000 }, () => { lifetime.signal.throwIfAborted() }, true)
      if (result.kind !== 'completed' || result.exitCode !== 0) throw new Error('Synthetic probe did not complete')
      return [{ type: 'text', text: JSON.stringify({ synthetic: true,
        facts: parseProbe(result.stdout.text, '2026-01-01T00:00:00.000Z') }) }]
    },
  })))
}
