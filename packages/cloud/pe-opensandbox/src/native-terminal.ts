/** Original Native terminal handle over one signed guardian PTY and its existing command streams. */
import type { SubprocessTerminalHandle, SubprocessTerminalForeground, SubprocessTerminalActivity,
  SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import type { ManagedCommandOperation } from './command-operation.ts'
import { ExecutionStateError } from './errors.ts'

const failure = (): Error => new ExecutionStateError('cloud/execution-unavailable', 'The original terminal connection is unavailable; inspect its effects before continuing.')
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The command row retains range, stream, reservation and stop ownership. This adapter owns only terminal protocol requests. */
export class NativeTerminalHandle implements SubprocessTerminalHandle {
  readonly output
  readonly done
  private readonly ready = Promise.withResolvers<number>()
  private readonly pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>()
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private stopped: Promise<void> | undefined
  private failed = false
  private actualPid: number | undefined

  /** @param operation Original reserved command. @param current Original issued terminal-scope admission.
   * @param release Release that exact Native lifetime after actual terminal cleanup. @param maxPending Original finite waiter count.
   */
  constructor(private readonly operation: ManagedCommandOperation, private readonly current: () => void,
    private readonly release: () => void, private readonly maxPending: number) {
    const handle = operation.handle
    if (handle.stdout === undefined || handle.control === undefined || handle.stdin === undefined) throw failure()
    this.output = handle.stdout; this.done = handle.done
    handle.stderr?.resume()
    void this.ready.promise.catch(() => { /* Allocation waits on this same rejected promise. */ })
    handle.control.on('data', (data: Buffer) => { this.receive(data) })
    handle.control.on('error', () => { this.fail() })
    handle.control.once('end', () => { if (this.stopped === undefined) this.fail() })
    void this.done.then(() => { this.fail(false) }, () => { this.fail() })
  }

  /** Wait for the original guardian’s actual spawned child.
   * @returns This same ready handle.
   */
  async started(): Promise<this> { this.actualPid = await this.ready.promise; this.current(); return this }
  get pid(): number { if (this.actualPid === undefined) throw failure(); return this.actualPid }
  async write(data: string): Promise<void> {
    this.current()
    const stdin = this.operation.handle.stdin
    if (this.stopped !== undefined || this.failed || stdin === undefined) throw failure()
    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (error) => { if (error) reject(failure()); else resolve() })
    })
    this.current()
  }
  async resize(cols: number, rows: number): Promise<void> {
    if (![cols, rows].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) throw new RangeError('Terminal dimensions are invalid.')
    await this.request('resize', [cols, rows])
  }
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    const value = await this.request('foreground', [])
    if (value === null) return undefined
    if (!object(value) || typeof value.processGroupId !== 'number' || !Number.isSafeInteger(value.processGroupId)
      || value.processGroupId <= 1 || typeof value.inputWaiting !== 'boolean') { this.fail(); throw failure() }
    return { processGroupId: value.processGroupId, inputWaiting: value.inputWaiting }
  }
  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    const value = await this.request('activity', [])
    if (!object(value) || value.state !== 'unknown' || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)
      || value.generation < 0) { this.fail(); throw failure() }
    return { state: 'unknown', revision: value.generation }
  }
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const value = await this.request('signal', [signal])
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 1) { this.fail(); throw failure() }
    return value
  }
  terminate(): Promise<void> {
    if (this.stopped !== undefined) return this.stopped
    this.stopped = (async () => {
      this.operation.requestStop(failure()); this.operation.release()
      await this.operation.whenEmpty
      this.release()
    })()
    this.fail(false)
    return this.stopped
  }
  private async request(method: string, args: readonly (string | number)[]): Promise<unknown> {
    this.current()
    const control = this.operation.handle.control
    if (this.failed || this.stopped !== undefined || control === undefined
      || this.pending.size >= this.maxPending || this.sequence >= 0xffffffff) throw failure()
    const id = this.sequence++, response = Promise.withResolvers<unknown>()
    void response.promise.catch(() => { /* The request owner awaits the same response after write settlement. */ })
    this.pending.set(id, response)
    const bytes = Buffer.from(JSON.stringify({ id, method, args }) + '\n')
    try {
      await new Promise<void>((resolve, reject) => { control.write(bytes, (error) => { if (error) reject(failure()); else resolve() }) })
      const value = await response.promise
      this.current()
      return value
    } catch (cause) { this.fail(); throw cause }
    finally { this.pending.delete(id) }
  }
  private receive(data: Buffer): void {
    if (this.failed) return
    if (this.buffer.length + data.length > 8192) { this.fail(); return }
    this.buffer = Buffer.concat([this.buffer, data])
    for (;;) {
      const end = this.buffer.indexOf(10)
      if (end < 0) break
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1)
      let value: unknown
      try { value = JSON.parse(line.toString('utf8')) }
      catch { this.fail(); return }
      if (!object(value)) { this.fail(); return }
      if (Object.keys(value).length === 1 && typeof value.ready === 'number' && Number.isSafeInteger(value.ready) && value.ready > 1 && this.actualPid === undefined) {
        this.actualPid = value.ready; this.ready.resolve(value.ready)
      } else if (Object.keys(value).length === 2 && typeof value.id === 'number' && Object.hasOwn(value, 'value') && this.pending.has(value.id)) {
        const response = this.pending.get(value.id)
        if (response === undefined) { this.fail(); return }
        this.pending.delete(value.id); response.resolve(value.value)
      } else { this.fail(); return }
    }
  }
  private fail(stop = true): void {
    if (this.failed) return
    this.failed = true
    this.ready.reject(failure())
    for (const response of this.pending.values()) response.reject(failure())
    if (stop) this.operation.requestStop(failure())
  }
}
