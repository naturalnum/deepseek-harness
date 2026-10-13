/** Account-owned MCP page model with explicit stable mutation retries. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PersonalMcpConnection,
  PersonalMcpConnectionCheck,
  PersonalMcpConnectionCreateRequest,
  PersonalMcpConnectionUpdateRequest,
} from './personal-mcp-client.ts'
import {
  createPersonalMcpCheckIdempotencyKey,
  PersonalMcpConnectionRequestError,
  type PersonalMcpConnectionCheckDraftRequest,
  type PersonalMcpConnectionPort,
} from './personal-mcp-client.ts'
import {
  pendingPersonalMcpCheckTarget,
  updatePersonalMcpCheck,
  watchPersonalMcpCheck,
  type PersonalMcpCheckUpdateAuthority,
} from './personal-mcp-check-watch.ts'

/** Account-owned paged metadata and explicit mutations bound to one browser Port. */
export interface PersonalMcpModel {
  readonly connections: readonly PersonalMcpConnection[]
  readonly loading: boolean
  readonly available: boolean
  readonly loadingMore: boolean
  readonly busyId: string | undefined
  readonly error: string | undefined
  readonly nextCursor: string | undefined
  readonly activeCheckId: string | undefined
  readonly failedCheckAttempt: PersonalMcpFailedCheckAttempt | undefined
  readonly failedMutation: boolean
  reload(): Promise<void>
  loadMore(): Promise<void>
  clearError(): void
  create(input: PersonalMcpConnectionCreateRequest): Promise<PersonalMcpConnection | undefined>
  update(connectionId: string, input: PersonalMcpConnectionUpdateRequest): Promise<PersonalMcpConnection | undefined>
  toggle(connectionId: string, expectedRevision: number, enabled: boolean): Promise<PersonalMcpConnection | undefined>
  remove(connectionId: string, expectedRevision: number): Promise<boolean>
  startCheck(
    connectionId: string,
    input: PersonalMcpConnectionCheckDraftRequest,
  ): Promise<PersonalMcpConnectionCheck | undefined>
  cancelCheck(connectionId: string, checkId: string): Promise<PersonalMcpConnectionCheck | undefined>
  retryCheck(): Promise<PersonalMcpConnectionCheck | undefined>
  retryMutation(): Promise<PersonalMcpConnection | true | undefined>
}

/** Non-secret identity of an uncertain saved-check submission. */
export interface PersonalMcpFailedCheckAttempt {
  readonly connectionId: string
  readonly expectedRevision: number | undefined
  readonly sessionId: string
}

interface PersonalMcpCheckAttempt extends PersonalMcpFailedCheckAttempt {
  readonly idempotencyKey: string
  readonly input: PersonalMcpConnectionCheckDraftRequest
}

interface MutationAttempt<Value extends PersonalMcpConnection | true = PersonalMcpConnection | true> {
  readonly operationId: string
  readonly operation: () => Promise<{
    readonly value: Value
    readonly apply: (current: readonly PersonalMcpConnection[]) => readonly PersonalMcpConnection[]
  }>
}

function mutation<Value extends PersonalMcpConnection | true>(operationId: string,
  operation: () => Promise<Value>,
  apply: (value: Value, current: readonly PersonalMcpConnection[]) => readonly PersonalMcpConnection[],
): MutationAttempt<Value> {
  return { operationId, operation: async () => {
    const value = await operation()
    return { value, apply: current => apply(value, current) }
  } }
}

const CREATE_BUSY_ID = 'create'

/** Bind connections and explicit mutations to one React view generation.
 * @param client - account-scoped browser Port. @param t - locale-owned message resolver.
 * @param observedConnectionId - open detail whose pending check is polled. @returns the page model.
 */
export function usePersonalMcp(
  client: PersonalMcpConnectionPort,
  t: TranslateNS<'powerEvolve.extensionCenter'>,
  observedConnectionId?: string,
): PersonalMcpModel {
  const [connections, setConnections] = useState<readonly PersonalMcpConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [available, setAvailable] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const [nextCursor, setNextCursor] = useState<string>()
  const [failedCheckAttempt, setFailedCheckAttempt] = useState<PersonalMcpCheckAttempt>()
  const [failedMutation, setFailedMutation] = useState(false)
  const [checkWatchEpoch, setCheckWatchEpoch] = useState(0)
  const mutationAttempt = useRef<MutationAttempt>()
  const cancellationRequest = useRef(new Map<string, string>())
  const request = useRef<AbortController>()
  const pageRequest = useRef<AbortController>()
  const generation = useRef(0)
  const busyRef = useRef<string>()
  const busyEpoch = useRef(0)

  const reload = useCallback(async () => {
    request.current?.abort()
    pageRequest.current?.abort()
    pageRequest.current = undefined
    setLoadingMore(false)
    const controller = new AbortController()
    request.current = controller
    const currentGeneration = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const page = await client.list({ limit: 50 }, controller.signal)
      if (controller.signal.aborted || currentGeneration !== generation.current) return
      setConnections(page.items)
      setAvailable(page.available ?? true)
      setNextCursor(page.nextCursor)
      setCheckWatchEpoch(current => current + 1)
    } catch (cause) {
      if (controller.signal.aborted || currentGeneration !== generation.current) return
      setError(messageOf(cause, t))
    } finally {
      if (request.current === controller && currentGeneration === generation.current) {
        request.current = undefined
        setLoading(false)
      }
    }
  }, [client, t])

  useEffect(() => {
    busyEpoch.current += 1
    busyRef.current = undefined
    setBusyId(undefined)
    setFailedCheckAttempt(undefined)
    mutationAttempt.current = undefined
    setFailedMutation(false)
    void reload()
    return () => {
      request.current?.abort()
      pageRequest.current?.abort()
      request.current = undefined
      pageRequest.current = undefined
      generation.current += 1
      busyEpoch.current += 1
      busyRef.current = undefined
    }
  }, [reload])

  const loadMore = useCallback(async () => {
    if (nextCursor === undefined || loadingMore) return
    pageRequest.current?.abort()
    const controller = new AbortController()
    pageRequest.current = controller
    const currentGeneration = generation.current
    setLoadingMore(true)
    setError(undefined)
    try {
      const page = await client.list({ limit: 50, cursor: nextCursor }, controller.signal)
      if (controller.signal.aborted || currentGeneration !== generation.current) return
      const identities = new Set(connections.map(item => item.connection_id))
      if (page.items.some(item => identities.has(item.connection_id))) {
        throw new PersonalMcpConnectionRequestError(502, 'mcpLoadFailed')
      }
      setConnections(current => [...current, ...page.items])
      setNextCursor(page.nextCursor)
    } catch (cause) {
      if (controller.signal.aborted || currentGeneration !== generation.current) return
      setError(messageOf(cause, t))
    } finally {
      if (pageRequest.current === controller && currentGeneration === generation.current) {
        pageRequest.current = undefined
        setLoadingMore(false)
      }
    }
  }, [client, connections, loadingMore, nextCursor, t])

  const mutate = useCallback(async <Value extends PersonalMcpConnection | true>(
    attempt: MutationAttempt<Value>,
  ): Promise<Value | undefined> => {
    if (busyRef.current !== undefined) return undefined
    const { operationId, operation } = attempt
    busyRef.current = operationId
    const operationEpoch = ++busyEpoch.current
    request.current?.abort()
    pageRequest.current?.abort()
    const operationGeneration = ++generation.current
    setLoading(false)
    setLoadingMore(false)
    setBusyId(operationId)
    setError(undefined)
    setFailedCheckAttempt(undefined)
    mutationAttempt.current = attempt
    setFailedMutation(false)
    try {
      const { value, apply } = await operation()
      if (operationGeneration !== generation.current) return undefined
      setConnections(current => apply(current))
      mutationAttempt.current = undefined
      setNextCursor(undefined)
      const reloading = reload()
      const reloadGeneration = generation.current
      await reloading
      if (reloadGeneration !== generation.current) return undefined
      return value
    } catch (cause) {
      if (operationGeneration === generation.current) {
        if (cause instanceof PersonalMcpConnectionRequestError && cause.status < 500) {
          mutationAttempt.current = undefined
          setError(messageOf(cause, t))
        } else {
          setFailedMutation(true)
          setError(t('personalMcpMutationUncertain'))
        }
      }
      return undefined
    } finally {
      if (operationEpoch === busyEpoch.current) {
        busyRef.current = undefined
        setBusyId(undefined)
      }
    }
  }, [reload, t])

  const patchCheck = useCallback((
    check: PersonalMcpConnectionCheck,
    authority: PersonalMcpCheckUpdateAuthority,
  ) => {
    setConnections(current => updatePersonalMcpCheck(current, check, authority))
  }, [])

  const runCheckOperation = useCallback(async (
    operationId: string,
    operation: () => Promise<PersonalMcpConnectionCheck>,
    authority: PersonalMcpCheckUpdateAuthority,
    onFailure?: (cause: unknown) => void,
  ): Promise<PersonalMcpConnectionCheck | undefined> => {
    if (busyRef.current !== undefined) return undefined
    busyRef.current = operationId
    const operationEpoch = ++busyEpoch.current
    const operationGeneration = generation.current
    setBusyId(operationId)
    setError(undefined)
    try {
      const check = await operation()
      if (operationGeneration !== generation.current) return undefined
      patchCheck(check, authority)
      return check
    } catch (cause) {
      if (operationGeneration === generation.current) {
        setError(messageOf(cause, t))
        onFailure?.(cause)
      }
      return undefined
    } finally {
      if (operationEpoch === busyEpoch.current) {
        busyRef.current = undefined
        setBusyId(undefined)
      }
    }
  }, [patchCheck, t])

  const activeCheck = pendingPersonalMcpCheckTarget(connections, observedConnectionId)
  const activeConnectionId = activeCheck?.connectionId
  const activeCheckId = activeCheck?.checkId

  useEffect(() => {
    if (activeConnectionId === undefined || activeCheckId === undefined) return
    return watchPersonalMcpCheck(
      { connectionId: activeConnectionId, checkId: activeCheckId },
      (connectionId, checkId, signal) => client.getCheck(connectionId, checkId, signal),
      (check) => { patchCheck(check, 'current-check') },
      (cause) => {
        setError(messageOf(cause, t))
      },
    )
  }, [activeCheckId, activeConnectionId, checkWatchEpoch, client, patchCheck, t])

  return {
    connections,
    loading,
    available,
    loadingMore,
    busyId,
    error,
    nextCursor,
    activeCheckId,
    failedCheckAttempt,
    failedMutation,
    reload,
    loadMore,
    clearError: () => { setError(undefined) },
    create: async (input) => {
      if (mutationAttempt.current !== undefined) return undefined
      const requestId = randomUUID()
      return mutate(mutation(CREATE_BUSY_ID,
        () => client.create(input, requestId),
        (created, current) => [...current, created],
      ))
    },
    update: async (connectionId, input) => {
      if (mutationAttempt.current !== undefined) return undefined
      const requestId = randomUUID()
      return mutate(mutation(connectionId,
        () => client.update(connectionId, input, requestId),
        (updated, current) => current.map(item => item.connection_id === connectionId ? updated : item),
      ))
    },
    remove: async (connectionId, expectedRevision) => {
      if (mutationAttempt.current !== undefined) return false
      const requestId = randomUUID()
      const removed = (await mutate(mutation(connectionId,
        async (): Promise<true> => { await client.remove(connectionId, expectedRevision, requestId); return true },
        (_removed, current) => current.filter(item => item.connection_id !== connectionId),
      ))) === true
      return removed
    },
    toggle: async (connectionId, expectedRevision, enabled) => {
      if (mutationAttempt.current !== undefined) return undefined
      const requestId = randomUUID()
      return mutate(mutation(connectionId,
        () => client.toggle(connectionId, expectedRevision, enabled, requestId),
        (updated, current) => current.map(item => item.connection_id === connectionId ? updated : item),
      ))
    },
    startCheck: async (connectionId, input) => {
      const attempt = {
        connectionId,
        expectedRevision: input.expected_revision,
        sessionId: input.session_id,
        idempotencyKey: createPersonalMcpCheckIdempotencyKey(),
        input,
      }
      setFailedCheckAttempt(undefined)
      const result = await runCheckOperation(
        `check:${connectionId}`,
        () => client.createCheck(connectionId, input, attempt.idempotencyKey),
        'new-check',
        (cause) => {
          if (ambiguousCheckCreateFailure(cause)) setFailedCheckAttempt(attempt)
        },
      )
      if (result !== undefined) setFailedCheckAttempt(undefined)
      return result
    },
    cancelCheck: async (connectionId, checkId) => {
      const requestId = cancellationRequest.current.get(checkId) ?? randomUUID()
      cancellationRequest.current.set(checkId, requestId)
      const operationGeneration = generation.current
      const result = await runCheckOperation(
        `cancel:${connectionId}`,
        () => client.cancelCheck(connectionId, checkId, requestId),
        'current-check',
      )
      if (operationGeneration !== generation.current) return undefined
      return result
    },
    retryCheck: async () => {
      if (failedCheckAttempt === undefined) return undefined
      const attempt = failedCheckAttempt
      const result = await runCheckOperation(
        `check:${attempt.connectionId}`,
        () => client.createCheck(attempt.connectionId, attempt.input, attempt.idempotencyKey),
        'new-check',
        (cause) => {
          if (!ambiguousCheckCreateFailure(cause)) setFailedCheckAttempt(undefined)
        },
      )
      if (result !== undefined) setFailedCheckAttempt(undefined)
      return result
    },
    retryMutation: async () => mutationAttempt.current === undefined
      ? undefined : mutate(mutationAttempt.current),
  }
}

function messageOf(cause: unknown, t: TranslateNS<'powerEvolve.extensionCenter'>): string {
  return t(cause instanceof PersonalMcpConnectionRequestError ? cause.label : 'mcpLoadFailed')
}

function ambiguousCheckCreateFailure(cause: unknown): boolean {
  return !(cause instanceof PersonalMcpConnectionRequestError) || cause.status >= 500
}
