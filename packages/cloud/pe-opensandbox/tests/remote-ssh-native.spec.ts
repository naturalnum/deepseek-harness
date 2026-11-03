/** Real SSH through the original NativeCommandAccount. The external allocation transport is a test-owned Docker range. */
import { Context } from '@deepseek-ai/cordis'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomInt } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteServerApproval } from '@deepseek-ai/dsh-pe-cloud-api'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness,
  provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AccountRemoteServers, installRemoteServerTools, PROBE_SCRIPT } from '@deepseek-ai/dsh-remote-server-cloud'
import type { RemoteServer } from '@deepseek-ai/dsh-remote-server-cloud'
import { expect, it, vi } from 'vitest'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { remoteManagedFixture } from './remote-managed-fixture.ts'
import { SessionAllocationOwner } from '../src/allocation-owner.ts'
import { MockAdapter, toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { runRemoteSsh, type RemoteSshConfig } from '../src/remote-ssh.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import type { OperationSpec } from '../src/agent-data/types.ts'

const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function range(image: string, network: string, completed: Set<string>, observed: Set<string>): CommandChannel {
  const name = 'remote-range-' + randomUUID(), blank = { bytes: new Uint8Array(), observedBytes: 0, eof: false }
  let spec: OperationSpec | undefined, child: ChildProcess | undefined
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)
  let view: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false, ioClosed: false,
    physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: blank, stderr: blank }
  return {
    async prepare(value) { spec = value; return view },
    async commit() {
      if (spec === undefined || spec.stdin.mode !== 'batch') throw new Error('Expected original batch range')
      child = spawn('docker', ['run', '-i', '--rm', '--pull=never', '--name', name, '--network', network, '--read-only',
        '--cpus=.5', '--memory=512m', '--pids-limit=32', '--workdir', '/project', image, ...spec.argv], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout!.on('data', (chunk: Buffer) => { stdout = Buffer.concat([stdout,
        chunk]).subarray(-4096); if (stdout.includes('cancel-ready')) observed.add('cancel-ready'); if (stdout.includes('generation-ready')) observed.add('generation-ready') })
      child.stderr!.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-4096) })
      child.once('close', (exitCode, signal) => {
        view = { ...view, commitClosed: true, rangeEmpty: true, ioClosed: true, direct: { exitCode, signal },
          stdout: { bytes: stdout, observedBytes: stdout.length, eof: true }, stderr: { bytes: stderr,
            observedBytes: stderr.length, eof: true } }
        completed.add(name)
      })
      child.stdin!.end(Buffer.from(spec.stdin.base64, 'base64'))
      view = { ...view, submitted: true }; return view
    },
    async poll() { return view },
    async stop() {
      if (child === undefined) view = { ...view, commitClosed: true, rangeEmpty: true, ioClosed: true }
      else if (!view.rangeEmpty) {
        try { docker(['rm', '-f', name]) } catch (_error) { /* A just-removed container remains observed by its original CLI close. */ }
        await new Promise<void>((resolve) => { if (view.rangeEmpty) resolve(); else child!.once('close', () => { resolve() }) })
      }
      return view
    },
  }
}

it('uses real native tool tokens, approvals and original range reservations for key-only SSH and a facts probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-native-range-')), network = 'remote-net-' + randomUUID()
  const server = 'remote-target-' + randomUUID(), image = 'dsh-remote-private-client:fixture'
  const ctx = new Context(), generation = new AbortController(), completed = new Set<string>(), observed = new Set<string>()
  const managed = await remoteManagedFixture()
  let started = false, runs = 0
  vi.spyOn(SessionAllocationOwner.prototype, 'prepare').mockImplementation(async request => ({
    sandboxId: String(request.sessionId), runtimeIdentity: '1'.repeat(64),
    protocolVersion: 'external-docker-fixture', capabilities: ['argv-collect'] }))
  vi.spyOn(SessionAllocationOwner.prototype, 'stop').mockResolvedValue(undefined)
  vi.spyOn(managed.runtimes, 'needsContinuation').mockReturnValue(false)
  vi.spyOn(managed.runtimes, 'skillProject').mockReturnValue(undefined)
  vi.spyOn(managed.runtimes, 'command').mockImplementation(() => { runs++; return range(image, network, completed, observed) })
  try {
    docker(['build', '-t', image, fileURLToPath(new URL('./fixtures/remote-ssh', import.meta.url))])
    let networkReady = false
    for (let attempt = 0; attempt < 8 && !networkReady; attempt++) {
      try { docker(['network', 'create', '--internal', '--subnet', `10.${randomInt(200, 254)}.${randomInt(0,
        254)}.0/28`, network]); networkReady = true }
      catch (_error) { /* Bounded retries choose only an unused private fixture subnet; existing networks stay untouched. */ }
    }
    if (!networkReady) throw new Error('No independent fixture subnet is available')
    const serverDirectory = join(directory, 'server'); await mkdir(serverDirectory)
    const identity = join(directory, 'identity'), hostKey = join(serverDirectory, 'host_key')
    for (const key of [identity, hostKey]) execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    const privateKey = await readFile(identity, 'utf8')
    await writeFile(join(serverDirectory, 'authorized_keys'), await readFile(identity + '.pub'))
    docker(['run', '--rm', '-d', '--name', server, '--network', network, '--network-alias', 'target', '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m', '--mount', `type=bind,src=${serverDirectory},dst=/fixture,readonly`, 'dsh-remote-fixture:20261103'])
    started = true
    const knownHosts = '[target]:2222 ' + (await readFile(hostKey + '.pub', 'utf8')).split(' ').slice(0, 2).join(' ') + '\n'
    const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('remote-native-account'), epoch: brandString<AccountBinding['epoch']>('1'),
      recipeVersion: 'real-native-private-range', lifetime: generation.signal })
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } }); provideWorkingDirectoryFixture(ctx, '/project')
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/project' }); await ctx.plugin(LocalFileSystem)
    let modelReference = ''
    const model = new MockAdapter([() => toolCallResponse('model-remote-call', 'remote_exec', { server: modelReference, command: 'printf native-model-ssh' }), textResponse('remote command completed')])
    ctx.llm.registerAdapter(['fixture-model'], model)
    const loop = await mountAgentLoopTestHarness(ctx), agent = await loop.create(SessionId('remote-native-session'), {}, { cwd: '/project' })
    await ctx.plugin(Approval, { policy: 'ask' })
    const members = [agent.id]
    const workspace: Workspace = { id: brandString<Workspace['id']>('remote-project'), path: '/project', sessionIds: members, title: '', createdAt: '', updatedAt: '',
      setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {}, detachSession: async () => {}, status: async () => 'ok' }
    const port = managed.bind(ctx, binding, { assertBusinessCurrent: () => { generation.signal.throwIfAborted() },
      getAgent: id => ctx.agents.get(id),
      projectForAgent: (current) => { expect(ctx.agents.get(current.id)).toBe(current); return workspace },
      projectForSession: (current) => { expect(ctx.sessions.get(current.id)).toBe(current); return workspace },
      assertRetainedExecutionOwner() { throw new Error('No background jobs in this SSH qualification') }, files() { throw new Error('External test range owns its fixture filesystem') } })
    managed.installProviders(ctx, port)
    let records: readonly RemoteServer[] = []
    const collection = new AccountRemoteServers(ctx, binding, { maxServers: 4, maxCommandBytes: 4096,
      policy: { alwaysAsk: true, readOnlyAllowlist: [] },
      assertCurrent: () => { generation.signal.throwIfAborted() }, read: () => records,
      write: async (next) => { records = next }, deleteCredential: async () => {} })
    await collection.add({ alias: 'target', host: 'target', user: 'fixture', port: 2222, description: '', tags: [], alwaysAsk: true })
    const reference = collection.list()[0]!.reference
    let approve = false, approvals = 0
    ctx.on('approval/request', async () => { approvals++; return approve ? 'allowed-once' : 'rejected' })
    const config: RemoteSshConfig = { pythonPath: '/usr/bin/python3', sshPath: '/usr/bin/ssh', timeoutMs: 10000, probeTimeoutMs: 10000,
      connectTimeoutSeconds: 3, outputMaxBytes: 4096, stopWaitMs: 2000 }
    let currentCredential = { privateKey, knownHosts }, currentConfig = config
    installRemoteServerTools(ctx, collection, { maxReplyBytes: 65536, assertCurrent: () => { generation.signal.throwIfAborted() },
      approval: exec => remoteServerApproval(ctx, binding, exec, () => { generation.signal.throwIfAborted() }),
      run: (exec, target, command, current, probe) => runRemoteSsh(ctx, target, currentCredential, command,
        exec.signal, currentConfig, current, probe),
    })
    agent.session.append('turn/start', { turn: 1 })
    const invoke = (name: string, args: object, signal = new AbortController().signal) => ctx.tools.execute({
      callId: ToolCallId(randomUUID()), name, arguments: args, agent, signal })
    const denied = await invoke('remote_exec', { server: reference, command: 'printf must-not-run' })
    expect(denied.isError).toBe(false); expect(runs).toBe(0)
    approve = true
    const executed = await invoke('remote_exec', { server: reference, command: 'printf original-managed-ssh' })
    expect(executed.isError).toBe(false); expect(JSON.stringify(executed.content)).toContain('original-managed-ssh')
    expect(executed.value).toMatchObject({ ran: true })
    expect(JSON.stringify(executed.value)).toContain('exitCode\\\":0')
    const info = await invoke('remote_server_info', { server: reference })
    expect(info.isError).toBe(false); expect(collection.states()[0]?.connectivity?.reachable).toBe(true)
    expect(collection.states()[0]?.facts?.hostname).toBeTruthy()
    expect(runs).toBe(2); expect(managed.owner.isEpochIdle(binding)).toBe(true)
    expect(completed.size).toBe(2)
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(privateKey)
    expect(PROBE_SCRIPT).toContain('hostname')
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const modelAgent = await loop.create(SessionId('remote-model-session'), { provider: 'fixture-model', model: 'fixture' }, { cwd: '/project' })
    members.push(modelAgent.id); modelReference = reference
    const idle = new Promise<void>((resolve) => { const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === modelAgent && status === 'idle') { dispose(); resolve() }
    }) })
    modelAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run printf native-model-ssh on the selected server reference ' + reference }], source: { kind: 'user' } }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([idle, new Promise<never>((_resolve, reject) => { timer = setTimeout(() =>{  reject(new Error('Native model/tool turn did not finish')) }, 15000) })]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
    expect(model.requests.length).toBe(2)
    const modelResult = model.requests[1]!.messages.find(message => message.role === 'tool')
    expect(JSON.stringify(modelResult)).toContain('native-model-ssh')
    expect(modelResult?.content).toMatchSnapshot('original native SSH tool result')
    expect(JSON.stringify(modelAgent.session.snapshotEvents()).includes('tool/result')).toBe(true)
    expect(JSON.stringify(model.requests).includes(privateKey)).toBe(false)
    expect(JSON.stringify(modelAgent.session.snapshotEvents()).includes(privateKey)).toBe(false)
    expect(runs).toBe(3); expect(managed.owner.isEpochIdle(binding)).toBe(true)
    agent.session.append('turn/start', { turn: 2 })
    setApprovalPolicy(agent.session, 'never')
    const never = await invoke('remote_exec', { server: reference, command: 'printf never-must-not-run' })
    expect(never.isError).toBe(false); expect(runs).toBe(3)
    expect(JSON.stringify(never.value)).toContain('never')
    setApprovalPolicy(agent.session, 'ask')
    currentCredential = { privateKey, knownHosts: '[target]:2222 ' + (await readFile(identity + '.pub', 'utf8')).split(' ').slice(0, 2).join(' ') + '\n' }
    const mismatched = await invoke('remote_server_info', { server: reference })
    expect(mismatched.isError, JSON.stringify(mismatched)).toBe(false)
    expect(JSON.stringify(mismatched.value)).toContain('SSH host identity verification failed')
    expect(collection.states()[0]?.connectivity?.reachable).toBe(false)
    const wrong = join(directory, 'wrong-identity')
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', wrong])
    currentCredential = { privateKey: await readFile(wrong, 'utf8'), knownHosts }
    const unauthorized = await invoke('remote_exec', { server: reference, command: 'printf must-not-authenticate' })
    expect(JSON.stringify(unauthorized.value)).toContain('SSH key authentication failed')
    currentCredential = { privateKey, knownHosts }; currentConfig = { ...config, timeoutMs: 2000 }
    const timedOut = await invoke('remote_exec', { server: reference, command: 'sleep 30' })
    expect(JSON.stringify(timedOut.value)).toContain('timeout')
    expect(JSON.stringify(timedOut.value)).toContain('Remote descendants may still be running')
    expect(managed.owner.isEpochIdle(binding)).toBe(true)
    currentConfig = config
    const cancellation = new AbortController()
    const cancelled = invoke('remote_exec', { server: reference, command: 'printf cancel-ready; sleep 30' }, cancellation.signal)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.waitFor(() => { expect(observed.has('cancel-ready')).toBe(true) }, { timeout: 10000 })
    cancellation.abort(new Error('Fixture caller stopped'))
    const cancellationResult = await cancelled
    expect(JSON.stringify(cancellationResult)).not.toContain('"ran":true')
    await vi.waitFor(() => { expect(managed.owner.isEpochIdle(binding)).toBe(true) }, { timeout: 5000 })
    const generationWork = invoke('remote_exec', { server: reference, command: 'printf generation-ready; sleep 30' })
      .then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.waitFor(() => { expect(observed.has('generation-ready')).toBe(true) }, { timeout: 10000 })
    generation.abort(new Error('Fixture generation ended'))
    await generationWork
    expect(await managed.owner.stopEpoch(binding, Date.now() + 5000)).toMatchObject({ status: 'confirmed', pendingOperationIds: [] })
    expect(() => collection.list()).toThrow()
    console.info(JSON.stringify({ evidence: 'real-ssh-original-native-command-account', approvals, modelRequests: model.requests.length, runs,
      originalManagedStopConfirmed: true, failureModes: ['host-key', 'authentication', 'timeout', 'caller-cancel', 'generation-close'], privateKeyInArgvOrSession: false }))
  } finally {
    await managed.close(); await ctx.fiber.dispose(); vi.restoreAllMocks()
    if (started) docker(['stop', '-t', '1', server])
    try { docker(['network', 'rm', network]) } catch (_error) { /* Build/setup may have failed before network creation. */ }
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
