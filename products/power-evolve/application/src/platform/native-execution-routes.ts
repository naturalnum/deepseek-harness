/** Original-Agent-bearer native execution routes; PG authority precedes dispatch and original ownership permits only cleanup. */
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import { nativeExecutionWorld, type NativeExecutionWorld } from '../native-execution/types.ts'
import { nativeFsRequest, nativeFsTarget, nativeProcessSpec, nativeTerminalSpec } from '../native-execution/wire.ts'
import { NativeExecutionByteQueue } from './native-execution-byte-queue.ts'
import type { NativeExecutionBroker } from './native-execution-broker.ts'

class ByteWindow {
  private data = Buffer.alloc(0)
  private total = 0
  ended = false
  constructor(private readonly maximum: number) {}
  push(data: Buffer): void {
    this.total += data.length
    this.data = Buffer.concat([this.data, data]).subarray(-this.maximum)
  }
  read(offset: number): { data: string; nextOffset: number; lossy: boolean; exhausted: boolean } {
    const start = this.total - this.data.length
    return { data: this.data.subarray(Math.max(offset - start, 0)).toString('base64'), nextOffset: this.total, lossy: offset < start, exhausted: this.ended }
  }
}
interface CommonEntry { world: NativeExecutionWorld; ctx: Context; outcome: SubprocessOutcome | null; error: string | null; state: 'running' | 'completed' | 'failed' }
interface Entry extends CommonEntry { kind: 'process'; handle: SubprocessHandle; stdout: ByteWindow | NativeExecutionByteQueue; stderr: ByteWindow | NativeExecutionByteQueue; control: NativeExecutionByteQueue | undefined }
interface StreamEntry extends CommonEntry { kind: 'filesystem'; handle: SubprocessHandle; output: NativeExecutionByteQueue }
interface TerminalEntry extends CommonEntry { kind: 'terminal'; handle: SubprocessTerminalHandle; output: NativeExecutionByteQueue }
/** Explicit live-handle and each channel's byte-retention bound; maps never grant execution authority. */
export interface NativeExecutionRouteConfig { maxLiveHandles: number; maxOutputBytes: number }

/** Byte observations and original-id cleanup. Missing live handles never restart an admitted command. */
export class NativeExecutionRoutes {
  private readonly handles = new Map<string, Entry | TerminalEntry | StreamEntry>()
  private readonly pending = new Set<Promise<void>>()
  private readonly starts = new Map<string, { world: NativeExecutionWorld; settled: Promise<void>; controller: AbortController }>()
  private pendingStarts = 0
  private closing = false
  private closeWork: Promise<void> | undefined
  constructor(private readonly broker: NativeExecutionBroker, private readonly config: NativeExecutionRouteConfig) {}

  /** Dispatch one bounded request authenticated with its original operation or interactive bearer.
   * @param path Fixed native execution route.
   * @param token Original bearer; cleanup retains exact original ownership after revocation.
   * @param input Typed JSON, never model credentials or Kubernetes configuration.
   * @returns Native operation result, byte observation or exact stopped proof.
   */
  async route(path: string, token: string, input: unknown): Promise<unknown> {
    if (this.closing) throw new PlatformError(503, 'native_execution_routes_closing')
    const start = path.endsWith('/start'), reservation = Promise.withResolvers<void>()
    if (start && this.handles.size + this.pendingStarts >= this.config.maxLiveHandles) throw new PlatformError(429, 'native_process_capacity')
    if (start) this.pendingStarts++
    this.pending.add(reservation.promise)
    try { return await this.dispatch(path, token, input) }
    finally { if (start) this.pendingStarts--; reservation.resolve(); this.pending.delete(reservation.promise) }
  }

  private async dispatch(path: string, token: string, input: unknown): Promise<unknown> {
    if (path === '/runtime/native-world/open') {
      const request = z.object({ agentId: z.string().min(1).max(256) }).strict().parse(input)
      return (await this.broker.authority.open(token, request.agentId)).world
    }
    const request = z.object({ world: nativeExecutionWorld }).passthrough().parse(input), world = request.world
    if (path === '/runtime/native-world/fs') {
      const body = z.object({ world: nativeExecutionWorld, request: nativeFsRequest }).strict().parse(input)
      await this.broker.authority.assert(token, world, ['writeText', 'editText'].includes(body.request.op) ? 'execution' : 'storage-read')
      if (this.closing) throw new PlatformError(503, 'native_execution_routes_closing')
      const ctx = new Context(), fs = this.broker.binding(ctx, token, world).filesystem
      try {
        const op = body.request
        let value: unknown
        switch (op.op) {
          case 'resolve': value = await fs.resolve(op.path, { cwd: op.cwd }); break
          case 'lstat': value = await fs.lstat(op.path, { cwd: op.cwd }) ?? null; break
          case 'stat': value = await fs.stat(op.target) ?? null; break
          case 'readText': value = await fs.readText(op.target); break
          case 'readBytes': value = Buffer.from(await fs.readBytes(op.target, undefined, op.maxBytes)).toString('base64'); break
          case 'readRange': value = Buffer.from(await fs.readByteRange(op.target, op)).toString('base64'); break
          case 'listDir': value = await fs.listDir(op.target); break
          case 'writeText': value = await fs.writeText(op.target, op.content, op.expected); break
          case 'editText': value = await fs.editText(op.target, op.edit, op.expected); break
        }
        return { ok: true, value }
      } catch (error) { if (error instanceof FsError) return { ok: false, code: error.code, message: error.message }; throw error }
      finally { await ctx.fiber.dispose() }
    }
    if (path === '/runtime/native-world/fs/stream/start') {
      const body = z.object({ world: nativeExecutionWorld, id: z.uuid(), target: nativeFsTarget }).strict().parse(input)
      if (this.starts.has(body.id) || this.handles.has(body.id)) throw new PlatformError(409, 'native_process_duplicate_admission')
      const submitted = Promise.withResolvers<void>(), controller = new AbortController()
      this.starts.set(body.id, { world, settled: submitted.promise, controller })
      const ctx = new Context()
      try {
        await this.broker.authority.assert(token, world, 'storage-read')
        if (this.closing || controller.signal.aborted) throw new PlatformError(503, 'native_execution_routes_closing')
        const fs = this.broker.binding(ctx, token, world).filesystem
        const path = fs.processPath(body.target)
        const handle = this.broker.openFilesystemStream(token, world, { targetKey: path, displayPath: body.target.displayPath }, controller.signal, body.id)
        if (!handle.stdout) throw new PlatformError(500, 'native_fs_stream_output_unavailable')
        const entry: StreamEntry = { world, ctx, kind: 'filesystem', handle, output: new NativeExecutionByteQueue(handle.stdout, this.config.maxOutputBytes),
          state: 'running', outcome: null, error: null }
        this.handles.set(body.id, entry)
        void handle.done.then((value) => { entry.outcome = value; entry.state = 'completed' }, () => { entry.error = 'native_fs_stream_outcome_unavailable'; entry.state = 'failed' })
        return { id: body.id }
      } catch (error) { await ctx.fiber.dispose(); throw error }
      finally { submitted.resolve(); this.starts.delete(body.id) }
    }
    if (path === '/runtime/native-world/process/start' || path === '/runtime/native-world/terminal/start') {
      const terminal = path.includes('/terminal/')
      const body = z.object({ world: nativeExecutionWorld, id: z.uuid(), spec: terminal ? nativeTerminalSpec : nativeProcessSpec }).strict().parse(input)
      if (this.starts.has(body.id) || this.handles.has(body.id)) throw new PlatformError(409, 'native_process_duplicate_admission')
      const submitted = Promise.withResolvers<void>(), controller = new AbortController()
      this.starts.set(body.id, { world, settled: submitted.promise, controller })
      try {
        await this.broker.authority.assert(token, world)
        if (this.closing) throw new PlatformError(503, 'native_execution_routes_closing')
        if (this.handles.has(body.id)) throw new PlatformError(409, 'native_process_duplicate_admission')
        const ctx = new Context()
        try {
          const common = { world, ctx, outcome: null, error: null, state: 'running' as const }
          let entry: Entry | TerminalEntry | StreamEntry
          if (terminal) {
            const handle = await this.broker.terminal(token, world, { ...nativeTerminalSpec.parse(body.spec), signal: controller.signal }, body.id)
            entry = { ...common, kind: 'terminal', handle, output: new NativeExecutionByteQueue(handle.output, this.config.maxOutputBytes) }
          } else {
            const spec = nativeProcessSpec.parse(body.spec)
            const handle = this.broker.spawn(token, world, { ...spec, stdio: { stdin: spec.stdio.stdin, stdout: 'pipe', stderr: 'pipe', ...(spec.stdio.control === undefined ? {} : { control: 'pipe' }) } }, 'process', false, body.id)
            const channel = (stream: NonNullable<SubprocessHandle['stdout']>, mode: typeof spec.stdio.stdout) => {
              if (mode === 'pipe') return new NativeExecutionByteQueue(stream, this.config.maxOutputBytes)
              const tail = new ByteWindow(this.config.maxOutputBytes)
              stream.on('data', (data: Buffer) => { tail.push(Buffer.from(data)) })
              stream.on('end', () => { tail.ended = true })
              return tail
            }
            if (!handle.stdout || !handle.stderr) throw new PlatformError(500, 'native_process_output_unavailable')
            entry = { ...common, kind: 'process', handle, stdout: channel(handle.stdout, spec.stdio.stdout), stderr: channel(handle.stderr, spec.stdio.stderr),
              control: handle.control ? new NativeExecutionByteQueue(handle.control, this.config.maxOutputBytes) : undefined }
          }
          this.handles.set(body.id, entry)
          void entry.handle.done.then((value) => { entry.outcome = value; entry.state = 'completed' }, () => { entry.error = 'native_process_outcome_unavailable'; entry.state = 'failed' })
          if (this.closing) { await this.stop(entry); await ctx.fiber.dispose(); this.handles.delete(body.id); throw new PlatformError(503, 'native_execution_routes_closing') }
          return { id: body.id, ...(entry.kind === 'terminal' ? { pid: entry.handle.pid } : {}) }
        } catch (error) { await ctx.fiber.dispose(); throw error }
      } finally { submitted.resolve(); this.starts.delete(body.id) }
    }
    const body = z.object({ world: nativeExecutionWorld, id: z.uuid(),
      stdoutOffset: z.number().int().nonnegative().optional(), stderrOffset: z.number().int().nonnegative().optional(), controlOffset: z.number().int().nonnegative().optional(),
      outputOffset: z.number().int().nonnegative().optional(), data: z.base64().optional(), cols: z.number().int().positive().max(65535).optional(), rows: z.number().int().positive().max(65535).optional(),
      signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']).optional() }).strict().parse(input)
    const cleanup = path.endsWith('/stop') || path.endsWith('/release') || path.endsWith('/cleanup')
    await this.broker.authority.assertOwnership(token, world)
    const submitted = this.starts.get(body.id)
    if (cleanup && submitted && JSON.stringify(submitted.world) === JSON.stringify(world)) { submitted.controller.abort(); await submitted.settled }
    const entry = this.handles.get(body.id)
    if (!entry) {
      if (!cleanup) throw new PlatformError(409, 'native_process_handle_unavailable')
      const original = await this.broker.pods.original(world, body.id)
      if (original) await this.broker.pods.stop(original, 'dispose')
      return { stopped: true }
    }
    if (JSON.stringify(entry.world) !== JSON.stringify(world)) throw new PlatformError(409, 'native_process_handle_unavailable')
    if (cleanup) {
      await this.stop(entry)
      if (path.endsWith('/release')) { await entry.ctx.fiber.dispose(); this.handles.delete(body.id) }
      return { stopped: true }
    }
    try { await this.broker.authority.assert(token, world, entry.kind === 'filesystem' ? 'storage-read' : 'execution') } catch (error) { await this.stop(entry); throw error }
    if (this.closing) throw new PlatformError(503, 'native_execution_routes_closing')
    if (entry.kind === 'filesystem') {
      if (path !== '/runtime/native-world/fs/stream/poll') throw new PlatformError(404, 'not_found')
      return { state: entry.state, outcome: entry.outcome, error: entry.error, output: entry.output.read(body.outputOffset ?? 0) }
    }
    if (entry.kind === 'terminal') {
      if (path.endsWith('/write')) { if (body.data === undefined) throw new PlatformError(400, 'native_terminal_input_missing'); await entry.handle.write(Buffer.from(body.data, 'base64').toString('utf8')); return { written: true } }
      if (path.endsWith('/resize')) { if (!body.cols || !body.rows) throw new PlatformError(400, 'native_terminal_dimensions_missing'); await entry.handle.resize(body.cols, body.rows); return { resized: true } }
      if (path.endsWith('/foreground')) return await entry.handle.inspectForeground() ?? null
      if (path.endsWith('/activity')) return await entry.handle.inspectActivity()
      if (path.endsWith('/signal')) { if (!body.signal) throw new PlatformError(400, 'native_terminal_signal_missing'); return await entry.handle.signalForeground(body.signal) }
      if (path.endsWith('/poll')) return { state: entry.state, outcome: entry.outcome, error: entry.error, output: entry.output.read(body.outputOffset ?? 0) }
    } else {
      if (path.endsWith('/stdin') || path.endsWith('/control')) {
        const stream = path.endsWith('/control') ? entry.handle.control : entry.handle.stdin
        if (!stream || body.data === undefined) throw new PlatformError(400, 'native_process_channel_unavailable')
        await new Promise<void>((resolve, reject) => stream.write(Buffer.from(body.data!, 'base64'), (error) => { if (error) reject(error); else resolve() }))
        return { written: true }
      }
      if (path.endsWith('/stdinEnd') || path.endsWith('/controlEnd')) {
        const stream = path.endsWith('/controlEnd') ? entry.handle.control : entry.handle.stdin
        if (!stream) throw new PlatformError(400, 'native_process_channel_unavailable')
        await new Promise<void>((resolve) => { stream.end(resolve) }); return { ended: true }
      }
      if (path.endsWith('/poll')) return { state: entry.state, outcome: entry.outcome, error: entry.error,
        stdout: entry.stdout.read(body.stdoutOffset ?? 0), stderr: entry.stderr.read(body.stderrOffset ?? 0),
        control: (() => { const bytes = entry.control?.read(body.controlOffset ?? 0) ?? { data: '', nextOffset: 0, lossy: false, exhausted: true }; return { ...bytes, ended: bytes.exhausted } })() }
    }
    throw new PlatformError(404, 'not_found')
  }

  private async stop(entry: Entry | TerminalEntry | StreamEntry): Promise<void> {
    await entry.handle.terminate()
    if (entry.kind !== 'terminal') await entry.handle.waitForExit()
    // Provider failure must remain visible, while successful stop/release authenticates only
    // range cleanup. The handle's own done consumer retains its original operation error.
    await entry.handle.done.catch(() => undefined)
  }

  /** Close admission synchronously, join pending route calls, then stop every retained exact range.
   * @returns The same joined teardown Promise on repeated calls.
   */
  dispose(): Promise<void> {
    this.closing = true
    this.broker.closeAdmission()
    for (const submitted of this.starts.values()) submitted.controller.abort()
    return this.closeWork ??= (async () => {
      await Promise.all([...this.pending])
      const results = await Promise.allSettled([...this.handles.values()].map(async (entry) => {
        try { await this.stop(entry) } finally { await entry.ctx.fiber.dispose() }
      }))
      this.handles.clear()
      const failures: unknown[] = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
      if (failures.length) throw new AggregateError(failures, 'Native execution route disposal failed')
    })()
  }
}
