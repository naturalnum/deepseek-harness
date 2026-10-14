/** Raw WebSocket upgrades preserve native stream multiplexing through trusted HTTP proxies. */
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { ConnectionOptions } from 'node:tls'

/** Forward one admitted upgrade and join both sockets when either endpoint closes.
 * @param request Original native WebSocket handshake, already authenticated by its caller.
 * @param socket Browser or upstream proxy socket.
 * @param head Bytes received after the original handshake.
 * @param target Fixed server-selected upstream URL.
 * @param options Trusted TLS and credential headers; client headers cannot override them.
 * @param timeoutMs Maximum elapsed time until the upstream completes its handshake.
 * @returns Completion after owned transports have closed, including failed handshakes.
 */
export async function proxyRuntimeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer,
  target: URL, options: Omit<RequestOptions, 'headers'> & ConnectionOptions & { headers?: OutgoingHttpHeaders }, timeoutMs: number): Promise<void> {
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid runtime proxy URL')
  const headers = { upgrade: 'websocket', connection: 'Upgrade',
    'sec-websocket-key': request.headers['sec-websocket-key'],
    'sec-websocket-version': request.headers['sec-websocket-version'],
    ...(request.headers['sec-websocket-protocol'] ? { 'sec-websocket-protocol': request.headers['sec-websocket-protocol'] } : {}),
    ...options.headers }
  await new Promise<void>((resolve, reject) => {
    let outgoing: ClientRequest | undefined, upstream: Duplex | undefined, refused: IncomingMessage | undefined
    let requestClosed = true, socketClosed = socket.closed, upstreamClosed = true, responseClosed = true
    let settled = false, failure: Error | undefined, timer: NodeJS.Timeout | undefined
    const settle = (): void => {
      if (settled || !requestClosed || !socketClosed || !upstreamClosed || !responseClosed) return
      settled = true
      clearTimeout(timer)
      socket.off('close', downstreamClosed); socket.off('error', fail); socket.off('end', stop)
      if (failure) reject(failure)
      else resolve()
    }
    const stop = (): void => {
      clearTimeout(timer)
      outgoing?.destroy(); refused?.destroy(); upstream?.destroy(); socket.destroy()
      settle()
    }
    const fail = (error: Error): void => { failure ??= error; stop() }
    const downstreamClosed = (): void => { socketClosed = true; stop() }
    socket.once('close', downstreamClosed)
    socket.once('error', fail)
    socket.once('end', stop)
    if (socket.destroyed) { stop(); return }
    try {
      outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target,
        { ...options, method: 'GET', headers })
      requestClosed = false
      outgoing.once('close', () => { requestClosed = true; settle() })
      outgoing.once('error', fail)
      outgoing.once('response', (response) => {
        refused = response; responseClosed = response.closed
        response.once('error', fail)
        response.once('close', () => { responseClosed = true; settle() })
        fail(new Error(`Native runtime upgrade refused (${response.statusCode ?? 500})`))
      })
      outgoing.once('upgrade', (response, transport, received) => {
        clearTimeout(timer)
        // The upgraded socket now owns the ClientRequest's transport.
        requestClosed = true
        upstream = transport; upstreamClosed = transport.closed
        transport.once('error', fail)
        transport.once('end', stop)
        transport.once('close', () => { upstreamClosed = true; stop() })
        if (failure || socket.destroyed) { stop(); return }
        const fields: string[] = ['HTTP/1.1 101 Switching Protocols']
        for (const name of ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol']) {
          const value = response.headers[name]
          if (typeof value === 'string') fields.push(`${name}: ${value}`)
        }
        socket.write(fields.join('\r\n') + '\r\n\r\n')
        if (received.length) socket.write(received)
        if (head.length) transport.write(head)
        transport.pipe(socket); socket.pipe(transport)
      })
      timer = setTimeout(() => { fail(new Error('Native runtime upgrade timed out')) }, timeoutMs)
      outgoing.end()
    } catch (error) { fail(error instanceof Error ? error : new Error('Native runtime upgrade failed', { cause: error })) }
  })
}
