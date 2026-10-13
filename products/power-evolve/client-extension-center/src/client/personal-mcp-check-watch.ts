/** MCP check polling and guards against superseded asynchronous results. */
import type {
  PersonalMcpConnection,
  PersonalMcpConnectionCheck,
  PersonalMcpConnectionCreateRequest,
} from './personal-mcp-client.ts'

/** Exact saved check identity observed by a detail page. */
export interface PersonalMcpCheckTarget {
  readonly connectionId: string
  readonly checkId: string
}

/** Only a user-started new check may replace a different latest check. */
export type PersonalMcpCheckUpdateAuthority = 'new-check' | 'current-check'

/** Stable identity for one form draft and the Session associated with its check.
 * @param configuration - immutable browser-local input. @param connection - optional saved revision.
 * @param sessionId - existing native Session. @returns the draft comparison key, never sent to Host.
 */
export function personalMcpDraftCheckKey(
  configuration: PersonalMcpConnectionCreateRequest,
  connection: Pick<PersonalMcpConnection, 'connection_id' | 'revision'> | undefined,
  sessionId: string,
): string {
  return canonicalJson({
    configuration,
    connection_id: connection?.connection_id ?? null,
    expected_revision: connection?.revision ?? null,
    session_id: sessionId,
  })
}

/** Reject asynchronous MCP check results created for an older form draft. */
export class PersonalMcpDraftCheckGuard {
  private revision = 0

  /** Begin a new asynchronous result generation. @returns its generation. */
  begin(): number {
    this.revision += 1
    return this.revision
  }

  /** Reject results belonging to all earlier generations. */
  invalidate(): void {
    this.revision += 1
  }

  /** @returns the current generation. */
  current(): number {
    return this.revision
  }

  /** @param revision - result generation. @returns whether it still owns the draft. */
  accepts(revision: number): boolean {
    return revision === this.revision
  }
}

/** Preserve a newer latest_check when an older watched request returns late.
 * @param connections - current masked rows. @param check - returned check.
 * @param authority - whether the user started a new check. @returns rows with any accepted check update.
 */
export function updatePersonalMcpCheck(
  connections: readonly PersonalMcpConnection[],
  check: PersonalMcpConnectionCheck,
  authority: PersonalMcpCheckUpdateAuthority,
): readonly PersonalMcpConnection[] {
  return connections.map((connection) => {
    if (connection.connection_id !== check.connection_id) return connection
    if (authority === 'current-check' && connection.latest_check?.check_id !== check.check_id) {
      return connection
    }
    if (authority === 'current-check' && connection.latest_check !== null
      && terminalCheck(connection.latest_check) && pendingCheck(check)) return connection
    if (authority === 'current-check' && connection.latest_check?.cancel_requested
      && !check.cancel_requested && pendingCheck(check)) return connection
    return { ...connection, latest_check: check }
  })
}

/** Watch only the pending latest check belonging to the currently open detail.
 * @param connections - current rows. @param observedConnectionId - open detail.
 * @returns the exact pending target, or undefined.
 */
export function pendingPersonalMcpCheckTarget(
  connections: readonly PersonalMcpConnection[],
  observedConnectionId: string | undefined,
): PersonalMcpCheckTarget | undefined {
  if (observedConnectionId === undefined) return undefined
  const check = connections.find(connection => connection.connection_id === observedConnectionId)
    ?.latest_check
  return check !== null && check !== undefined && check.connection_id !== null && pendingCheck(check)
    ? { connectionId: check.connection_id, checkId: check.check_id }
    : undefined
}

function pendingCheck(check: PersonalMcpConnectionCheck): boolean {
  return check.state === 'queued' || check.state === 'running'
}

function terminalCheck(check: PersonalMcpConnectionCheck): boolean {
  return !pendingCheck(check)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Poll one user-started check until the server reports a terminal state.
 * @param target - exact saved check. @param load - abortable status read. @param onUpdate - accepted status.
 * @param onError - failure display callback. @param intervalMs - polling interval.
 * @returns a disposer that aborts the read and cancels its timer.
 */
export function watchPersonalMcpCheck(
  target: PersonalMcpCheckTarget,
  load: (
    connectionId: string,
    checkId: string,
    signal: AbortSignal,
  ) => Promise<PersonalMcpConnectionCheck>,
  onUpdate: (check: PersonalMcpConnectionCheck) => void,
  onError: (cause: unknown) => void,
  intervalMs = 1000,
): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const schedule = (): void => {
    timer = setTimeout(() => { void poll() }, intervalMs)
  }
  const poll = async (): Promise<void> => {
    try {
      const check = await load(target.connectionId, target.checkId, controller.signal)
      if (controller.signal.aborted) return
      onUpdate(check)
      if (check.state === 'queued' || check.state === 'running') schedule()
    } catch (cause) {
      if (!controller.signal.aborted) onError(cause)
    }
  }
  schedule()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}
