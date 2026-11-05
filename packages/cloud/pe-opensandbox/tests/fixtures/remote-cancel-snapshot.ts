/** Headless replay of Cloud's Remote wait over the original command owner and synthetic allocation receipts. */
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
import { runRemoteSsh } from '../../src/remote-ssh.ts'
import { remoteManagedFixture } from '../remote-managed-fixture.ts'

export const name = 'remote-cancel-snapshot'
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
  let cancel: (() => void) | undefined, commits = 0, stops = 0
  const audit = (): void => { writeFileSync(join(project, 'local-stop-audit.json'), JSON.stringify({ commits, stops }) + '\n') }
  audit()
  managed.runtimes.command = () => {
    const blank = { bytes: new Uint8Array(), observedBytes: 0, eof: false }
    let view: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
      physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: blank, stderr: blank }
    return {
      async prepare() { return view },
      async commit() { view = { ...view, submitted: true }; commits++; audit(); cancel?.(); return view },
      async poll() { return view },
      async stop() {
        stops++; audit()
        view = { ...view, rangeEmpty: true, ioClosed: true, stdout: { ...blank, eof: true }, stderr: { ...blank, eof: true } }
        return view
      },
    }
  }
  const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('snapshot-account'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'remote-cancel-snapshot', lifetime: lifetime.signal })
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
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'remote_exec',
    description: 'Replay the Cloud Remote cancellation warning with synthetic allocation receipts.', parameters: {},
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('Original Agent is required')
      const agent = exec.agent
      cancel = () => { agent.cancel({ kind: 'user' }) }
      const target: RemoteServer = { id: brandString<RemoteServer['id']>('snapshot-server'), alias: 'fixture', host: 'fixture.invalid',
        port: 2222, user: 'fixture', tags: [], description: '', alwaysAsk: true }
      await runRemoteSsh(ctx, target, { privateKey: 'synthetic-not-a-key', knownHosts: 'synthetic-known-hosts' }, 'sleep 8', exec.signal,
        { pythonPath: '/usr/bin/python3', sshPath: '/usr/bin/ssh', timeoutMs: 10000, probeTimeoutMs: 10000,
          connectTimeoutSeconds: 1, outputMaxBytes: 4096, stopWaitMs: 2000 }, () => { lifetime.signal.throwIfAborted() })
      throw new Error('The cancelled Remote wait must not return success')
    },
  })))
}
