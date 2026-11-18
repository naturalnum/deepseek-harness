/** Real Native search over the original command owner; only remote command snapshots are synthetic. */
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ManagedCommandOperation, type CommandSnapshot } from '../../src/command-operation.ts'

export default class SearchOutputLimitSubprocess extends SubprocessRuntime {
  private readonly operations: ManagedCommandOperation[] = []
  private readonly failures: unknown[] = []

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      if (this.operations.length !== 1) throw new Error('The replay must execute exactly one original command')
      for (const operation of this.operations) { operation.release(); await operation.whenEmpty }
      if (this.failures.length > 0) throw new AggregateError(this.failures, 'Synthetic search cleanup was unknown')
    })
  }

  async terminalEnvironment() { return { platform: 'posix' as const } }
  async resolveExecutable(command: string) { return command }
  async spawnTerminal(): Promise<never> { throw new Error('This replay has no terminal') }

  spawn(spec: SubprocessSpawnSpec) {
    const blank = { bytes: new Uint8Array(), observedBytes: 0, eof: false }
    const prepared: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false,
      rangeEmpty: false, ioClosed: false, physicalStopRequired: false, providerFailure: false,
      direct: undefined, stdout: blank, stderr: blank }
    const overflow: CommandSnapshot = { ...prepared, submitted: true,
      stdout: { bytes: Buffer.alloc(4096, 120), observedBytes: 65537, eof: false } }
    const stopped: CommandSnapshot = { ...overflow, rangeEmpty: true, ioClosed: true,
      stdout: { ...overflow.stdout, eof: true }, stderr: { ...blank, eof: true } }
    const operation = new ManagedCommandOperation(spec, { maxArgvBytes: 4096, maxArgvEntries: 16,
      maxPathBytes: 512, maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536,
      pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 }, {
      lifetime: new AbortController().signal, assertCurrent() {},
      async acquire() { return { async prepare() { return prepared }, async commit() { return overflow },
        async poll() { return stopped }, async stop() { return stopped } } },
      unknown: (cause) => { this.failures.push(cause) }, retired() {},
    })
    this.operations.push(operation)
    operation.publish(); operation.begin()
    return operation.handle
  }
}
