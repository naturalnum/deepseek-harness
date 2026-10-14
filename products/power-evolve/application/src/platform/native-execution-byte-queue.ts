/** Acknowledged single-consumer byte queue for native pipe and filesystem streams. */
import type { Readable } from 'node:stream'
import { PlatformError } from '../contracts.ts'

/** Raw stream credit stays bounded and pauses the actual source while the receiver is not consuming it. */
export class NativeExecutionByteQueue {
  private readonly chunks: Buffer[] = []
  private length = 0
  private offset = 0
  private total = 0
  constructor(private readonly source: Readable, private readonly maximum: number) {
    source.on('data', (data: Buffer) => {
      const bytes = Buffer.from(data)
      this.chunks.push(bytes); this.length += bytes.length; this.total += bytes.length
      // The trusted relay emits bounded chunks. At most one source chunk is retained
      // beyond the explicit queue bound; the underlying streams enforce backpressure.
      if (this.length >= this.maximum) source.pause()
    })
  }
  /** Acknowledge only bytes returned by an earlier poll, then offer the next bounded window.
   * @param offset Original monotonic consumer byte position.
   * @returns Canonical bytes with their next acknowledgement position and loss fact.
   */
  read(offset: number): { data: string; nextOffset: number; lossy: boolean; exhausted: boolean } {
    if (offset > this.total) throw new PlatformError(400, 'native_stream_offset_ahead')
    if (offset < this.offset) return { data: '', nextOffset: this.offset, lossy: true, exhausted: false }
    let remove = offset - this.offset
    while (remove > 0) {
      const first = this.chunks[0]
      if (!first) throw new PlatformError(409, 'native_stream_offset_unavailable')
      const count = Math.min(first.length, remove)
      if (count === first.length) this.chunks.shift()
      else this.chunks[0] = first.subarray(count)
      this.length -= count; this.offset += count; remove -= count
    }
    const bytes = Buffer.concat(this.chunks, this.length).subarray(0, this.maximum)
    const result = { data: bytes.toString('base64'), nextOffset: this.offset + bytes.length, lossy: false, exhausted: this.source.readableEnded && this.offset + bytes.length === this.total }
    if (this.length < this.maximum) this.source.resume()
    return result
  }
}
