/** Bounded loopback PostgreSQL wire fault fixture; the assigned server/database stays real. */
import { createConnection, createServer, type Socket } from 'node:net'

/** Owns only this fixture's listener and sockets, never the database server. */
export interface PgResponseProxy {
  readonly port: number
  armQueryResponseLoss(): void
  inspect(): { readonly dropped: number; readonly heldStartupReady: number }
  close(): Promise<void>
}

/**
 * Forward real authentication and query packets, optionally withholding a ReadyForQuery.
 * A dropped post-query ReadyForQuery means the server completed its implicit transaction,
 * while pg has not yet settled that query successfully.
 * @param target Assigned runtime database listener; credentials stay in the actual pg client.
 * @param mode Whether to withhold startup completion for a connection-budget test.
 * @returns A finite local fault carrier with explicit socket cleanup.
 */
export async function pgResponseProxy(target: { host: string; port: number }, mode: 'forward' | 'hold-startup-ready'): Promise<PgResponseProxy> {
  const sockets = new Set<Socket>()
  let armed = false
  let dropped = 0
  let heldStartupReady = 0
  const server = createServer((downstream) => {
    const upstream = createConnection(target)
    downstream.setNoDelay(true)
    upstream.setNoDelay(true)
    sockets.add(downstream)
    sockets.add(upstream)
    let pending = Buffer.alloc(0)
    let readies = 0
    const destroy = (): void => { downstream.destroy(); upstream.destroy() }
    for (const socket of [downstream, upstream]) {
      socket.on('error', destroy)
      socket.once('close', () => { sockets.delete(socket); destroy() })
    }
    downstream.pipe(upstream)
    upstream.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      // The fixture carries only small startup/owner rows, never arbitrary SQL output.
      if (pending.length > 65536) { destroy(); return }
      while (pending.length >= 5) {
        const size = pending.readInt32BE(1)
        if (size < 4 || size > 65535) { destroy(); return }
        if (pending.length < size + 1) return
        const frame = pending.subarray(0, size + 1)
        pending = pending.subarray(size + 1)
        if (frame[0] === 90) {
          readies++
          if (readies === 1 && mode === 'hold-startup-ready') { heldStartupReady++; continue }
          if (readies > 1 && armed) {
            armed = false
            dropped++
            destroy()
            return
          }
        }
        downstream.write(frame)
      }
    })
  })
  await new Promise<undefined>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(undefined) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('PostgreSQL fault fixture listener is unavailable')
  return {
    port: address.port,
    armQueryResponseLoss: () => { armed = true },
    inspect: () => ({ dropped, heldStartupReady }),
    close: async () => {
      const closed = new Promise<undefined>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(undefined) })
      })
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}
