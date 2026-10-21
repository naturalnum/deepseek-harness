/** Actual owned Node HTTP carriers exercise only transfer observation, without login, AccountUse, ready or ingress business setup. */
import { afterEach, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { writeFileSync } from 'node:fs'
import { observeIngressTransfer, type IngressTransferOperation } from '../src/ingress-transfer.ts'

const cleanups: (() => Promise<void>)[] = []
const results: { name: string; events: string[]; resolutions: object[]; helperListenersRemoved: boolean; cleanup: object }[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

async function fixture(name: string, mode: 'response' | 'socket' = 'response') {
  const events: string[] = [], resolutions: object[] = [], observer = new AbortController()
  const ownListeners: { target: EventEmitter; event: string; listener: () => void }[] = []
  const added: { target: EventEmitter; event: string; listeners: readonly unknown[] }[] = []
  const serverSockets = new Set<Socket>(), clientSockets = new Set<Socket>(), terminals = new Set<Promise<undefined>>()
  const releaseGates = new Set<() => void>(), actualTasks = new Set<Promise<void>>()
  const on = (target: EventEmitter, event: string, listener: () => void): void => {
    target.on(event, listener); ownListeners.push({ target, event, listener })
  }
  const helperListenersRemoved = (): boolean => added.every(entry =>
    entry.target.listeners(entry.event).every(listener => !entry.listeners.includes(listener)))
  let resolves = 0, attached = false, aborts = 0, socketCloseObserved = false, responseCloseObserved = false, finishObserved = false
  const aborted = (): void => { aborts++; events.push('observer:abort') }
  observer.signal.addEventListener('abort', aborted)
  const serverResponse = Promise.withResolvers<ServerResponse>()
  const serverRequest = (_req: IncomingMessage, response: ServerResponse): void => { serverResponse.resolve(response) }
  const server = createServer(serverRequest)
  server.maxConnections = 1
  const connection = (socket: Socket): void => {
    serverSockets.add(socket); const terminal = Promise.withResolvers<undefined>(); terminals.add(terminal.promise)
    on(socket, 'error', () => { events.push('server:socket:error') })
    on(socket, 'close', () => {
      serverSockets.delete(socket); terminals.delete(terminal.promise); terminal.resolve(undefined); events.push('server:socket:close')
    })
  }
  server.on('connection', connection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an owned loopback listener')
  let stopClient: () => void = () => {}, clearClientListeners: () => void = () => {}, responseReady = false
  cleanups.push(async () => {
    for (const release of releaseGates) release()
    observer.abort(); stopClient()
    for (const socket of clientSockets) socket.destroy()
    for (const socket of serverSockets) socket.destroy()
    await Promise.allSettled(actualTasks)
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    await Promise.all(terminals)
    expect(server.listening).toBe(false); expect(serverSockets.size).toBe(0); expect(clientSockets.size).toBe(0)
    if (attached && responseReady) expect(helperListenersRemoved()).toBe(true)
    clearClientListeners()
    for (const entry of ownListeners) entry.target.off(entry.event, entry.listener)
    for (const entry of ownListeners) expect(entry.target.listeners(entry.event).includes(entry.listener)).toBe(false)
    server.off('connection', connection); server.off('request', serverRequest)
    expect(server.listeners('connection').includes(connection)).toBe(false)
    expect(server.listeners('request').includes(serverRequest)).toBe(false)
    observer.signal.removeEventListener('abort', aborted)
    results.push({ name, events, resolutions, helperListenersRemoved: helperListenersRemoved(),
      cleanup: { serverListening: server.listening, serverSockets: serverSockets.size, clientSockets: clientSockets.size,
        pendingSocketCloses: terminals.size, ownedListenersRemoved: true, observerAborted: observer.signal.aborted } })
    if (process.env.WORKER6_TRANSFER_EVIDENCE !== undefined) {
      writeFileSync(process.env.WORKER6_TRANSFER_EVIDENCE, JSON.stringify(results, null, 2) + '\n')
    }
  })
  const headers = Promise.withResolvers<IncomingMessage>(), clientClosed = Promise.withResolvers<undefined>()
  const client = httpRequest({ host: '127.0.0.1', port: address.port, path: '/', method: 'GET', agent: false,
    headers: { connection: 'close' } })
  stopClient = () => { client.destroy() }
  on(client, 'error', () => { events.push('client:request:error') })
  on(client, 'close', () => { events.push('client:request:close'); clientClosed.resolve(undefined) })
  const clientSocket = (socket: Socket): void => {
    clientSockets.add(socket); const terminal = Promise.withResolvers<undefined>(); terminals.add(terminal.promise)
    on(socket, 'close', () => { clientSockets.delete(socket); terminals.delete(terminal.promise); terminal.resolve(undefined) })
  }
  client.once('socket', clientSocket)
  const incoming = (message: IncomingMessage): void => {
    on(message, 'error', () => { events.push('client:response:error') })
    on(message, 'close', () => { events.push('client:response:close') })
    message.resume(); headers.resolve(message)
  }
  client.once('response', incoming)
  const timeout = (): void => { client.destroy(new Error('owned fixture deadline')) }
  client.setTimeout(1500, timeout)
  clearClientListeners = () => {
    client.off('socket', clientSocket); client.off('response', incoming); client.off('timeout', timeout)
    expect(client.listeners('socket').includes(clientSocket)).toBe(false)
    expect(client.listeners('response').includes(incoming)).toBe(false)
    expect(client.listeners('timeout').includes(timeout)).toBe(false)
  }
  client.end()
  const response = await serverResponse.promise
  responseReady = true
  const socket = response.socket
  if (socket === null) throw new Error('Expected original response carrier socket')
  const finished = Promise.withResolvers<undefined>(), responseClosed = Promise.withResolvers<undefined>()
  const socketClosed = Promise.withResolvers<undefined>(), transferred = Promise.withResolvers<undefined>()
  on(response, 'finish', () => { finishObserved = true; events.push('response:finish'); finished.resolve(undefined) })
  on(response, 'close', () => { responseCloseObserved = true; events.push('response:close'); responseClosed.resolve(undefined) })
  on(response, 'error', () => { events.push('response:error') })
  on(socket, 'close', () => { socketCloseObserved = true; socketClosed.resolve(undefined) })
  const operation: IngressTransferOperation = { response: mode === 'response' ? response : undefined,
    socket: mode === 'socket' ? socket : undefined, observer, holdNormalFinish: false }
  const observe = (): void => {
    if (attached) throw new Error('One original transfer observation per fixture')
    attached = true
    const targets = mode === 'response' ? ['finish', 'close', 'error'].map(event => ({ target: response, event }))
      : [{ target: socket, event: 'close' }]
    const before = targets.map(entry => entry.target.listeners(entry.event))
    observeIngressTransfer(operation, () => {
      resolves++; events.push('transfer:resolve')
      const normal = response.writableFinished
      resolutions.push({ normal, responseClosed: response.closed, socketClosed: socket.closed, aborted: observer.signal.aborted,
        socketCloseObserved, responseCloseObserved, finishObserved,
        actualEventObserved: finishObserved || responseCloseObserved || socketCloseObserved })
      transferred.resolve(undefined)
    })
    for (const [index, entry] of targets.entries()) {
      added.push({ ...entry, listeners: entry.target.listeners(entry.event).filter(listener => !before[index]!.includes(listener)) })
    }
    expect(added.reduce((sum, entry) => sum + entry.listeners.length, 0)).toBe(resolves > 0 ? 0 : mode === 'response' ? 3 : 1)
  }
  const waitClosed = async (): Promise<void> => {
    await Promise.all([responseClosed.promise, socketClosed.promise, clientClosed.promise])
    expect(serverSockets.size).toBe(0); expect(resolves).toBe(1); expect(helperListenersRemoved()).toBe(true)
  }
  const gate = () => {
    const value = Promise.withResolvers<undefined>(); releaseGates.add(() => { value.resolve(undefined) }); return value
  }
  const finishOriginalConsumer = (actualConsumer: Promise<void>): Promise<void> => {
    // Only the existing run-finally ordering is modelled here; no ingress login/business objects are fabricated.
    const actual = (async () => {
      try { await actualConsumer }
      finally { await transferred.promise; events.push('original:finally'); observer.abort() }
    })()
    actualTasks.add(actual); return actual
  }
  return { response, socket, operation, observer, client, headers: headers.promise, finished: finished.promise,
    transferred: transferred.promise, observe, waitClosed, gate, finishOriginalConsumer,
    state: () => ({ resolves, aborts, socketCloseObserved, responseCloseObserved, finishObserved,
      helperListenersRemoved: helperListenersRemoved() }) }
}

it('ordinary management finish aborts the same observer once and removes every helper listener', async () => {
  const f = await fixture('management-finish'); f.observe(); f.response.end('ok')
  await f.transferred; await f.finished
  expect(f.response.writableFinished).toBe(true); expect(f.observer.signal.aborted).toBe(true)
  expect(f.state()).toMatchObject({ resolves: 1, aborts: 1, helperListenersRemoved: true })
  await f.waitClosed()
})

it('only preview hold set before end preserves the original consumer until original finally aborts', async () => {
  const f = await fixture('preview-hold'); f.observe()
  const consumer = f.gate(), actual = f.finishOriginalConsumer(consumer.promise)
  f.operation.holdNormalFinish = true; f.response.end('preview')
  await f.transferred; await f.finished
  expect(f.response.writableFinished).toBe(true); expect(f.observer.signal.aborted).toBe(false)
  expect(f.state()).toMatchObject({ resolves: 1, aborts: 0, helperListenersRemoved: true })
  await f.waitClosed(); expect(f.observer.signal.aborted).toBe(false)
  consumer.resolve(undefined); await actual
  expect(f.state().aborts).toBe(1)
})

it('early client disconnect cancels a held preview only when actual carrier close arrives', async () => {
  const f = await fixture('client-disconnect'); f.operation.holdNormalFinish = true; f.observe()
  f.response.writeHead(200); f.response.flushHeaders(); await f.headers
  expect(f.response.writableFinished).toBe(false); f.client.destroy()
  expect(f.state().resolves).toBe(0)
  await f.transferred
  expect(f.observer.signal.aborted).toBe(true); expect(f.response.closed || f.socket.closed).toBe(true)
  await f.waitClosed()
})

it('response error aborts immediately but destroy is not a close receipt', async () => {
  const f = await fixture('response-error'); f.operation.holdNormalFinish = true; f.observe()
  // Inject only error on the actual ServerResponse; destroy and both peer close events remain real Node I/O.
  f.response.emit('error', new Error('owned response error injection'))
  expect(f.observer.signal.aborted).toBe(true); expect(f.response.destroyed).toBe(true)
  expect(f.response.closed).toBe(false); expect(f.state().resolves).toBe(0)
  await f.transferred; await f.waitClosed()
  expect(f.state().aborts).toBe(1)
})

it('already destroyed response cancels immediately and waits for its actual close before transfer resolution', async () => {
  const f = await fixture('predestroyed-response'); f.response.destroy()
  expect(f.response.closed).toBe(false); f.operation.holdNormalFinish = true; f.observe()
  expect(f.observer.signal.aborted).toBe(true); expect(f.state().resolves).toBe(0)
  await f.transferred; await f.waitClosed()
})

it.each(['client-close', 'predestroyed'] as const)('socket-only original operation handles %s and revokes its one close listener', async (mode) => {
  const f = await fixture('socket-' + mode, 'socket'); f.operation.holdNormalFinish = true
  if (mode === 'predestroyed') {
    f.socket.destroy()
    expect(f.socket.destroyed).toBe(true); expect(f.state().socketCloseObserved).toBe(false)
  } else expect(f.socket.closed).toBe(false)
  f.observe()
  if (mode === 'predestroyed') expect(f.observer.signal.aborted).toBe(true)
  else { expect(f.observer.signal.aborted).toBe(false); f.client.destroy() }
  expect(f.state().resolves).toBe(0)
  await f.transferred; await f.waitClosed()
  expect(f.observer.signal.aborted).toBe(true)
})
