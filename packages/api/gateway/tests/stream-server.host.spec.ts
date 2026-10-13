import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, remoteErrorOf, type PeerId, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  RemoteStreamMuxServer,
  type RemoteStreamFailureMapper,
  type RemoteStreamOpener,
} from '../src/stream-server.ts'
import { parseRemoteStreamServerMessage, type RemoteStreamServerMessage } from '../src/stream-protocol.ts'

interface RunningMux {
  readonly http: Server
  readonly mux: RemoteStreamMuxServer
  readonly url: string
}

const running = new Set<RunningMux>()

afterEach(async () => {
  await Promise.all([...running].map(async (entry) => {
    running.delete(entry)
    await entry.mux.close().catch(() => undefined)
    await closeHttp(entry.http)
  }))
})

describe('Remote stream mux server carrier lifecycle', () => {
  it('sends WebSocket Ping control frames without application messages', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal), 20)
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    const messages = vi.fn()
    client.on('message', messages)

    const ping = once(client, 'ping')
    const pong = once(serverSocket, 'pong')
    expect((await ping)[0]).toEqual(Buffer.alloc(0))
    expect((await pong)[0]).toEqual(Buffer.alloc(0))
    expect(messages).not.toHaveBeenCalled()

    const closingPing = vi.spyOn(serverSocket, 'ping')
    client.pause()
    serverSocket.close()
    expect(serverSocket.readyState).toBe(WebSocket.CLOSING)
    await new Promise<void>((resolve) => { setTimeout(resolve, 25) })
    expect(closingPing).not.toHaveBeenCalled()

    const closed = once(client, 'close')
    client.resume()
    await closed
  })

  it('requires two missed heartbeats before terminating an unresponsive socket', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal), 20)
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    serverSocket.removeAllListeners('pong')
    const terminated = vi.spyOn(serverSocket, 'terminate')
    const closed = once(client, 'close')

    await once(client, 'ping')
    await once(client, 'ping')
    expect(terminated).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(terminated).toHaveBeenCalledOnce() })
    await closed
  })

  it('keeps the socket when a delayed Pong arrives before the final check', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal), 20)
    const client = await connect(entry.url, false)
    const serverSocket = acceptedSocket(entry.mux)
    const terminated = vi.spyOn(serverSocket, 'terminate')
    let finalCheck: (() => void) | undefined
    const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation((callback) => {
      finalCheck = callback
      return 0 as unknown as NodeJS.Immediate
    })

    try {
      await once(client, 'ping')
      await once(client, 'ping')
      await vi.waitFor(() => { expect(finalCheck).toBeDefined() })
      serverSocket.emit('pong', Buffer.alloc(0))
      finalCheck?.()
      expect(terminated).not.toHaveBeenCalled()
    } finally {
      immediate.mockRestore()
      const closed = once(client, 'close')
      client.close()
      await closed
    }
  })

  it('rejects binary, malformed, and duplicate logical-stream messages', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal))

    const binary = await connect(entry.url)
    const binaryClosed = once(binary, 'close')
    binary.send(Buffer.from('{}'))
    const binaryEvent = await binaryClosed
    expect(binaryEvent[0]).toBe(1003)

    const malformed = await connect(entry.url)
    const malformedClosed = once(malformed, 'close')
    malformed.send('not json')
    const malformedEvent = await malformedClosed
    expect(malformedEvent[0]).toBe(1008)
    expect(String(malformedEvent[1])).toBe('invalid Remote stream request')

    const duplicate = await connect(entry.url)
    const longId = 'same'.repeat(100)
    duplicate.send(openFrame(longId))
    duplicate.send(openFrame(longId))
    const duplicateEvent = await once(duplicate, 'close')
    expect(duplicateEvent[0]).toBe(1008)
    expect(String(duplicateEvent[1])).toBe('invalid Remote stream request')

    const unknownType = await connect(entry.url)
    unknownType.send(openFrame('unknown-type'))
    unknownType.send(JSON.stringify({ type: 'input', streamId: 'unknown-type', value: 'unexpected' }))
    const unknownTypeEvent = await once(unknownType, 'close')
    expect(unknownTypeEvent[0]).toBe(1008)
    expect(String(unknownTypeEvent[1])).toBe('invalid Remote stream request')
  })

  it('accepts all ws text representations and terminates a carrier error', async () => {
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => waitForAbort(control.signal))
    const client = await connect(entry.url)
    const serverSocket = acceptedSocket(entry.mux)
    const cancel = JSON.stringify({ type: 'cancel', streamId: 'absent' })

    serverSocket.emit('message', [Buffer.from(cancel)], false)
    serverSocket.emit('message', Uint8Array.from(Buffer.from(cancel)).buffer, false)

    const closed = once(client, 'close')
    serverSocket.emit('error', new Error('fixture carrier failure'))
    await closed
  })

  it('does not send an end frame after clean source cancellation', async () => {
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => {
      opened()
      return cleanlyCancelled(control.signal, returned)
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('cancelled'))
    await didOpen
    client.send(JSON.stringify({ type: 'cancel', streamId: 'cancelled' }))
    await didReturn
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(frames).toEqual([])
    client.close()
    await once(client, 'close')
  })

  it('closes the carrier when ws reports an item write failure', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    const entry = await startMux(async () => delayedItem(released, opened))
    const client = await connect(entry.url)
    client.send(openFrame('write-failure'))
    await didOpen
    failWrites(acceptedSocket(entry.mux))

    const closed = once(client, 'close')
    release()
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
  })

  it('closes the carrier when the end frame cannot be written', async () => {
    const entry = await startMux(async () => (async function *(): AsyncIterable<never> {})())
    const client = await connect(entry.url)
    failWrites(acceptedSocket(entry.mux))

    const closed = once(client, 'close')
    client.send(openFrame('empty'))
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
  })

  it('leaves a failed stream silent once its socket is no longer open', async () => {
    const opened = Promise.withResolvers<undefined>()
    const entry = await startMux(async () => {
      opened.resolve(undefined)
      throw new Error('fixture opener failure')
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const serverSocket = acceptedSocket(entry.mux)
    Object.defineProperty(serverSocket, 'readyState', { configurable: true, value: WebSocket.CLOSING })
    try {
      client.send(openFrame('silent'))
      await opened.promise
      // The failure path awaits nothing before it inspects the socket, so one
      // macrotask hop drains every microtask it can schedule.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(frames).toEqual([])
    } finally {
      Reflect.deleteProperty(serverSocket, 'readyState')
    }
    expect(serverSocket.readyState).toBe(WebSocket.OPEN)
    client.close()
    await once(client, 'close')
  })

  it('contains an item produced after its socket closes', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async () => delayedItem(released, opened, returned))
    const client = await connect(entry.url)
    client.send(openFrame('late-item'))
    await didOpen
    const serverSocket = acceptedSocket(entry.mux)
    client.close()
    await once(client, 'close')
    await vi.waitFor(() => { expect(serverSocket.readyState).toBe(WebSocket.CLOSED) })
    release()
    await didReturn
  })

  it('terminates active sockets on close and reports a repeated close', async () => {
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => { opened = resolve })
    let returned!: () => void
    const didReturn = new Promise<void>((resolve) => { returned = resolve })
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => {
      opened()
      return cleanlyCancelled(control.signal, returned)
    })
    const client = await connect(entry.url)
    client.send(openFrame('active'))
    await didOpen

    const closed = once(client, 'close')
    await entry.mux.close()
    running.delete(entry)
    await closed
    await didReturn
    await expect(entry.mux.close()).rejects.toThrow()
    await closeHttp(entry.http)
  })
})

describe('Remote stream mux server downlink settlement', () => {
  it.each(['client cancel', 'source cancel', 'send timeout', 'socket close', 'mux close'] as const)(
    'releases a started write and waits for source cleanup after %s', async (mode) => {
      const cleaning = Promise.withResolvers<undefined>()
      const releaseCleanup = Promise.withResolvers<undefined>()
      let active = 0
      let control: AbortController | undefined
      const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, openedControl) => {
        control = openedControl
        return (async function* () {
          active++
          try { yield 'opening' }
          finally { cleaning.resolve(undefined); await releaseCleanup.promise; active-- }
        })()
      }, 2_000, 262_144, undefined, mode === 'send timeout' ? 100 : 10_000)
      const client = await connect(entry.url)
      const socket = acceptedSocket(entry.mux)
      const frames = collectFrames(client)
      const writes = holdWriteCallbacks(socket, frame => frame.type === 'item')
      client.send(openFrame('blocked'))
      await vi.waitFor(() => { expect(writes.held).toHaveLength(1) })
      const closed = once(client, 'close')
      let closing: Promise<void> | undefined
      if (mode === 'client cancel') client.send(JSON.stringify({ type: 'cancel', streamId: 'blocked' }))
      if (mode === 'source cancel') control!.abort(new Error('fixture generation expired'))
      if (mode === 'socket close') socket.terminate()
      if (mode === 'mux close') closing = entry.mux.close()
      await closed
      await cleaning.promise
      closing ??= entry.mux.close()
      let quiescent = false
      void closing.then(() => { quiescent = true })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(quiescent).toBe(false)
      expect(active).toBe(1)
      expect(socket.readyState).toBe(WebSocket.CLOSED)
      writes.held[0]!()
      writes.held[0]!()
      releaseCleanup.resolve(undefined)
      await closing
      running.delete(entry)
      expect(active).toBe(0)
      expect(frames).toEqual([{ type: 'item', streamId: 'blocked', value: 'opening' }])
      expect(writes.sent).toHaveLength(1)
    },
  )

  it.each(['item', 'end', 'error', 'Remote failure'] as const)(
    'withdraws a queued %s without overtaking a stalled write or closing the carrier', async (kind) => {
      const returned = Promise.withResolvers<undefined>()
      const opened = Promise.withResolvers<AbortController>()
      const entry = await startMux(async (endpoint, _payload, _uplink, _peer, control) => {
        return (async function* () {
          if (endpoint === 'fixture/queued') opened.resolve(control)
          try {
            if (endpoint === 'fixture/queued' && kind === 'error') throw new Error('fixture rejection')
            if (endpoint !== 'fixture/queued' || kind !== 'end') yield endpoint
          } finally {
            if (endpoint === 'fixture/queued') returned.resolve(undefined)
          }
        })()
      })
      const client = await connect(entry.url)
      const socket = acceptedSocket(entry.mux)
      const frames = collectFrames(client)
      const writes = holdWriteCallbacks(socket, frame => frame.streamId === 'first' && frame.type === 'item')
      client.send(openFrame('first', 'fixture/first'))
      await vi.waitFor(() => { expect(writes.held).toHaveLength(1) })
      client.send(openFrame('queued', 'fixture/queued'))
      const control = await opened.promise
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      if (kind === 'Remote failure') {
        control.abort(new RemoteError('gateway/protocol', 'fixture rejection', { endpoint: 'fixture/queued' }))
        await returned.promise
      }
      client.send(JSON.stringify({ type: 'cancel', streamId: 'queued' }))
      await returned.promise
      client.send(openFrame('successor', 'fixture/successor'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(writes.sent).toEqual([{ type: 'item', streamId: 'first', value: 'fixture/first' }])
      expect(socket.readyState).toBe(WebSocket.OPEN)
      writes.held[0]!()
      await vi.waitFor(() => {
        expect(frames).toEqual(expect.arrayContaining([
          { type: 'item', streamId: 'successor', value: 'fixture/successor' },
          { type: 'end', streamId: 'successor' },
        ]))
      })
      expect(frames.every(frame => frame.streamId !== 'queued')).toBe(true)
      expect(socket.readyState).toBe(WebSocket.OPEN)
      client.close()
      await once(client, 'close')
    },
  )

  it('includes queue time in the deadline when the frame starts writing later', async () => {
    const queued = Promise.withResolvers<undefined>()
    let returns = 0
    const entry = await startMux(async endpoint => (async function* () {
      try { if (endpoint === 'fixture/queued') queued.resolve(undefined); yield endpoint }
      finally { returns++ }
    })(), 2_000, 262_144, undefined, 100)
    const client = await connect(entry.url)
    const socket = acceptedSocket(entry.mux)
    const writes = holdWriteCallbacks(socket, frame => frame.type === 'item')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      client.send(openFrame('first', 'fixture/first'))
      await new Promise<void>((resolve) => {
        socket.once('message', () => { setImmediate(resolve) })
      })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(writes.held).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(20)
      client.send(openFrame('queued', 'fixture/queued'))
      await queued.promise
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await vi.advanceTimersByTimeAsync(60)
      writes.held[0]!()
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(writes.held).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(39)
      expect(socket.readyState).toBe(WebSocket.OPEN)
      const closed = once(client, 'close')
      await vi.advanceTimersByTimeAsync(1)
      await closed
      await entry.mux.close()
      running.delete(entry)
      expect(returns).toBe(2)
      writes.held[1]!()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns an unencodable item source and serves another stream on the same socket', async () => {
    const cycle: { self?: object } = {}
    cycle.self = cycle
    let returns = 0
    const entry = await startMux(async endpoint => (async function* () {
      try { yield endpoint === 'fixture/cycle' ? cycle : 'served' }
      finally { returns++ }
    })())
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('cycle', 'fixture/cycle'))
    await vi.waitFor(() => {
      expect(frames).toEqual([{ type: 'error', streamId: 'cycle', error: {
        code: 'internal', message: 'api gateway: Remote stream item is not JSON serializable', details: {},
      } }])
    })
    client.send(openFrame('healthy'))
    await vi.waitFor(() => { expect(frames).toHaveLength(3) })
    expect(frames.slice(1)).toEqual([
      { type: 'item', streamId: 'healthy', value: 'served' }, { type: 'end', streamId: 'healthy' },
    ])
    expect(returns).toBe(2)
    client.close()
    await once(client, 'close')
  })

  it('contains a synchronous send exception and completes the source before another stream', async () => {
    let returns = 0
    const entry = await startMux(async () => (async function* () {
      try { yield 'served' }
      finally { returns++ }
    })())
    const client = await connect(entry.url)
    const socket = acceptedSocket(entry.mux)
    const frames = collectFrames(client)
    vi.spyOn(socket, 'send').mockImplementationOnce(() => { throw new Error('fixture synchronous write failure') })
    client.send(openFrame('throw'))
    await vi.waitFor(() => {
      expect(frames).toEqual([{ type: 'error', streamId: 'throw', error: {
        code: 'internal', message: 'fixture synchronous write failure', details: {},
      } }])
    })
    client.send(openFrame('healthy'))
    await vi.waitFor(() => { expect(frames).toHaveLength(3) })
    expect(returns).toBe(2)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    client.close()
    await once(client, 'close')
  })

  it('closes the carrier when a terminal failure cannot be encoded', async () => {
    const cycle: { self?: object } = {}
    cycle.self = cycle
    const entry = await startMux(async () => { throw new Error('fixture opener failure') },
      2_000, 262_144, undefined, 10_000, () => ({ code: 'fixture', message: 'rejected', details: cycle }))
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const closed = once(client, 'close')
    client.send(openFrame('unencodable-error'))
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
    expect(frames).toEqual([])
  })
})

describe('Remote stream mux server Peer binding', () => {
  it('closes an upgrade at once when the admitted Peer scope is already disposed', async () => {
    const peer = await fixturePeer()
    await peer.dispose()
    const opened = vi.fn()
    const entry = await startMux(async (_endpoint, _payload, _uplink, _peer, control) => {
      opened()
      return waitForAbort(control.signal)
    }, 2_000, 262_144, peer)
    const client = new WebSocket(entry.url)
    const closeEvent = await once(client, 'close')
    expect(closeEvent[0]).toBe(1001)
    expect(String(closeEvent[1])).toBe('peer left')
    expect(opened).not.toHaveBeenCalled()
  })

  it('hands the admitted Peer to every opener and closes the socket when its scope is disposed', async () => {
    const peer = await fixturePeer()
    const seen: PeerScope[] = []
    const entry = await startMux(async (_endpoint, _payload, _uplink, opened, control) => {
      seen.push(opened)
      return waitForAbort(control.signal)
    }, 2_000, 262_144, peer)
    const client = await connect(entry.url)
    client.send(openFrame('bound'))
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect(seen[0]).toBe(peer)

    const closed = once(client, 'close')
    await peer.dispose()
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1001)
    expect(String(closeEvent[1])).toBe('peer left')
  })
})

describe('Remote stream mux server uplink', () => {
  it('buffers uplink items sent before the opener resolves and half-closes on end', async () => {
    const release = Promise.withResolvers<undefined>()
    const entry = await startMux(async (_endpoint, _payload, uplink) => {
      await release.promise
      return echoUplink(uplink)
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(openFrame('echo'))
    client.send(itemFrame('echo', 'one'))
    client.send(itemFrame('echo'))
    await vi.waitFor(() => { expect(received.count).toBe(3) })
    expect(frames).toEqual([])

    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'echo', value: 'one' },
        { type: 'item', streamId: 'echo' },
      ])
    })
    client.send(endFrame('echo'))
    await vi.waitFor(() => { expect(frames.at(-1)).toEqual({ type: 'end', streamId: 'echo' }) })
    expect(frames).toHaveLength(3)
    client.close()
    await once(client, 'close')
  })

  it('fails a stream on an item after end and keeps the socket open', async () => {
    const entry = await startMux(async (endpoint, _payload, uplink, _peer, control) =>
      endpoint === 'fixture/echo' ? echoUplink(uplink) : waitForAbort(control.signal))
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('held'))
    client.send(endFrame('held'))
    client.send(endFrame('held'))
    client.send(itemFrame('held', 'late'))
    await vi.waitFor(() => {
      expect(frames).toEqual([{
        type: 'error',
        streamId: 'held',
        error: {
          code: 'gateway/protocol',
          message: 'api gateway: Remote stream uplink item after end',
          details: { endpoint: 'fixture/follow' },
        },
      }])
    })

    expect(client.readyState).toBe(WebSocket.OPEN)
    client.send(openFrame('again', 'fixture/echo'))
    client.send(itemFrame('again', 'still served'))
    await vi.waitFor(() => {
      expect(frames.at(-1)).toEqual({ type: 'item', streamId: 'again', value: 'still served' })
    })
    client.close()
    await once(client, 'close')
  })

  it('fails a stream whose buffered uplink exceeds the configured bytes and drops later items', async () => {
    const release = Promise.withResolvers<undefined>()
    const entry = await startMux(async () => (async function *(): AsyncIterable<never> {
      await release.promise
    })(), 2_000, 48)
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(openFrame('big'))
    client.send(itemFrame('big', 'x'.repeat(64)))
    client.send(itemFrame('big', 'dropped'))
    client.send(endFrame('big'))
    await vi.waitFor(() => { expect(received.count).toBe(4) })
    expect(frames).toEqual([])

    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(frames).toEqual([{
        type: 'error',
        streamId: 'big',
        error: {
          code: 'gateway/uplink-overflow',
          message: 'api gateway: Remote stream uplink exceeded 48 buffered bytes',
          details: { endpoint: 'fixture/follow' },
        },
      }])
    })
    client.close()
    await once(client, 'close')
  })

  it('drops uplink frames for a stream it no longer owns and keeps the socket open', async () => {
    const entry = await startMux(async (endpoint, _payload, uplink, _peer, control) =>
      endpoint === 'fixture/echo' ? echoUplink(uplink) : waitForAbort(control.signal))
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(itemFrame('absent', 1))
    client.send(endFrame('absent'))
    client.send(openFrame('live', 'fixture/echo'))
    client.send(itemFrame('live', 'served'))
    await vi.waitFor(() => { expect(received.count).toBe(4) })
    await vi.waitFor(() => { expect(frames).toEqual([{ type: 'item', streamId: 'live', value: 'served' }]) })
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.close()
    await once(client, 'close')
  })

  it('ends a pending uplink read when the socket closes', async () => {
    const read = Promise.withResolvers<unknown>()
    const opened = Promise.withResolvers<undefined>()
    const entry = await startMux(async (_endpoint, _payload, uplink, _peer, control) => {
      uplink[Symbol.asyncIterator]().next().then(read.resolve, read.resolve)
      opened.resolve(undefined)
      return waitForAbort(control.signal)
    })
    const client = await connect(entry.url)
    client.send(openFrame('pending'))
    await opened.promise
    client.close()
    await once(client, 'close')
    await expect(read.promise).resolves.toMatchObject({ message: 'Remote stream socket closed' })
  })

  it('drops uplink items after the Host stops reading', async () => {
    const release = Promise.withResolvers<undefined>()
    const returned = Promise.withResolvers<undefined>()
    const entry = await startMux(async (_endpoint, _payload, uplink) => {
      const iterator = uplink[Symbol.asyncIterator]()
      const first: IteratorResult<unknown, undefined> = await iterator.next()
      await iterator.return?.()
      returned.resolve(undefined)
      return (async function *(): AsyncIterable<unknown> {
        await release.promise
        yield { first: first.value, afterReturn: (await iterator.next()).done }
      })()
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    const received = countMessages(acceptedSocket(entry.mux))
    client.send(openFrame('closed'))
    client.send(itemFrame('closed', 'one'))
    await returned.promise
    client.send(itemFrame('closed', 'two'))
    client.send(endFrame('closed'))
    client.send(itemFrame('closed', 'three'))
    await vi.waitFor(() => { expect(received.count).toBe(5) })

    release.resolve(undefined)
    await vi.waitFor(() => {
      expect(frames).toEqual([
        { type: 'item', streamId: 'closed', value: { first: 'one', afterReturn: true } },
        { type: 'end', streamId: 'closed' },
      ])
    })
    client.close()
    await once(client, 'close')
  })

  it('reports a second uplink consumer and a second pending read as stream failures', async () => {
    const entry = await startMux(async (endpoint, _payload, uplink) => {
      const iterator = uplink[Symbol.asyncIterator]()
      if (endpoint === 'fixture/twice') uplink[Symbol.asyncIterator]()
      void iterator.next().catch(() => undefined)
      await iterator.next()
      return echoUplink(uplink)
    })
    const client = await connect(entry.url)
    const frames = collectFrames(client)
    client.send(openFrame('twice', 'fixture/twice'))
    client.send(openFrame('pending', 'fixture/pending'))
    await vi.waitFor(() => {
      expect(frames).toEqual(expect.arrayContaining([
        {
          type: 'error',
          streamId: 'twice',
          error: { code: 'internal', message: 'api gateway: Remote stream uplink inbox already has a consumer', details: {} },
        },
        {
          type: 'error',
          streamId: 'pending',
          error: { code: 'internal', message: 'api gateway: Remote stream uplink inbox has one pending read', details: {} },
        },
      ]))
    })
    expect(frames).toHaveLength(2)
    client.close()
    await once(client, 'close')
  })
})

const mapFailure: RemoteStreamFailureMapper = (error) => {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { code: remote.code, message: remote.message, details: remote.details }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

async function startMux(
  open: RemoteStreamOpener,
  heartbeatIntervalMs = 2_000,
  streamInboxBytes = 262_144,
  peer?: PeerScope,
  streamSendTimeoutMs = 10_000,
  failure: RemoteStreamFailureMapper = mapFailure,
): Promise<RunningMux> {
  const admitted = peer ?? await fixturePeer()
  const mux = new RemoteStreamMuxServer(open, failure, heartbeatIntervalMs, streamInboxBytes, streamSendTimeoutMs)
  const http = createServer()
  http.on('upgrade', (request, socket, head) => { mux.handleUpgrade(request, socket, head, admitted) })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject)
      resolve()
    })
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('fixture HTTP server has no TCP port')
  const entry = { http, mux, url: `ws://127.0.0.1:${String(address.port)}` }
  running.add(entry)
  return entry
}

/** A Peer whose scope is a plain Cordis fiber, so `peer.ctx.effect` and `dispose()` behave as the registry's do. */
async function fixturePeer(): Promise<PeerScope> {
  const root = new Context()
  const fiber = root.plugin(() => {})
  await fiber
  return {
    id: 'fixture-peer' as PeerId,
    ctx: fiber.ctx,
    dispose: async () => { await fiber.dispose() },
  }
}

async function connect(url: string, autoPong = true): Promise<WebSocket> {
  const socket = new WebSocket(url, { autoPong })
  await once(socket, 'open')
  return socket
}

function acceptedSocket(mux: RemoteStreamMuxServer): WebSocket {
  const exposed = mux as unknown as { server: { clients: Set<WebSocket> } }
  const socket = [...exposed.server.clients][0]
  if (socket === undefined) throw new Error('fixture mux has no accepted socket')
  return socket
}

function collectFrames(client: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  client.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new TypeError('fixture expected a Buffer frame')
    frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>)
  })
  return frames
}

/** Count the text frames the mux has already dispatched, so a test can wait for the Host to hold them. */
function countMessages(serverSocket: WebSocket): { count: number } {
  const received = { count: 0 }
  serverSocket.on('message', () => { received.count += 1 })
  return received
}

function failWrites(serverSocket: WebSocket): void {
  const mutable = serverSocket as {
    send(data: unknown, callback: (error?: Error) => void): void
  }
  mutable.send = (_data, callback): void => {
    callback(new Error('fixture ws write failure'))
  }
}

/** Real ws writes reach the Client; this fault injection withholds only their completion callbacks. */
function holdWriteCallbacks(socket: WebSocket, hold: (frame: RemoteStreamServerMessage) => boolean) {
  const original = socket.send.bind(socket)
  const sent: RemoteStreamServerMessage[] = []
  const held: (() => void)[] = []
  const mutable = socket as { send(data: unknown, callback: (error?: Error) => void): void }
  mutable.send = (data, callback): void => {
    if (typeof data !== 'string') throw new TypeError('fixture expected a text frame')
    const frame = parseRemoteStreamServerMessage(data)
    sent.push(frame)
    original(data, (error) => {
      if (hold(frame)) held.push(() => { callback(error) })
      else callback(error)
    })
  }
  return { sent, held }
}

function openFrame(streamId: string, endpoint = 'fixture/follow'): string {
  return JSON.stringify({ type: 'open', streamId, endpoint, payload: {} })
}

function itemFrame(streamId: string, value?: unknown): string {
  return JSON.stringify(value === undefined ? { type: 'item', streamId } : { type: 'item', streamId, value })
}

function endFrame(streamId: string): string {
  return JSON.stringify({ type: 'end', streamId })
}

async function *echoUplink(uplink: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const value of uplink) yield value
}

async function *waitForAbort(signal: AbortSignal): AsyncIterable<never> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function *cleanlyCancelled(signal: AbortSignal, returned: () => void): AsyncIterable<never> {
  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  } finally {
    returned()
  }
}

async function *delayedItem(
  released: Promise<void>,
  opened: () => void,
  returned: () => void = () => {},
): AsyncIterable<string> {
  try {
    opened()
    await released
    yield 'item'
  } finally {
    returned()
  }
}

async function closeHttp(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}
