/** Local raw endpoints for one existing command; transport, signing and process ownership stay with its channel. */
import { Duplex, PassThrough, Writable, type Readable } from 'node:stream'
import type { AgentDataStream } from './agent-data/types.ts'

const BUFFER_BYTES = 4096
type WriteCallback = (error?: Error | null) => void

/** Reserve borrowed caller bytes before this owned Node endpoint can queue behind preparation or remote credit. */
function boundInput(stream: Writable, accept: (chunk: unknown, encoding?: BufferEncoding) => Error | undefined): void {
  const write = stream.write.bind(stream), end = stream.end.bind(stream)
  stream.write = (chunk: unknown, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    const textEncoding = typeof encoding === 'string' ? encoding : undefined
    const done = typeof encoding === 'function' ? encoding : callback
    const failure = accept(chunk, textEncoding)
    if (failure !== undefined) { done?.(failure); return false }
    return textEncoding === undefined ? write(chunk, done) : write(chunk, textEncoding, done)
  }
  stream.end = (chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void): Writable => {
    if (typeof chunk === 'function') return end(chunk as () => void)
    const textEncoding = typeof encoding === 'string' ? encoding : undefined
    const done = typeof encoding === 'function' ? encoding : callback
    if (chunk !== undefined && chunk !== null) {
      const failure = accept(chunk, textEncoding)
      if (failure !== undefined) { const failed: WriteCallback | undefined = done; failed?.(failure); return stream }
      // Node end(chunk) bypasses the public write override; use the same reserved write before its ordinary EOF.
      if (textEncoding === undefined) write(chunk)
      else write(chunk, textEncoding)
    }
    return end(done)
  }
}

/** A preparing native handle's streams; pending writes wait for the original attached transport's receipt. */
export class CommandStreams {
  /** Optional caller input; receipts wait for actual remote pipe acceptance. */
  readonly stdin: Writable | undefined
  /** Original raw stdout; consumption returns remote credit. */
  readonly stdout = new PassThrough({ highWaterMark: BUFFER_BYTES })
  /** Original raw stderr; consumption returns remote credit. */
  readonly stderr = new PassThrough({ highWaterMark: BUFFER_BYTES })
  /** Optional duplex fd7 or guardian terminal control endpoint. */
  readonly control: Duplex | undefined
  private readonly connected = Promise.withResolvers<AgentDataStream>()
  private readonly writes = new Set<Promise<void>>()
  private remote: AgentDataStream | undefined
  private failed = false
  private released = false
  private readonly accepted = { stdin: 0, control: 0 }

  /** @param pipeInput Whether stdin was explicitly requested as a pipe. @param pipeControl Whether fd7 was requested.
   * @param limits Original signed input limits and whole-stream stdout/stderr limit; raw output is never truncated.
   * @param inputCurrent Original operation cancellation/revocation facts; cleanup EOF and output drain do not require new business input.
   * @param onFailure Notify the original command owner; no channel or range is released here.
   */
  constructor(pipeInput: boolean, pipeControl: boolean,
    private readonly limits: { readonly stdinBytes: number; readonly controlInputBytes: number; readonly observedBytes: number },
    private readonly inputCurrent: () => boolean,
    private readonly onFailure: (cause: unknown) => void) {
    void this.connected.promise.catch(() => { /* Original pending writes retain the connection failure. */ })
    this.stdin = pipeInput ? this.input('stdin') : undefined
    this.control = pipeControl ? new Duplex({ highWaterMark: BUFFER_BYTES,
      read: () => { this.remote?.control?.resume() },
      write: (chunk: Buffer, _encoding, done) => { this.write('control', chunk, done) },
      final: (done) => { this.end('control', done) },
      destroy: (error, done) => {
        // Native JsonChannel closes this endpoint even after successful program completion.
        // Its explicit closure sends input EOF and drains the abandoned read side, not the WebSocket.
        if (!this.failed && !this.released) this.end('control', (cause) => {
          if (cause !== undefined && cause !== null && this.inputCurrent()) this.notify(cause)
        })
        this.remote?.control?.resume()
        if (error !== null && this.inputCurrent()) this.notify(error)
        done(error)
      },
    }) : undefined
    if (this.control !== undefined) boundInput(this.control, (chunk, encoding) => this.accept('control', chunk, encoding))
    for (const stream of [this.stdout, this.stderr]) stream.on('error', (error) => { this.notify(error) })
    for (const stream of [this.stdin, this.control]) stream?.on('error', (error) => { if (this.inputCurrent()) this.notify(error) })
  }

  /** Attach exactly once after the channel's accepted upgrade, without admitting commit.
   * @param remote Original authenticated channel endpoints, paired with the prepared spec.
   */
  attach(remote: AgentDataStream): void {
    if (this.remote !== undefined || this.failed || this.released
      || (remote.stdin !== undefined) !== (this.stdin !== undefined)
      || remote.stdout === undefined || remote.stderr === undefined
      || (remote.control !== undefined) !== (this.control !== undefined)) {
      throw new Error('The command stream endpoints do not match the original prepared request.')
    }
    this.remote = remote
    this.output(remote.stdout, this.stdout)
    this.output(remote.stderr, this.stderr)
    const control = this.control
    if (control !== undefined && remote.control !== undefined) {
      const source = remote.control
      source.on('data', (chunk: Buffer) => { if (!control.destroyed && !control.push(chunk)) source.pause() })
      source.once('end', () => { if (!control.destroyed) control.push(null) })
      source.on('error', (error) => { if (this.inputCurrent()) this.notify(error) })
      if (control.destroyed) source.resume()
    }
    this.connected.resolve(remote)
  }

  /** End local pending I/O after the original owner has retained its failure.
   * @param cause Original cause.
   */
  fail(cause: unknown): void {
    if (this.failed) return
    this.failed = true
    this.connected.reject(cause)
    const error = cause instanceof Error ? cause : new Error(String(cause))
    for (const stream of [this.stdin, this.stdout, this.stderr, this.control]) stream?.destroy(error)
  }

  /** Join actual remote writable callbacks after transport closure; it does not report range emptiness. */
  async joinWrites(): Promise<void> { while (this.writes.size !== 0) await Promise.all(this.writes) }

  /** Drop caller-owned buffers only after actual transport settlement and final output-owner release. */
  release(): void {
    if (this.released) return
    this.released = true
    for (const stream of [this.stdin, this.stdout, this.stderr, this.control]) stream?.destroy()
    this.remote = undefined
  }

  private input(name: 'stdin'): Writable {
    const stream = new Writable({ highWaterMark: BUFFER_BYTES,
      write: (chunk: Buffer, _encoding, done) => { this.write(name, chunk, done) }, final: (done) => { this.end(name, done) } })
    boundInput(stream, (chunk, encoding) => this.accept(name, chunk, encoding))
    return stream
  }

  private accept(name: 'stdin' | 'control', chunk: unknown, encoding?: BufferEncoding): Error | undefined {
    if (!this.inputCurrent()) return new Error('Native command input is no longer active.')
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk instanceof Uint8Array ? chunk.byteLength : -1
    const limit = name === 'stdin' ? this.limits.stdinBytes : this.limits.controlInputBytes
    if (this.failed || this.released || bytes < 0 || this.accepted[name] + bytes > limit) {
      const failure = new Error('Command input exceeds its original byte budget.')
      this.notify(failure)
      return failure
    }
    this.accepted[name] += bytes
    return undefined
  }

  private write(name: 'stdin' | 'control', chunk: Buffer, done: (error?: Error | null) => void): void {
    this.forward(name, done, (stream, finish) => {
      if (!this.inputCurrent()) finish(new Error('Native command input is no longer active.'))
      else stream.write(chunk, finish)
    })
  }

  private end(name: 'stdin' | 'control', done: (error?: Error | null) => void): void {
    this.forward(name, done, (stream, finish) => {
      if (stream.writableFinished) finish()
      else stream.end(finish)
    })
  }

  private forward(name: 'stdin' | 'control', done: (error?: Error | null) => void,
    operation: (stream: Writable, finish: (error?: Error | null) => void) => void): void {
    const settled = Promise.withResolvers<undefined>()
    this.writes.add(settled.promise)
    let complete = false
    const finish = (error?: Error | null): void => {
      if (complete) return
      complete = true
      if (error !== undefined && error !== null && this.inputCurrent()) this.notify(error)
      this.writes.delete(settled.promise); settled.resolve(undefined); done(error)
    }
    void this.connected.promise.then((remote) => {
      const stream = remote[name]
      if (stream === undefined) finish(new Error('The requested command input is absent.'))
      else { try { operation(stream, finish) } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))) } }
    }, (cause: unknown) => { finish(cause instanceof Error ? cause : new Error(String(cause))) })
  }

  private output(source: Readable, output: PassThrough): void {
    let observed = 0
    source.on('error', (error) => { this.notify(error) })
    source.once('end', () => { output.end() })
    output.on('drain', () => { source.resume() })
    output.once('close', () => { source.resume() })
    source.on('data', (chunk: Buffer) => {
      observed += chunk.byteLength
      if (observed > this.limits.observedBytes) {
        this.notify(new Error('Raw command output exceeded its observed-byte budget.'))
        return
      }
      if (!output.destroyed && !output.write(chunk)) source.pause()
    })
    if (source.readableEnded) output.end()
  }

  private notify(cause: unknown): void {
    if (this.failed || this.released) return
    this.fail(cause)
    this.onFailure(cause)
  }
}
