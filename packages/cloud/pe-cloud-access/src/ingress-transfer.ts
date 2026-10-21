/** Response observation on the original ingress operation; no independent cancellation or capacity owner. */
import type { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** The original operation supplies these same fields; normal preview finish does not revoke its ongoing consumer. */
export interface IngressTransferOperation {
  readonly response: ServerResponse | undefined
  readonly socket: Duplex | undefined
  readonly observer: AbortController
  holdNormalFinish: boolean
}

/**
 * Resolve the original transfer latch after actual response finish or carrier close.
 * Install at ingress entry before asynchronous consumers; a destroyed socket alone supplies no close receipt.
 * @param operation Original ingress operation and its existing observer.
 * @param resolve Original transfer-latch resolver; no account or request capacity is released here.
 */
export function observeIngressTransfer(operation: IngressTransferOperation, resolve: () => void): void {
  const { response, socket, observer } = operation
  const done = (normalFinish: boolean): void => {
    response?.off('finish', finished); response?.off('close', closed); response?.off('error', failed)
    socket?.off('close', closed)
    if (!normalFinish || !operation.holdNormalFinish) observer.abort()
    resolve()
  }
  const finished = (): void => { done(response?.writableFinished === true) }
  const closed = (): void => { done(false) }
  const failed = (): void => {
    observer.abort(); response?.destroy()
    if (response?.closed === true) closed()
  }
  if (response !== undefined) {
    response.once('finish', finished); response.once('close', closed); response.once('error', failed)
    if (response.closed) closed()
    else if (response.destroyed) observer.abort()
    else if (response.writableFinished) finished()
  } else {
    socket?.once('close', closed)
    if (socket?.closed === true || socket?.destroyed === true) observer.abort()
  }
}
