/** Native reader storage only; no backend, process outcome, authorized scope or product capability is supplied. */
import { expect, it } from 'vitest'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { CollectedOutputFailure, CollectedOutputMirror } from '../src/collected-output.ts'

function failure(run: () => void): CollectedOutputFailure {
  try { run() }
  catch (error) {
    if (error instanceof CollectedOutputFailure) return error
    throw error
  }
  throw new Error('Expected a classified collection failure.')
}

it('serves the native reader without consumption and retains final output after sealing', () => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 32)
  const a: SubprocessOutputReader = output, b: SubprocessOutputReader = output
  expect(a.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
  output.push(Buffer.from('abc'))
  const first = a.readFrom(0)
  expect(first).toEqual({ text: 'abc', nextOffset: 3, lossy: false })
  expect(b.readFrom(0)).toEqual(first)
  output.push(Buffer.from('def'))
  expect(a.readFrom(first.nextOffset)).toEqual({ text: 'def', nextOffset: 6, lossy: false })
  expect(b.readFrom(1)).toEqual({ text: 'bcdef', nextOffset: 6, lossy: false })
  output.seal(); output.seal()
  expect(a.readFrom(0)).toEqual({ text: 'abcdef', nextOffset: 6, lossy: false })
  expect(output.residentBytes).toBe(8)
  expect(output.failure).toBeUndefined()
  output.release()
})

it.each([
  [Buffer.from('abcde'), Buffer.from('fg'), Buffer.from('hijklmnop')],
  [Buffer.from('abcdefghijklmnop')],
  [...Buffer.from('abcdefghijklmnop')].map(value => Uint8Array.of(value)),
])('retains exactly the final cap bytes across chunk shapes %#', (...chunks) => {
  const output = new CollectedOutputMirror({ maxBytes: 7 }, 64)
  let stream = Buffer.alloc(0)
  for (const chunk of chunks) {
    stream = Buffer.concat([stream, chunk])
    output.push(chunk)
    expect(output.snapshot()).toEqual({ bytes: stream.subarray(Math.max(0, stream.length - 7)), totalBytes: stream.length })
    expect(output.residentBytes).toBe(7)
  }
  expect(output.readFrom(0)).toEqual({ text: 'jklmnop', nextOffset: 16, lossy: true })
  expect(output.readFrom(9)).toEqual({ text: 'jklmnop', nextOffset: 16, lossy: false })
  expect(output.readFrom(16)).toEqual({ text: '', nextOffset: 16, lossy: false })
  output.release()
})

it('keeps exact byte coordinates for split UTF-8 and never derives offsets from replacement text', () => {
  const output = new CollectedOutputMirror({ maxBytes: 16 }, 32)
  output.push(Uint8Array.of(0xe4))
  const incomplete = output.readFrom(0)
  expect(incomplete).toEqual({ text: '\ufffd', nextOffset: 1, lossy: false })
  expect(Buffer.byteLength(incomplete.text)).not.toBe(incomplete.nextOffset)
  output.push(Uint8Array.of(0xbd)); output.push(Uint8Array.of(0xa0))
  expect(output.readFrom(0)).toEqual({ text: '你', nextOffset: 3, lossy: false })
  expect(output.readFrom(1)).toEqual({ text: '\ufffd\ufffd', nextOffset: 3, lossy: false })
  output.push(Buffer.from([0xff, 0xfe, 0, 13, 10]))
  output.seal()
  const expected = Buffer.from([0xe4, 0xbd, 0xa0, 0xff, 0xfe, 0, 13, 10])
  expect(output.snapshot()).toEqual({ bytes: expected, totalBytes: expected.length })
  expect(output.readFrom(0)).toEqual({ text: expected.toString('utf8'), nextOffset: 8, lossy: false })
  output.release()
})

it('preserves a raw tail even when its head cuts a UTF-8 code point', () => {
  const output = new CollectedOutputMirror({ maxBytes: 3 }, 8)
  output.push(Buffer.from('你ab'))
  expect(output.snapshot()).toEqual({ bytes: Buffer.from([0xa0, 0x61, 0x62]), totalBytes: 5 })
  expect(output.readFrom(0)).toEqual({ text: '\ufffdab', nextOffset: 5, lossy: true })
  output.release()
})

it('copies caller views and snapshots without retaining or exposing their backing storage', () => {
  const output = new CollectedOutputMirror({ maxBytes: 4 }, 16)
  const source = Buffer.from('xxabcdefyy')
  output.push(source.subarray(2, 8))
  source.fill(0)
  const first = output.snapshot()
  expect(first).toEqual({ bytes: Buffer.from('cdef'), totalBytes: 6 })
  first.bytes.fill(0)
  expect(output.snapshot().bytes).toEqual(Buffer.from('cdef'))
  const retained = output.snapshot()
  output.release()
  expect(retained.bytes).toEqual(Buffer.from('cdef'))
})

it('accepts exact limits and classifies a whole rejected chunk without advancing or releasing storage', () => {
  const output = new CollectedOutputMirror({ maxBytes: 4 }, 6)
  output.push(Buffer.from('abcdef'))
  expect(output.acceptedBytes).toBe(6)
  const error = failure(() => { output.push(Buffer.from('xy')) })
  expect(error).toMatchObject({ code: 'cloud/capacity', reason: 'observed-byte-limit', acceptedBytes: 6,
    rejectedChunkBytes: 2, maxObservedBytes: 6 })
  expect(output.acceptedBytes).toBe(6)
  expect(output.residentBytes).toBe(4)
  expect(output.failure).toBe(error)
  expect(failure(() => { output.readFrom(0) })).toBe(error)
  expect(failure(() => { output.snapshot() })).toBe(error)
  expect(failure(() => { output.push(Buffer.alloc(0)) })).toBe(error)
  output.seal()
  expect(failure(() => { output.readFrom(0) })).toBe(error)
  output.release()
  expect(output.residentBytes).toBe(0)
  expect(output.failure).toBe(error)
  expect(failure(() => { output.readFrom(0) })).toMatchObject({ reason: 'scope-released', code: 'cloud/stale-generation' })
})

it('does not partially capture a chunk that crosses the observed-byte budget', () => {
  const output = new CollectedOutputMirror({ maxBytes: 4 }, 6)
  output.push(Buffer.from('abcde'))
  expect(failure(() => { output.push(Buffer.from('fg')) })).toMatchObject({ acceptedBytes: 5, rejectedChunkBytes: 2 })
  expect(output.acceptedBytes).toBe(5)
  expect(output.residentBytes).toBe(4)
  output.release()
})

it('treats output after seal as a retained ingestion failure rather than silently publishing success', () => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 16)
  output.push(Buffer.from('done')); output.seal()
  const error = failure(() => { output.push(Buffer.from('late')) })
  expect(error).toMatchObject({ code: 'cloud/execution-unavailable', reason: 'output-after-seal', acceptedBytes: 4, rejectedChunkBytes: 4 })
  expect(output.failure).toBe(error)
  expect(failure(() => { output.snapshot() })).toBe(error)
  output.seal()
  expect(output.residentBytes).toBe(8)
  output.release()
})

it.each(['open', 'sealed'] as const)('only explicit scope release reclaims %s output and permanently refuses later use', (state) => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 16)
  output.push(Buffer.from('data'))
  if (state === 'sealed') output.seal()
  output.release(); output.release()
  expect(output.residentBytes).toBe(0)
  expect(output.acceptedBytes).toBe(4)
  const error = failure(() => { output.readFrom(0) })
  expect(error).toMatchObject({ code: 'cloud/stale-generation', reason: 'scope-released' })
  expect(failure(() => { output.snapshot() })).toBe(error)
  expect(failure(() => { output.push(Buffer.from('later')) })).toBe(error)
  expect(failure(() => { output.seal() })).toBe(error)
})

it('keeps stdout and stderr in separate native readers and never advertises spill', () => {
  const stdout = new CollectedOutputMirror({ maxBytes: 4 }, 16), stderr = new CollectedOutputMirror({ maxBytes: 4 }, 16)
  stdout.push(Buffer.from('stdout')); stderr.push(Buffer.from('stderr'))
  stdout.seal(); stderr.seal()
  expect(stdout.readFrom(0)).toEqual({ text: 'dout', nextOffset: 6, lossy: true })
  expect(stderr.readFrom(0)).toEqual({ text: 'derr', nextOffset: 6, lossy: true })
  expect('spillPath' in stdout.readFrom(0)).toBe(false)
  stdout.release()
  expect(stderr.readFrom(0).text).toBe('derr')
  stderr.release()
  expect(failure(() => { new CollectedOutputMirror({ maxBytes: 4, spill: { maxBytes: 16 } }, 16) }))
    .toMatchObject({ code: 'cloud/execution-unavailable', reason: 'spill-unavailable' })
})

it('uses a fixed tail reservation for an oversized chunk and ignores empty input', () => {
  const output = new CollectedOutputMirror({ maxBytes: 16 }, 131072)
  output.push(Buffer.alloc(0)); output.push(Buffer.alloc(65536, 0x61)); output.push(Buffer.from('end'))
  expect(output.snapshot()).toEqual({ bytes: Buffer.from('a'.repeat(13) + 'end'), totalBytes: 65539 })
  expect(output.residentBytes).toBe(16)
  output.release()
})

it('validates finite byte limits and offsets before allocation or storage mutation', () => {
  for (const maxBytes of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new CollectedOutputMirror({ maxBytes }, 32)).toThrow(RangeError)
  }
  for (const maxObserved of [0, 3, 4.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new CollectedOutputMirror({ maxBytes: 4 }, maxObserved)).toThrow(RangeError)
  }
  const config = { maxBytes: 4 }, output = new CollectedOutputMirror(config, 16)
  config.maxBytes = 1
  output.push(Buffer.from('abcd'))
  for (const offset of [-1, 1.5, 5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => output.readFrom(offset)).toThrow(RangeError)
  }
  expect(output.readFrom(0)).toEqual({ text: 'abcd', nextOffset: 4, lossy: false })
  expect(output.failure).toBeUndefined()
  output.release()
})

it('keeps upstream-evicted byte coordinates when adopting remote full-tail snapshots', () => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 128)
  output.push(Buffer.from('abc'))
  output.replaceTail(Buffer.from('xyz'), 100)
  expect(output.readFrom(0)).toEqual({ text: 'xyz', nextOffset: 100, lossy: true })
  expect(output.readFrom(99)).toEqual({ text: 'z', nextOffset: 100, lossy: false })
  expect(output.snapshot()).toEqual({ bytes: Buffer.from('xyz'), totalBytes: 100 })
  output.push(Buffer.from('!'))
  output.replaceTail(Buffer.from('xyz!q'), 102)
  output.replaceTail(Buffer.from('xyz!q'), 102)
  expect(output.readFrom(100)).toEqual({ text: '!q', nextOffset: 102, lossy: false })
  expect(output.residentBytes).toBe(8)
  output.release()
})

it('copies a remote binary tail without decoding or exposing stale bytes before its retained window', () => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 32)
  output.push(Buffer.from('oldbytes'))
  const tail = Buffer.from([0xff, 0xe4])
  output.replaceTail(tail, 20)
  tail.fill(0)
  expect(output.snapshot()).toEqual({ bytes: Buffer.from([0xff, 0xe4]), totalBytes: 20 })
  expect(output.readFrom(0)).toEqual({ text: '\ufffd\ufffd', nextOffset: 20, lossy: true })
  expect(output.readFrom(19)).toEqual({ text: '\ufffd', nextOffset: 20, lossy: false })
  output.release()
})

it.each(['rewritten-overlap', 'retreated-coordinate'] as const)('retains a failed %s snapshot without changing prior coordinates', (kind) => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 32)
  output.replaceTail(Buffer.from('abc'), 3)
  const error = failure(() => { output.replaceTail(Buffer.from(kind === 'rewritten-overlap' ? 'abX' : 'ab'),
    kind === 'rewritten-overlap' ? 3 : 2) })
  expect(error.reason).toBe('invalid-snapshot')
  expect(output.acceptedBytes).toBe(3)
  expect(output.residentBytes).toBe(8)
  expect(failure(() => { output.readFrom(0) })).toBe(error)
  output.release()
})

it('charges full remote stream coordinates rather than only the received tail against the observed budget', () => {
  const output = new CollectedOutputMirror({ maxBytes: 8 }, 32)
  expect(failure(() => { output.replaceTail(Buffer.from('tail'), 33) })).toMatchObject({
    reason: 'observed-byte-limit', acceptedBytes: 0, rejectedChunkBytes: 4, maxObservedBytes: 32 })
  expect(output.acceptedBytes).toBe(0)
  expect(output.residentBytes).toBe(8)
  output.release()
})
