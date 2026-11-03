/** Shipped Minimal through Loader/AccountPolicy/Native Bash and Cloud subprocess; the external kernel is a real local PTY. */
import { readFileSync } from 'node:fs'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { load } from 'js-yaml'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import Compaction from '@deepseek-ai/dsh-compaction-basic'
import * as CommandCompact from '@deepseek-ai/dsh-command-compact'
import Commands from '@deepseek-ai/dsh-commands'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Terminals from '@deepseek-ai/dsh-terminal'
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash'
import * as PersistentBash from '@deepseek-ai/dsh-tool-bash-persistent'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import { policyFixture } from '../../pe-cloud-runtime/tests/account-policy-fixture.ts'
import { NativeCommandAccount, type NativeCommandRoot } from '../src/native-command-account.ts'
import { CloudSubprocessRuntime } from '../src/native-providers.ts'
import { CloudSandboxProvider } from '../src/native-sandbox.ts'
import type { CommandChannel, CommandSnapshot } from '../src/command-operation.ts'
import type { PipesOperationSpec } from '../src/agent-data/types.ts'
import type { ExecutionScope } from '../src/scopes.ts'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

function remoteKernel(runtime: LocalSubprocessRuntime) {
  const empty = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
  let snapshot: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
    ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: empty, stderr: empty }
  let spec: PipesOperationSpec | undefined, handle: SubprocessTerminalHandle | undefined, controlInput = ''
  let starting: Promise<SubprocessTerminalHandle> | undefined
  const stdout = new PassThrough(), stderr = new PassThrough()
  const ended = Promise.withResolvers<undefined>(), closed = Promise.withResolvers<undefined>()
  const control = new Duplex({ read() {}, write(chunk: Buffer, _encoding, done) {
    controlInput += chunk.toString('utf8')
    const commands = controlInput.split('\n'); controlInput = commands.pop() ?? ''
    void (async () => {
      for (const line of commands) {
        const request = JSON.parse(line) as { id: number; method: string; args: (string | number)[] }
        if (handle === undefined) throw new Error('External PTY absent')
        let value: unknown
        switch (request.method) {
          case 'foreground': value = await handle.inspectForeground() ?? null; break
          case 'activity': value = { state: 'unknown', generation: 0 }; break
          case 'resize': await handle.resize(Number(request.args[0]), Number(request.args[1])); value = null; break
          case 'signal': {
            const signal = request.args[0]
            if (signal !== 'SIGINT' && signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new Error('External signal invalid')
            value = await handle.signalForeground(signal); break
          }
          default: throw new Error('External guardian method invalid')
        }
        control.push(JSON.stringify({ id: request.id, value }) + '\n')
      }
    })().then(() => { done() }, done)
  } })
  const stdin = new Writable({ write(chunk: Buffer, _encoding, done) {
    if (handle === undefined) { done(new Error('External PTY absent')); return }
    void handle.write(chunk.toString('utf8')).then(() => { done() }, done)
  } })
  const channel: CommandChannel = {
    async prepare(input) {
      if (input.executionKind !== 'pipes' || input.stream.terminal === undefined) throw new Error('Expected original PTY operation')
      spec = input; return snapshot
    },
    async attach() { return { stdin, stdout, stderr, control,
      outputEnded: ended.promise, settled: closed.promise, close() { closed.resolve(undefined) } } },
    async whenLocallySettled() { await closed.promise },
    async commit() {
      if (spec?.stream.terminal === undefined) throw new Error('Original terminal spec absent')
      const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: spec.cwd, LANG: 'C.UTF-8' }
      for (const [key, value] of Object.entries(spec.env)) { if (value === null) Reflect.deleteProperty(env, key); else env[key] = value }
      starting = runtime.spawnTerminal({ argv: spec.argv, cwd: spec.cwd, env,
        rows: spec.stream.terminal.rows, cols: spec.stream.terminal.cols, terminalType: 'xterm-256color', graceMs: 1000 })
      handle = await starting
      handle.output.pipe(stdout)
      control.push(JSON.stringify({ ready: handle.pid }) + '\n')
      snapshot = { ...snapshot, submitted: true }
      void handle.done.then((outcome) => {
        snapshot = { ...snapshot, rangeEmpty: true, ioClosed: true, direct: outcome,
          stdout: { ...empty, eof: true }, stderr: { ...empty, eof: true } }
        stdout.end(); stderr.end(); control.push(null); ended.resolve(undefined)
      })
      return snapshot
    },
    async poll() { return snapshot },
    async stop() {
      if (starting !== undefined) handle = await starting
      if (handle === undefined) {
        snapshot = { ...snapshot, rangeEmpty: true, ioClosed: true, commitClosed: true,
          stdout: { ...empty, eof: true }, stderr: { ...empty, eof: true } }
        stdout.end(); stderr.end(); control.push(null); ended.resolve(undefined)
      } else await handle.terminate()
      await ended.promise; return snapshot
    },
  }
  return channel
}

it('runs the actual shipped Minimal persistent shell and joins its original owner on retirement', async () => {
  const source: unknown = load(readFileSync(new URL('../../../bundle/web-app/presets/minimal.patch.yml', import.meta.url), 'utf8'),
    { schema: entryListSchema })
  const declarations = source as readonly { insert: readonly { id: string; config: PresetDefinition }[] }[]
  if (!Array.isArray(source)) throw new Error('Shipped Minimal declaration absent')
  const row = declarations[0]?.insert[0]
  if (row === undefined) throw new Error('Shipped Minimal declaration absent')
  expect((await import('@deepseek-ai/dsh-agent-preset-registry')).entryListProblem(row.config.plugins)).toBeUndefined()
  const kernel = new Context(), local = new LocalSubprocessRuntime(kernel), capacity = { active: 0, resident: 0, starts: 0 }
  onTestFinished(() => kernel.fiber.dispose())
  let commands: NativeCommandAccount | undefined, retained: ExecutionScope<Workspace> | undefined
  const root = {
    async acquire(scope) { retained = scope; capacity.starts++; return remoteKernel(local) },
    unknown: vi.fn(), close: async () => {},
    reserve() { capacity.active++; capacity.resident++; return {
      releaseActive() { capacity.active-- }, releaseResident() { capacity.resident-- },
    } },
  } satisfies NativeCommandRoot
  const f = policyFixture([], undefined, 'real-minimal-policy', undefined, undefined, undefined, undefined, undefined, [], false,
    undefined, { defaultId: 'minimal', declarations: [{ entryId: row.id, config: row.config, selectable: true }],
      sourceModules: {
        '@deepseek-ai/dsh-persona': Persona, '@deepseek-ai/dsh-tool-fs': ToolFs,
        '@deepseek-ai/dsh-compaction-basic': Compaction, '@deepseek-ai/dsh-command-compact': CommandCompact,
        '@deepseek-ai/dsh-terminal': Terminals, '@deepseek-ai/dsh-terminal-bash': TerminalBash,
        '@deepseek-ai/dsh-tool-bash-persistent': PersistentBash,
        '@deepseek-ai/dsh-sandbox-policy': SandboxPolicy, '@deepseek-ai/dsh-commands': Commands, '@deepseek-ai/dsh-token-meter': TokenMeter,
      }, extraEntries: [
        { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: '/unused-fallback' } },
        { id: 'commands', name: '@deepseek-ai/dsh-commands' }, { id: 'token-meter', name: '@deepseek-ai/dsh-token-meter' },
      ], prepare(ctx, binding, guards) {
        commands = new NativeCommandAccount(ctx, binding, {
          assertBusinessCurrent() { binding.lifetime.throwIfAborted(); ctx.fiber.assertActive() },
          getAgent: id => ctx.agents.get(id), projectForAgent: guards.projectForAgent, projectForSession: guards.projectForSession,
          assertRetainedExecutionOwner: guards.assertRetainedExecutionOwner, files() { throw new Error('Only external kernel is replaced') },
        }, { allowedTools: ['bash', 'run_code', 'terminal_open'], maxScopes: 8, enforceSessionFilePolicy: true,
          pipes: { controlInputBytes: 8388608, controlOutputBytes: 8388608 }, commandLimits: { maxArgvBytes: 4096,
            maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
            pollIntervalMs: 5, maxWaiters: 4, maxLifetimeMs: 15000, stopWaitMs: 2000 } }, root)
        const sandbox = new CloudSandboxProvider(ctx, commands.calls, { current: () => ({ enforcement: 'partial',
          denialSignatures: [], runnerFailureRules: [] }) }, { maxArgvBytes: 4096, maxArgvEntries: 16 })
        new CloudSubprocessRuntime(ctx, commands, sandbox)
        ctx.effect(() => () => { sandbox.close() }, 'fixture sandbox disposal')
      } })
  const graph = await f.start(), first = await graph.ctx.sessionController.create({})
  const agent = graph.ctx.agents.get(first.sessionId)
  if (agent === undefined || commands === undefined) throw new Error('Original Minimal Agent or execution owner absent')
  expect(() => { graph.guards.presets.assertSession(agent) }).not.toThrow()
  const terminal = graph.ctx.agentPresets.serviceFor(agent, 'terminals')
  expect(terminal).toBeInstanceOf(Terminals)
  const call = (id: string, command: string) => graph.ctx.tools.execute({ callId: ToolCallId(id), name: 'bash', agent,
    signal: new AbortController().signal, arguments: { command } })
  const firstResult = await call('minimal-first', 'DSH_MINIMAL_VALUE=forty-two; printf "first-live\\n"')
  expect(firstResult.isError, JSON.stringify(firstResult.content)).toBe(false)
  const nextResult = await call('minimal-next', 'printf "%s\\n" "$DSH_MINIMAL_VALUE"')
  expect(nextResult.isError, JSON.stringify(nextResult.content)).toBe(false)
  expect(JSON.stringify(nextResult.content)).toContain('forty-two')
  expect(capacity.starts).toBe(1)
  if (terminal === undefined) throw new Error('Original isolated terminal absent')
  const held = terminal.list(agent)[0]
  if (held === undefined) throw new Error('Original persistent terminal absent')
  const second = await graph.ctx.sessionController.create({}), foreign = graph.ctx.agents.get(second.sessionId)
  if (foreign === undefined) throw new Error('Second Native Agent absent')
  expect(() => { terminal.read(foreign, held.sessionId) }).toThrow()
  await terminal.kill(agent, held.sessionId)
  await vi.waitFor(() => { expect(capacity).toEqual({ active: 0, resident: 0, starts: 1 }) })
  await graph.ctx.agentLoop.stop()
  if (retained === undefined || commands === undefined) throw new Error('Original issued scope absent')
  const originalScope = retained, originalCommands = commands
  expect(() => { originalCommands.calls.assertCurrent(originalScope) }).toThrow()
  expect(originalCommands.calls.inspect()).toBe(0)
  expect(root.unknown).not.toHaveBeenCalled()
}, 30000)
