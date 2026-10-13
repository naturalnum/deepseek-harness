/**
 * Control one external reply without depending on a timer or a production implementation.
 * @returns A pending promise and controls for its eventual reply.
 */
export function deferredResult<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
