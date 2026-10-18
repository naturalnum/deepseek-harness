import { resolveClientPersistence, type ClientPersistence } from '@deepseek-ai/dsh-client-store'
/** Unfinished close requests survive reload independently of the removed sidebar tabs. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebTerminalId } from '../types.ts'

/** An explicit cleanup request; no process or open-tab metadata is mirrored here. */
export interface TerminalCloseRequest {
  readonly sessionId: SessionId
  readonly id: WebTerminalId
  readonly title: string
}

const PREFIX = 'dsh.terminal.close.v1.'

/** Each request has its own logical key within the captured page namespace. */
export class TerminalCloseRequests {
  private readonly requests = new Map<WebTerminalId, TerminalCloseRequest>()

  private readonly persistence: ClientPersistence

  /** @param persistence - page port; absent retains ordinary browser persistence. */
  constructor(persistence?: ClientPersistence) {
    this.persistence = resolveClientPersistence(persistence)
    for (const key of this.persistence.keys()) {
      if (key.startsWith(PREFIX)) this.load(key)
    }
  }

  /**
   * Read cleanup work still awaiting Host confirmation.
   * @returns unfinished requests owned by this browser instance.
   */
  pending(): readonly TerminalCloseRequest[] { return [...this.requests.values()] }

  /**
   * Retain cleanup across reload before removing a tab.
   * @param request - close intent to save before removing its tab.
   */
  save(request: TerminalCloseRequest): void {
    this.requests.set(request.id, request)
    this.persistence.setItem(PREFIX + request.id, JSON.stringify(request))
  }

  /**
   * Forget confirmed cleanup in memory and browser storage.
   * @param id - terminal whose Host cleanup succeeded.
   */
  remove(id: WebTerminalId): void {
    this.requests.delete(id)
    this.persistence.removeItem(PREFIX + id)
  }

  private load(key: string): void {
    const raw = this.persistence.getItem(key)
    try {
      if (raw === null) return
      const parsed: unknown = JSON.parse(raw)
      if (!isRequest(parsed) || key !== PREFIX + parsed.id) throw new Error('Invalid terminal cleanup request')
      this.requests.set(parsed.id, parsed)
    } catch (error) { console.error('Terminal cleanup recovery failed:', error) }
  }
}

function isRequest(value: unknown): value is TerminalCloseRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Record<string, unknown>
  return typeof request.sessionId === 'string' && request.sessionId.length > 0
    && typeof request.id === 'string' && /^[\w-]{1,128}$/u.test(request.id)
    && typeof request.title === 'string'
}
