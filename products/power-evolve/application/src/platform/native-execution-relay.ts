/** Bounded byte transport to one credential-free process relay in the original gVisor Pod. */
import { PassThrough, Duplex, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessTerminalActivity,
  SubprocessTerminalForeground, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'

const event = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), pid: z.number().int().positive() }).strict(),
  z.object({ kind: z.enum(['stdout', 'stderr', 'control']), data: z.base64() }).strict(),
  z.object({ kind: z.enum(['stdoutEnd', 'stderrEnd', 'controlEnd']) }).strict(),
  z.object({ kind: z.literal('exit'), exitCode: z.number().int().nonnegative().nullable(), signal: z.string().nullable() }).strict(),
  z.object({ kind: z.literal('reply'), id: z.uuid(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }).strict(),
])
const foreground = z.object({ processGroupId: z.number().int().positive(), inputWaiting: z.boolean() }).strict()
const activity = z.object({ state: z.enum(['idle', 'busy', 'unknown']), revision: z.number().int().nonnegative() }).strict()

/** Remote bytes and native process facts. Relay input/output never provides authority or range-stop proof. */
export class NativeExecutionRelay {
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly control: Duplex | undefined
  readonly stdin: Writable | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  readonly ready: Promise<number>
  private readonly admission = Promise.withResolvers<number>()
  private readonly replies = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  private readonly writes = new Set<Promise<void>>()
  private closed = false
  private readonly interrupted = new AbortController()

  constructor(private readonly local: SubprocessHandle, spec: Pick<SubprocessSpawnSpec, 'stdio'>, private readonly maxFrameBytes: number) {
    this.ready = this.admission.promise
    const out = typeof spec.stdio.stdout === 'object' ? new OutputCollector(spec.stdio.stdout.maxBytes, 'stdout', undefined) : undefined
    const err = typeof spec.stdio.stderr === 'object' ? new OutputCollector(spec.stdio.stderr.maxBytes, 'stderr', undefined) : undefined
    this.collected = { ...(out ? { stdout: out } : {}), ...(err ? { stderr: err } : {}) }
    this.stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const write = (op: string) => (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
      const work = (async () => {
        const bytes = Buffer.from(chunk), quantum = Math.max(1, Math.floor(maxFrameBytes / 4))
        for (let offset = 0; offset < bytes.length; offset += quantum) await this.send({ op, data: bytes.subarray(offset, offset + quantum).toString('base64') })
      })()
      work.then(() => { callback() }, (error: unknown) => { callback(error instanceof Error ? error : new Error('Native relay write failed', { cause: error })) })
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new Writable({ write: write('stdin'), final: (callback) => {
      this.send({ op: 'stdinEnd' }).then(() => { callback() }, callback)
    } }) : undefined
    this.control = spec.stdio.control === 'pipe' ? new Duplex({ read() {}, write: write('control'), final: (callback) => {
      this.send({ op: 'controlEnd' }).then(() => { callback() }, callback)
    } }) : undefined
    if (typeof spec.stdio.stdin === 'object') {
      const data = Buffer.from(spec.stdio.stdin.data)
      const batch = (async () => {
        for (let offset = 0; offset < data.length; offset += Math.max(1, Math.floor(maxFrameBytes / 4))) {
          await this.send({ op: 'stdin', data: data.subarray(offset, offset + Math.max(1, Math.floor(maxFrameBytes / 4))).toString('base64') })
        }
        await this.send({ op: 'stdinEnd' })
      })()
      this.writes.add(batch); void batch.then(() => { this.writes.delete(batch) }, () => { this.writes.delete(batch); local.terminate() })
    }
    this.done = (async () => {
      let buffer = Buffer.alloc(0), outcome: SubprocessOutcome | undefined
      try {
        if (!local.stdout) throw new Error('Native relay stdout unavailable')
        for await (const chunk of local.stdout) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          buffer = Buffer.concat([buffer, bytes])
          for (;;) {
            const end = buffer.indexOf(10)
            if (end < 0) break
            if (end > maxFrameBytes) throw new Error('Native relay frame exceeds configured bound')
            const frame = event.parse(JSON.parse(buffer.subarray(0, end).toString('utf8')))
            buffer = buffer.subarray(end + 1)
            if (frame.kind === 'ready') this.admission.resolve(frame.pid)
            else if (frame.kind === 'exit') outcome = { exitCode: frame.exitCode, signal: frame.signal as NodeJS.Signals | null }
            else if (frame.kind === 'reply') {
              const reply = this.replies.get(frame.id)
              this.replies.delete(frame.id)
              if (frame.ok) reply?.resolve(frame.value)
              else reply?.reject(new Error('Native relay operation failed: ' + (frame.error ?? 'unknown')))
            } else if ('data' in frame) {
              const data = Buffer.from(frame.data, 'base64')
              if (frame.kind === 'control') {
                if (!this.control) throw new Error('Unexpected native control output')
                if (!this.control.push(data)) await this.waitReadable(this.control)
              } else {
                const stream = frame.kind === 'stdout' ? this.stdout : this.stderr
                const collector = frame.kind === 'stdout' ? out : err
                const mode = frame.kind === 'stdout' ? spec.stdio.stdout : spec.stdio.stderr
                collector?.push(data)
                if (mode === 'inherit') (frame.kind === 'stdout' ? process.stdout : process.stderr).write(data)
                if (stream && !stream.write(data)) await this.waitDrain(stream)
              }
            } else if (frame.kind === 'controlEnd') this.control?.push(null)
            else if (frame.kind === 'stdoutEnd') this.stdout?.end()
            else if (frame.kind === 'stderrEnd') this.stderr?.end()
          }
          if (buffer.length > maxFrameBytes) throw new Error('Native relay incomplete frame exceeds configured bound')
        }
        const transport = await local.done
        if (buffer.length || transport.exitCode !== 0 || !outcome) throw new Error('Native relay outcome unavailable', { cause: new Error('transport=' + JSON.stringify(transport) + '; stderr=' + (local.collected.stderr?.readFrom(0).text ?? '') + '; trailing=' + buffer.length + '; outcome=' + JSON.stringify(outcome)) })
        return outcome
      } finally {
        this.closed = true
        const error = new Error('Native relay closed')
        this.admission.reject(error)
        for (const reply of this.replies.values()) reply.reject(error)
        this.replies.clear()
        const pending = await Promise.allSettled([...this.writes])
        this.stdout?.end(); this.stderr?.end(); this.control?.push(null); this.stdin?.destroy()
        out?.seal(); err?.seal()
        // Joining failed writes is mandatory; their originating calls retain their own rejection.
        void pending
      }
    })()
    void this.ready.catch(() => {})
  }

  private waitDrain(stream: PassThrough): Promise<void> {
    this.interrupted.signal.throwIfAborted()
    if (stream.destroyed) return Promise.reject(new Error('Native relay stream closed'))
    return new Promise((resolve, reject) => {
      const drain = () => { cleanup(); resolve() }, close = () => { cleanup(); reject(new Error('Native relay stream closed')) }
      const cleanup = () => { stream.off('drain', drain); stream.off('close', close); this.interrupted.signal.removeEventListener('abort', close) }
      stream.once('drain', drain); stream.once('close', close)
      this.interrupted.signal.addEventListener('abort', close, { once: true })
      if (this.interrupted.signal.aborted) close()
    })
  }
  private waitReadable(stream: Duplex): Promise<void> {
    // A remote control consumer drains synchronously through its data listener; a bounded
    // paused readable must stop the external relay instead of accumulating guest bytes.
    this.interrupted.signal.throwIfAborted()
    if (stream.destroyed) return Promise.reject(new Error('Native relay control closed'))
    return new Promise((resolve, reject) => {
      const read = () => { cleanup(); resolve() }, close = () => { cleanup(); reject(new Error('Native relay control closed')) }
      const cleanup = () => { stream.off('resume', read); stream.off('close', close); this.interrupted.signal.removeEventListener('abort', close) }
      stream.once('resume', read); stream.once('close', close)
      this.interrupted.signal.addEventListener('abort', close, { once: true })
      if (this.interrupted.signal.aborted) close()
      if (stream.readableFlowing) { cleanup(); resolve() }
    })
  }
  private send(input: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Native relay closed'))
    const work = (async () => {
      await this.ready
      if (this.closed || !this.local.stdin) throw new Error('Native relay input unavailable')
      const bytes = Buffer.from(JSON.stringify(input) + '\n')
      if (bytes.length > this.maxFrameBytes) throw new Error('Native relay input exceeds configured frame bound')
      await new Promise<void>((resolve, reject) => this.local.stdin!.write(bytes, (error?: Error | null) => { if (error) reject(error); else resolve() }))
    })()
    this.writes.add(work); void work.then(() => { this.writes.delete(work) }, () => { this.writes.delete(work) })
    return work
  }
  private async request(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw new Error('Native relay closed')
    const id = randomUUID(), result = Promise.withResolvers<unknown>()
    this.replies.set(id, result)
    try { await this.send({ op, id, ...fields }); return await result.promise }
    finally { this.replies.delete(id) }
  }
  /** Deliver terminal input bytes; the current authority check belongs to the broker.
   * @param data Literal terminal input.
   */
  async write(data: string): Promise<void> { await this.request('stdin', { data: Buffer.from(data).toString('base64') }) }
  /** Resize the actual guest terminal.
   * @param cols Positive columns.
   * @param rows Positive rows.
   */
  async resize(cols: number, rows: number): Promise<void> { await this.request('resize', { cols, rows }) }
  /** Observe the kernel's actual guest foreground process group.
   * @returns Exact group and positive input-wait fact, if available.
   */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    const value = foreground.nullable().parse(await this.request('foreground'))
    return value ?? undefined
  }
  /** Observe explicit shell hooks plus guest Session membership.
   * @returns Fresh shell activity or unknown for unsupported startup.
   */
  async inspectActivity(): Promise<SubprocessTerminalActivity> { return activity.parse(await this.request('activity')) }
  /** Signal the actual foreground group inside the guest.
   * @param signal Native permitted foreground signal.
   * @returns Actual signalled group id.
   */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> { return z.number().int().positive().parse(await this.request('signal', { signal })) }
  /** Unblock byte backpressure after the outside owner starts exact whole-Pod cleanup. */
  interrupt(): void { this.interrupted.abort() }
  /** Start the guest's bounded TERM-to-KILL procedure; outside Pod stop remains authoritative. */
  async terminate(): Promise<void> { if (!this.closed) await this.request('terminate') }
}
