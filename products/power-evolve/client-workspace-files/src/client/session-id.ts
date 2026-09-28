const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A file operation must be bound to the visible native Session before it reaches the Host. */
export function validFileSessionId(sessionId: string): boolean {
  return sessionIdPattern.test(sessionId)
}

export function requireFileSessionId(sessionId: string): string {
  if (!validFileSessionId(sessionId)) throw new Error('Current Session is unavailable')
  return sessionId
}
