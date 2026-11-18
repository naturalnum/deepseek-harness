/** Native Bash and Cloud Shell over original command operations; scope and remote snapshots are synthetic. */
import type { Context } from '@deepseek-ai/cordis'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ManagedCommandOperation as CommandOperation, CommandSnapshot } from '../../src/command-operation.ts'
import type { NativeExecutionProviderPort } from '../../src/native-providers.ts'

const built = process.env.DSH_EXAMPLE_MODE === 'lib'
// Use the same compiler output as the built Host when the Loader runs in plain Node.
const command: typeof import('../../src/command-operation.ts') = await import(
  built ? '../../lib/types/command-operation.js' : '../../src/command-operation.ts')
const shell: typeof import('../../src/native-providers.ts') = await import(
  built ? '../../lib/types/native-providers.js' : '../../src/native-providers.ts')
const shellEnv: typeof import('../../src/native-shell-env.ts') = await import(
  built ? '../../lib/types/native-shell-env.js' : '../../src/native-shell-env.ts')
const service: typeof import('../../src/service-projection.ts') = await import(
  built ? '../../lib/types/service-projection.js' : '../../src/service-projection.ts')

export const name = 'run-deadline-snapshot'
export const inject = []

/** @param ctx The scenario's Loader context; no external execution or account mutation is performed. */
export function apply(ctx: Context): void {
  const owned = new Set<CommandOperation>(), failures: unknown[] = []
  let commands = 0, firstFailure: string | null = null, rangeJoins = 0, providerFailures = 0, unknown = 0
  let directAtSubmission: string | null = null
  const audit = (): void => { writeFileSync(join(process.cwd(), 'deadline-proof.json'), JSON.stringify({
    synthetic: true, commands, firstNativeFailure: firstFailure, rangeJoins, providerFailures, unknown, directAtSubmission }) + '\n') }
  audit()
  const assertCurrent = (): void => { if (failures.length > 0) throw new Error('Synthetic scope retains provider failure') }
  const port: NativeExecutionProviderPort = { enforcesSessionFilePolicy: true, assertCurrent,
    projectRoot: () => process.cwd(),
    create(_caller, spec) {
      assertCurrent()
      const ordinal = ++commands, blank = { bytes: Buffer.alloc(0), observedBytes: 0, eof: false }
      const initial: CommandSnapshot = { prepared: true, submitted: false, commitClosed: false, rangeEmpty: false,
        ioClosed: false, physicalStopRequired: false, providerFailure: false, direct: undefined, stdout: blank, stderr: blank }
      const output = ordinal === 2 ? Buffer.from('T05_AFTER_KNOWN_DEADLINE\n') : Buffer.alloc(0)
      const final: CommandSnapshot = { ...initial, submitted: true, commitClosed: true, rangeEmpty: true, ioClosed: true,
        ...ordinal === 1 ? { stopCause: 'run-deadline' as const } : {}, direct: ordinal === 1 ? undefined : { exitCode: 0, signal: null },
        stdout: { bytes: output, observedBytes: output.length, eof: true }, stderr: { ...blank, eof: true } }
      const operation = new command.ManagedCommandOperation(spec, { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512,
        maxStdinBytes: 4096, maxTailBytes: 4096, maxObservedBytes: 65536, pollIntervalMs: 1,
        maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 }, {
        lifetime: new AbortController().signal, assertCurrent,
        onSubmitted() {
          if (ordinal !== 2) return
          const projection = service.projectServiceRange(operation.handle, {
            whenEmpty: operation.whenEmpty, directStatus: () => operation.directStatus(),
            requestStop: () => operation.requestStop(),
          }, { maxLogReadBytes: 4096, assertCurrent })
          directAtSubmission = projection.status().direct
        },
        async acquire() { return { async prepare() { return initial }, async commit() { return final },
          async poll() { return final }, async stop() { return final } } },
        unknown: (cause) => { unknown++; failures.push(cause); audit() }, retired: () => { owned.delete(operation) },
      })
      if (ordinal === 1) void operation.handle.done.then(() => { firstFailure = 'unexpected-outcome'; audit() },
        (cause: unknown) => { firstFailure = cause instanceof Error ? cause.name : 'non-error'; audit() })
      void operation.whenEmpty.then(() => { rangeJoins++; audit() })
      owned.add(operation)
      audit()
      return operation
    },
    assertOperationCurrent(_caller, operation) { assertCurrent(); if (!owned.has(operation)) throw new Error('Foreign synthetic operation') },
    providerFailed(_operation, cause) { providerFailures++; failures.push(cause); audit() },
    async closeProvider() {
      const operations = [...owned]
      for (const operation of operations) operation.release()
      await Promise.all(operations.map(operation => operation.whenEmpty))
    },
  }
  new shell.CloudShellExecutor(ctx, port, { bashPath: '/bin/bash', timeoutMs: 150000, maxTimeoutMs: 150000,
    maxOutputBytes: 4096, graceMs: 1000, enforceSessionFilePolicy: true })
  new shellEnv.CloudShellEnvRegistry(ctx, port)
  ctx.effect(() => async () => {
    await port.closeProvider()
    if (commands !== 2 || firstFailure !== 'CommandRunDeadlineError' || directAtSubmission !== 'exited' || failures.length > 0) {
      throw new Error('Synthetic run deadline did not preserve its native rejection and the subsequent direct exit observed at submission')
    }
  })
}
