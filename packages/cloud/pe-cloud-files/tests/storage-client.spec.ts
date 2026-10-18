import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FdWorkerClient } from '../src/worker-client.ts'

const clients: FdWorkerClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())) })
function client(mode = 'normal', gate = new SharedArrayBuffer(8)) {
  const actual = new FdWorkerClient(new Worker(new URL('./fixtures/storage-worker.mjs', import.meta.url), { workerData: { mode, gate } }))
  clients.push(actual)
  return actual
}
const signal = () => new AbortController().signal

describe('root probe transport on original fixed slots', () => {
  it('receives bounded closed-FD frame, record and process view without opening an account lane', async () => {
    const actual = client()
    await actual.ready
    expect(await actual.storageProbe('/not-accessed', signal())).toMatchObject({ flags: 3 })
    expect(new TextDecoder().decode(await actual.storageRecord(10, signal()))).toBe('{}')
    const view = await actual.storageView(20, signal())
    expect(new TextDecoder().decode(view.status)).toBe('status')
  })
  it.each(['partial', 'unclosed', 'wrong-id', 'crash'])('settles %s transport failure only with actual exit', async (mode) => {
    const actual = client(mode)
    await actual.ready
    await expect(actual.storageProbe('/not-accessed', signal())).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    expect(actual.available).toBe(false)
    await actual.exited
  })
  it('keeps a blocked operation pending after cancellation and refuses reuse until actual reply', async () => {
    const gate = new SharedArrayBuffer(8), state = new Int32Array(gate)
    const actual = client('blocked', gate), controller = new AbortController()
    await actual.ready
    let settled = false
    const result = actual.storageProbe('/not-accessed', controller.signal).finally(() => { settled = true })
    try {
      await vi.waitFor(() => { expect(Atomics.load(state, 0)).toBe(1) })
      controller.abort()
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(() => actual.storageRecord(10, signal())).toThrow(/busy/)
    } finally { Atomics.store(state, 1, 1); Atomics.notify(state, 1) }
    await result
    expect(await actual.storageRecord(10, signal())).toHaveLength(2)
  })
  it('rejects oversized record and proc replies rather than retaining unaccounted payloads', async () => {
    const record = client(), view = client()
    await Promise.all([record.ready, view.ready])
    await expect(record.storageRecord(1, signal())).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await expect(view.storageView(1, signal())).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
  it('refuses a root command from a legacy worker and rejects an incompatible probe version', async () => {
    const legacy = client('legacy'), wrong = client('wrong-version')
    const incompatible = expect(wrong.ready).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await legacy.ready
    expect(() => legacy.storageRecord(10, signal())).toThrow()
    await incompatible
  })
})
