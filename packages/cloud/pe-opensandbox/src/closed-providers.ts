/** Native execution providers which reject before any execution-world preparation. */
import type { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalEnvironment,
  SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { AccountExecutionPort } from './account-port.ts'

function refuseExecution<Result>(ctx: Context, port: AccountExecutionPort, signal?: AbortSignal): Promise<Result> {
  return new Promise(() => { port.deny(ctx, signal) })
}

/** Native Shell provider with no preparation, handle, backend or host fallback. */
export class ClosedShellExecutor extends ShellExecutor {
  /**
   * @param ctx - account-owned native provider scope.
   * @param port - the same root-issued port used by the subprocess provider.
   */
  constructor(ctx: Context, private readonly port: AccountExecutionPort) { super(ctx) }

  override resolve(request: ShellExecRequest): ShellExecSpec { return this.port.deny(this.ctx, request.signal) }
  override execute(spec: ShellExecSpec): Promise<ShellExecution> { return refuseExecution(this.ctx, this.port, spec.signal) }
}

/** Native subprocess provider; every entry refuses before lookup, allocation or handle creation. */
export class ClosedSubprocessRuntime extends SubprocessRuntime {
  /**
   * @param ctx - account-owned native provider scope.
   * @param port - the same root-issued port used by the Shell provider.
   */
  constructor(ctx: Context, private readonly port: AccountExecutionPort) { super(ctx) }

  override resolveExecutable(_command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return refuseExecution(this.ctx, this.port, signal)
  }
  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return refuseExecution(this.ctx, this.port, signal)
  }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle { return this.port.deny(this.ctx, spec.signal) }
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return refuseExecution(this.ctx, this.port, spec.signal)
  }
}
