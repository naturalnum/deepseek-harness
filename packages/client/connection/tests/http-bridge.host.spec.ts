import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { bridge, ResponseCleanupError } from '../src/http-bridge.ts'
import { Peer } from '../src/peer.ts'

const PEER = new Peer(new Context(), { principal: { kind: 'owner' } })

describe('HTTP bridge abort', () => {
  it.each(['success', 'failure'])('flushes refusal and retains the bridge until original request destruction reports %s', async (outcome) => {
    const started = Promise.withResolvers<undefined>()
    const failure = new Error('original intake destruction failed')
    let finish!: () => void
    const request = new Readable({ read() {}, destroy(error, callback) {
      finish = () => { callback(outcome === 'failure' ? failure : error) }
      started.resolve(undefined)
    } }) as IncomingMessage
    Object.assign(request, { url: '/api/session/uploadFileBinary', method: 'POST', headers: {} })
    let headers = 0, settled = false
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
      writeHead() { headers++; return this }, write() { return true },
      end(this: EventEmitter & { writableEnded: boolean }) { this.writableEnded = true; this.emit('finish'); return this } })
    const actual = bridge(request, response, {
      requestBodyMode: () => 'streaming', fetch: async (input) => {
        await input.body?.cancel()
        return new Response(null, { status: 400 })
      },
    }, PEER).then(() => undefined, (error: unknown) => error).finally(() => { settled = true })
    await started.promise
    expect(settled).toBe(false)
    expect(headers).toBe(1)
    finish()
    expect(await actual).toBe(outcome === 'failure' ? failure : undefined)
    expect(request.closed).toBe(true)
    expect(headers).toBe(1)
  })

  it.each(['unread', 'reading'])('joins an %s upload cancelled while Node delivers its final data event', (phase) => {
    const script = `
      import { EventEmitter } from 'node:events';
      import { Readable } from 'node:stream';
      import { bridge } from ${JSON.stringify(new URL('../src/http-bridge.ts', import.meta.url).href)};
      const request = new Readable({ read() {}, destroy(error, callback) {
        queueMicrotask(() => { this.emit('data', Buffer.from('late')); callback(error); });
      }});
      Object.assign(request, { url: '/api/session/uploadFileBinary', method: 'POST', headers: {} });
      let status;
      const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
        writeHead(code) { status = code; }, write() { return true; },
        end() { this.writableEnded = true; this.emit('finish'); } });
      await bridge(request, response, { requestBodyMode: () => 'streaming', fetch: async (input) => {
        const reader = input.body.getReader();
        if (${JSON.stringify(phase)} === 'reading') {
          const first = reader.read(); request.push(Buffer.from('first')); await first;
        }
        await reader.cancel();
        return new Response('refused', { status: 400 });
      }}, {});
      if (status !== 400 || !response.writableEnded || !request.closed) throw new Error('unsettled intake');
    `
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 15_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
  })

  it('holds a refused response until body cancellation settles and retains cleanup failure', async () => {
    const request = Readable.from([]) as IncomingMessage
    Object.assign(request, { url: '/api/workspaceFiles/readBytes', method: 'POST', headers: {} })
    let headers = 0, writes = 0, ended = false, settled = false
    const response = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false,
      writeHead() { headers++; return this },
      write() { writes++; return true },
      end() { ended = true; this.writableEnded = true; return this },
    })
    const cancelled = Promise.withResolvers<undefined>(), cleanup = Promise.withResolvers<undefined>()
    const refusal = new Error('admission closed'), fault = new Error('body cancellation failed')
    const body = new ReadableStream({ cancel() { cancelled.resolve(undefined); return cleanup.promise } })
    const actual = bridge(request, response, {
      requestBodyMode: () => 'buffered', fetch: async () => new Response(body),
    }, PEER, 1024, () => { throw refusal })
    const outcome = actual.then(() => undefined, (error: unknown) => error).finally(() => { settled = true })
    await cancelled.promise
    expect(settled).toBe(false)
    expect({ headers, writes, ended }).toEqual({ headers: 0, writes: 0, ended: false })
    cleanup.reject(fault)
    const error = await outcome
    expect(error).toBeInstanceOf(ResponseCleanupError)
    if (!(error instanceof ResponseCleanupError)) throw new Error('Expected response cleanup error', { cause: error })
    expect(error.errors).toEqual([refusal, fault])
  })

  it('destroys a declared-oversize request instead of draining it', async () => {
    const destroyed: true[] = []
    const request = Readable.from([]) as IncomingMessage
    Object.assign(request, {
      url: '/api/session.prompt',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999999' },
      destroy: () => { destroyed.push(true) },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      requestBodyMode: () => 'buffered',
      fetch: () => { throw new Error('a rejected request must never reach the handler') },
    }, PEER, 1000)
    // The socket must not stay parked draining a body the client can trickle
    // at will after the rejection — same discipline as the chunked overrun.
    expect(status).toBe(413)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(destroyed).toHaveLength(1)
  })

  it('aborts a pending native picker request when the browser disconnects', async () => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'picker-1', method: 'directoryPicker/pick', payload: { args: {} },
    })
    const request = Readable.from([Buffer.from(body)]) as IncomingMessage
    Object.assign(request, {
      url: '/api/directoryPicker/pick',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() { return this },
      write() { return true },
      end() { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    let carrierSignal: AbortSignal | undefined
    const pending = bridge(request, response, {
      requestBodyMode: () => 'buffered',
      fetch: async (input) => {
        const fetchRequest = input
        carrierSignal = fetchRequest.signal
        resolveStarted()
        if (!fetchRequest.signal.aborted) {
          await new Promise<void>((resolve) => {
            fetchRequest.signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        }
        return Response.json({ aborted: fetchRequest.signal.aborted })
      },
    }, PEER, Number.MAX_SAFE_INTEGER)
    await started
    response.emit('close')
    await pending
    expect(carrierSignal?.aborted).toBe(true)
  })

  it.each(['write', 'backpressure'])('finishes a multipart response without further writes when the client closes during %s', async (phase) => {
    const request = Readable.from([]) as IncomingMessage
    Object.assign(request, { url: '/api/workspaceFiles/readBytes', method: 'GET', headers: {} })
    const body = new FormData()
    body.set('metadata', '{}')
    body.set('data', new Blob([new Uint8Array(16 * 1024 * 1024)]))
    let writes = 0
    let cleaningUp = false
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead() { return this },
      write() {
        writes++
        if (writes === 1) {
          const close = (): void => { response.destroyed = true; response.emit('close') }
          if (phase === 'write') close()
          else queueMicrotask(close)
        }
        return cleaningUp
      },
      end() { this.writableEnded = true; return this },
    })
    let settled = false
    const pending = bridge(request, response, {
      requestBodyMode: () => 'buffered',
      fetch: async () => new Response(body),
    }, PEER).then(() => { settled = true })
    try {
      await expect.poll(() => settled).toBe(true)
      expect(writes).toBe(1)
      expect(response.listenerCount('drain')).toBe(0)
    } finally {
      // Release a regressed bridge parked after the one close event.
      cleaningUp = true
      response.emit('drain')
      await pending
    }
  })

  it('discards bytes returned after the client disconnects', async () => {
    const request = Readable.from([]) as IncomingMessage
    Object.assign(request, { url: '/api/workspaceFiles/readBytes', method: 'GET', headers: {} })
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead() { return this },
      write() { throw new Error('a disconnected response must not receive bytes') },
      end() { this.writableEnded = true; return this },
    })
    const started = Promise.withResolvers<undefined>()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
      pull() { started.resolve(undefined) },
    })
    const pending = bridge(request, response, {
      requestBodyMode: () => 'buffered',
      fetch: async () => new Response(body),
    }, PEER)
    await started.promise
    response.emit('close')
    controller.enqueue(Uint8Array.of(1))
    controller.close()
    await pending
  })

  it('streams a declared 2.19 GiB request before the body ends and bypasses the JSON buffer cap', async () => {
    const request = new Readable({ read() {} }) as IncomingMessage
    Object.assign(request, {
      url: '/api/session/uploadFileBinary?sessionId=s1',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(Math.ceil(2.19 * 1024 ** 3)),
      },
    })
    let status: number | undefined
    const responseBytes: Uint8Array[] = []
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number) { status = code; return this },
      write(chunk: Uint8Array) { responseBytes.push(chunk); return true },
      end(this: { writableEnded: boolean }) { this.writableEnded = true; return this },
    }) as unknown as ServerResponse

    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    const received: Uint8Array[] = []
    const pending = bridge(request, response, {
      requestBodyMode: () => 'streaming',
      fetch: async (input) => {
        resolveStarted()
        if (input.body === null) throw new Error('streaming request lost its body')
        for await (const chunk of input.body) received.push(chunk)
        return new Response('stored')
      },
    }, PEER, 1)

    await started
    expect(received).toEqual([])
    request.push(Buffer.from([1, 2]))
    request.push(Buffer.from([3, 4]))
    request.push(null)
    await pending
    expect(status).toBe(200)
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(Buffer.concat(responseBytes).toString()).toBe('stored')
  })

  it('closes an unread streaming request after returning an early validation response', async () => {
    const request = new Readable({ read() {} }) as IncomingMessage
    Object.assign(request, {
      url: '/api/session/uploadFileBinary',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    let status: number | undefined
    let headers: unknown
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead(code: number, values?: unknown) { status = code; headers = values; return this },
      write() { return true },
      end(this: EventEmitter & { writableEnded: boolean }) { this.writableEnded = true; this.emit('finish'); return this },
    }) as unknown as ServerResponse

    await bridge(request, response, {
      requestBodyMode: () => 'streaming',
      fetch: () => Promise.resolve(new Response(null, { status: 415 })),
    }, PEER, 1)
    expect(status).toBe(415)
    expect(headers).toMatchObject({ connection: 'close' })
    expect(request.closed).toBe(true)
  })
})
