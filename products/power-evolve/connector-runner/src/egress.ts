/** Active forbidden-target probe for the Connector Runner's egress gate. */
import { connect } from 'node:net'

export type ProbeResult = 'connected' | 'denied' | 'refused' | 'inconclusive'
export interface ProbeTarget { readonly host: string; readonly port: number }
export type Probe = (target: ProbeTarget, timeoutMs: number) => Promise<ProbeResult>

/** A refused connection is proof only when a separate control probe established a healthy listener. */
export async function tcpProbe(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port })
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs, () => { finish('denied') })
    socket.once('connect', () => { finish('connected') })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'refused'
        : ['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EACCES', 'EPERM'].includes(error.code ?? '')
          ? 'denied' : 'inconclusive')
    })
  })
}

/** Readiness requires repeated denials and is withdrawn on any later policy failure. */
export class EgressGate {
  private consecutive = 0
  private passed = false
  private timer: NodeJS.Timeout | undefined
  private checking: Promise<void> | undefined
  private stopped = false

  constructor(private readonly target: ProbeTarget | undefined,
    private readonly probe: Probe = tcpProbe,
    private readonly refusedIsDenied = false,
    private readonly intervalMs = 1000,
    private readonly timeoutMs = 400) {}

  get ready(): boolean { return this.passed && !this.stopped }

  /** Start periodic checks; absence of a target always leaves readiness false. */
  start(): void {
    if (!this.target || this.timer) return
    void this.check()
    this.timer = setInterval(() => { void this.check() }, this.intervalMs)
    this.timer.unref()
  }

  /** Probe once; concurrent checks share one observation. */
  check(): Promise<void> {
    if (!this.target || this.stopped) return Promise.resolve()
    if (this.checking) return this.checking
    const target = this.target
    this.checking = (async () => {
      let result: ProbeResult
      try { result = await this.probe(target, this.timeoutMs) }
      catch (_probeFailed) { result = 'inconclusive' }
      const denied = result === 'denied' || result === 'refused' && this.refusedIsDenied
      if (!denied) { this.consecutive = 0; this.passed = false }
      else { this.consecutive++; if (this.consecutive >= 3) this.passed = true }
    })().finally(() => { this.checking = undefined })
    return this.checking
  }

  /** Stop new calls and wait for an active observation. */
  async close(): Promise<void> {
    this.stopped = true
    this.passed = false
    if (this.timer) clearInterval(this.timer)
    await this.checking
  }
}
