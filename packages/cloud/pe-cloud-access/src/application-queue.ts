/** Finite FIFO waiting for service-content requests; execution reservations remain with the original service owner. */
import type { IncomingMessage, ServerResponse } from 'node:http'

interface Entry {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly consume: () => Promise<void>
  readonly finish: () => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly cancel: () => void
}

/** Serializes content resources without enlarging the original account/service HTTP capacity. */
export class ServiceApplicationQueue {
  private readonly waiting: Entry[] = []
  private active: Promise<void> | undefined
  private open = true

  /**
   * @param maximum Root's finite waiting-record limit.
   * @param timeoutMs Root's maximum waiting time.
   */
  constructor(private readonly maximum: number, private readonly timeoutMs: number) {}

  /**
   * Admit one paused request before reading its body; queue expiry destroys only this request's transport.
   * @param request Original dedicated-listener request with Native transport limits.
   * @param response Original response.
   * @param consume Actual ingress terminal, including authentication, transfer and Use release.
   * @returns After rejection or actual execution settlement, never an early ingress timeout.
   */
  run(request: IncomingMessage, response: ServerResponse, consume: () => Promise<void>): Promise<void> {
    if (!this.open || this.waiting.length >= this.maximum) {
      response.destroy(); request.destroy(); return Promise.resolve()
    }
    request.pause()
    const completion = Promise.withResolvers<void>()
    const cancel = (): void => {
      const index = this.waiting.indexOf(entry)
      if (index === -1) return
      this.waiting.splice(index, 1); clearTimeout(entry.timer)
      request.off('aborted', cancel); response.off('close', cancel)
      response.destroy(); request.destroy(); completion.resolve()
    }
    const entry: Entry = { request, response, consume, finish: completion.resolve, cancel,
      timer: setTimeout(cancel, this.timeoutMs) }
    this.waiting.push(entry)
    request.once('aborted', cancel); response.once('close', cancel)
    if (request.destroyed || response.destroyed) cancel()
    this.next()
    return completion.promise
  }

  /**
   * Close waiting admission and join the original active ingress operation.
   * @returns After queued requests close and the actual active ingress terminal settles.
   */
  async closeActual(): Promise<void> {
    this.open = false
    for (const entry of [...this.waiting]) entry.cancel()
    await this.active
  }

  private next(): void {
    if (!this.open || this.active !== undefined) return
    const entry = this.waiting.shift()
    if (entry === undefined) return
    clearTimeout(entry.timer)
    entry.request.off('aborted', entry.cancel); entry.response.off('close', entry.cancel)
    this.active = Promise.resolve().then(entry.consume).finally(() => {
      entry.finish(); this.active = undefined; this.next()
    })
    // The original ingress records unknown cleanup and retains the actual failed operation.
    void this.active.catch((_error: unknown) => { entry.response.destroy(); entry.request.destroy() })
  }
}
