/** Native Service Providers selecting one captured Agent binding per call. */
import { Context } from '@deepseek-ai/cordis'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsEditRequest, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { NativeExecutionProviderConfig } from './types.ts'

/** Filesystem selected from the original native Agent scope for every operation. */
export class NativeCloudFileSystem extends FileSystem {
  constructor(ctx: Context, private readonly config: NativeExecutionProviderConfig) { super(ctx) }
  override get sandboxMode() { return this.config.defaultMode }
  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }) {
    return this.config.resolve().filesystem.resolve(path, opts)
  }
  override processPath(target: FsTarget) { return this.config.resolve().filesystem.processPath(target) }
  override fileUrl(target: FsTarget) { return this.config.resolve().filesystem.fileUrl(target) }
  override contains(parent: FsTarget, child: FsTarget) { return this.config.resolve().filesystem.contains(parent, child) }
  override stat(target: FsTarget, signal?: AbortSignal) { return this.config.resolve().filesystem.stat(target, signal) }
  override lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) {
    return this.config.resolve().filesystem.lstat(path, opts, signal)
  }
  override readText(target: FsTarget, signal?: AbortSignal) { return this.config.resolve().filesystem.readText(target, signal) }
  override streamText(target: FsTarget, signal?: AbortSignal) { return this.config.resolve().filesystem.streamText(target, signal) }
  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) {
    return this.config.resolve().filesystem.readBytes(target, signal, maxBytes)
  }
  override readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal) {
    return this.config.resolve().filesystem.readByteRange(target, range, signal)
  }
  override listDir(target: FsTarget, signal?: AbortSignal) { return this.config.resolve().filesystem.listDir(target, signal) }
  override writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy) { return this.config.resolve().filesystem.writeText(target, content, expected, signal, sandboxPolicy) }
  override editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy) { return this.config.resolve().filesystem.editText(target, edit, expected, signal, sandboxPolicy) }
}

/** Subprocess selection never changes after its synchronous spawn captures the Agent. */
export class NativeCloudSubprocess extends SubprocessRuntime {
  constructor(ctx: Context, private readonly config: NativeExecutionProviderConfig) { super(ctx) }
  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) {
    return this.config.resolve().subprocess.resolveExecutable(command, env, signal)
  }
  override terminalEnvironment(signal?: AbortSignal) { return this.config.resolve().subprocess.terminalEnvironment(signal) }
  override spawn(spec: SubprocessSpawnSpec) { return this.config.resolve().subprocess.spawn(spec) }
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec) { return this.config.resolve().subprocess.spawnTerminal(spec) }
}

/** Per-call confinement resolves in the same captured world as native Fs and Subprocess. */
export class NativeCloudSandbox extends SandboxProvider {
  constructor(ctx: Context, private readonly config: NativeExecutionProviderConfig) { super(ctx) }
  override confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
    return this.config.resolve().sandbox.confine(argv, policy, signal)
  }
}

/** Mount the shared native providers after replacing the local service rows.
 * @param ctx Trusted Runtime Context containing native consumers and permission policy.
 * @param config Default confinement and synchronous original-Agent scope resolver.
 */
export function installNativeExecutionProviders(ctx: Context, config: NativeExecutionProviderConfig): void {
  ctx.plugin(NativeCloudFileSystem, config)
  ctx.plugin(NativeCloudSubprocess, config)
  ctx.plugin(NativeCloudSandbox, config)
}

export { nativeExecutionWorld } from './types.ts'
export type { NativeExecutionWorld, NativeExecutionBinding, NativeExecutionBindingResolver, NativeExecutionProviderConfig } from './types.ts'
