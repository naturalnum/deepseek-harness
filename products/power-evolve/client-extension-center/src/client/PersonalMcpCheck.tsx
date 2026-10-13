/** Saved and draft discovery checks bound to existing native Sessions. */
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  PersonalMcpConnection,
  PersonalMcpConnectionCheck,
  PersonalMcpConnectionCreateRequest,
} from './personal-mcp-client.ts'
import { McpDetailCard } from './McpPresentation.tsx'
import { personalMcpCheckErrorLabel, personalMcpSavedCheckIsStale } from './personal-mcp-check-view.ts'
import type { PersonalMcpPageProps } from './PersonalMcpPage.tsx'
import {
  createPersonalMcpCheckIdempotencyKey,
  PersonalMcpConnectionRequestError,
  type PersonalMcpConnectionCheckDraftRequest,
  type PersonalMcpConnectionPort,
} from './personal-mcp-client.ts'
import {
  buildPersonalMcpCreateRequest,
  personalMcpFormFromConnection,
} from './personal-mcp-view.ts'
import {
  personalMcpSessionOptions,
  type PersonalMcpSessionListState,
} from './personal-mcp-session-view.ts'
import type { PersonalMcpModel } from './use-personal-mcp.ts'
import {
  personalMcpDraftCheckKey,
  PersonalMcpDraftCheckGuard,
} from './personal-mcp-check-watch.ts'

/** Check an exact saved connection revision and show its durable result.
 * @param props - saved connection, check model, and explicit Session selection.
 * @returns the saved-check detail card.
 */
export function ConnectionCheckCard({
  connection,
  client,
  model,
  sessionList,
  sessionId,
  t,
  onSessionChange,
}: {
  readonly connection: PersonalMcpConnection
  readonly client: PersonalMcpConnectionPort
  readonly model: PersonalMcpModel
  readonly sessionList: PersonalMcpSessionListState
  readonly sessionId: string
  readonly t: PersonalMcpPageProps['t']
  readonly onSessionChange: (value: string) => void
}): ReactNode {
  return (
    <McpDetailCard title={t('personalMcpCheckTitle')} description={t('personalMcpCheckHint')}>
      <DraftCheckControls
        configuration={buildPersonalMcpCreateRequest(personalMcpFormFromConnection(connection))}
        connection={connection}
        initialCheck={connection.latest_check}
        client={client}
        model={model}
        blocked={model.busyId !== undefined || model.failedMutation || !model.available}
        sessionList={sessionList}
        sessionId={sessionId}
        t={t}
        onSessionChange={onSessionChange}
      />
    </McpDetailCard>
  )
}

/** Bind check controls to an immutable form draft or a saved-check model.
 * @param props - draft input, browser Port, and localized Session selector.
 * @returns check submission, cancellation, and status controls.
 */
export function DraftCheckControls({
  configuration,
  connection,
  initialCheck,
  client,
  model,
  blocked,
  sessionList,
  sessionId,
  t,
  onSessionChange,
}: {
  readonly configuration: PersonalMcpConnectionCreateRequest
  readonly connection?: PersonalMcpConnection
  readonly initialCheck?: PersonalMcpConnectionCheck | null
  readonly client: PersonalMcpConnectionPort
  readonly model?: PersonalMcpModel
  readonly blocked: boolean
  readonly sessionList: PersonalMcpSessionListState
  readonly sessionId: string
  readonly t: PersonalMcpPageProps['t']
  readonly onSessionChange: (value: string) => void
}): ReactNode {
  const [check, setCheck] = useState<PersonalMcpConnectionCheck | null | undefined>(initialCheck)
  const [busy, setBusy] = useState<'start' | 'cancel'>()
  const [error, setError] = useState<string>()
  const [failedAttempt, setFailedAttempt] = useState(false)
  const [pollError, setPollError] = useState(false)
  const attempt = useRef<{ readonly input: PersonalMcpConnectionCheckDraftRequest; readonly requestId: string }>()
  const cancelRequest = useRef<{ readonly checkId: string; readonly requestId: string }>()
  const busyRef = useRef(false)
  const guard = useRef(new PersonalMcpDraftCheckGuard()).current
  const pollRequest = useRef<AbortController>()
  const draftKey = personalMcpDraftCheckKey(configuration, connection, sessionId)
  const priorDraftKey = useRef(draftKey)
  const currentCheck = model === undefined ? check : initialCheck
  const stale = model !== undefined && connection !== undefined && currentCheck !== null && currentCheck !== undefined
    && personalMcpSavedCheckIsStale(connection, currentCheck)
  const pending = currentCheck?.state === 'queued' || currentCheck?.state === 'running'
  const sessions = personalMcpSessionOptions(sessionList)

  useLayoutEffect(() => {
    if (priorDraftKey.current === draftKey) return
    priorDraftKey.current = draftKey
    guard.invalidate()
    pollRequest.current?.abort()
    pollRequest.current = undefined
    setCheck(undefined)
    setBusy(undefined)
    setError(undefined)
    attempt.current = undefined
    cancelRequest.current = undefined
    busyRef.current = false
    setFailedAttempt(false)
    setPollError(false)
  }, [draftKey, guard])

  useEffect(() => () => {
    guard.invalidate()
    pollRequest.current?.abort()
  }, [guard])

  useEffect(() => {
    if (model !== undefined || pollError || !pending || check === null || check === undefined) return
    const controller = new AbortController()
    const revision = guard.current()
    pollRequest.current = controller
    const timer = setTimeout(() => {
      void client.getDraftCheck(check.check_id, controller.signal).then((value) => {
        if (!controller.signal.aborted && guard.accepts(revision)) { setCheck(value); setError(undefined) }
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted && guard.accepts(revision)) { setError(message(cause, t)); setPollError(true) }
      })
    }, 1000)
    return () => {
      controller.abort()
      if (pollRequest.current === controller) pollRequest.current = undefined
      clearTimeout(timer)
    }
  }, [check, client, draftKey, guard, model, pending, pollError, t])

  const start = async (): Promise<void> => {
    if (sessionId === '' || busyRef.current || blocked || pending) return
    busyRef.current = true
    const revision = guard.begin()
    pollRequest.current?.abort()
    pollRequest.current = undefined
    setBusy('start'); setError(undefined); setPollError(false)
    try {
      const input = {
        session_id: sessionId,
        configuration,
        ...(connection === undefined ? {} : {
          connection_id: connection.connection_id,
          expected_revision: connection.revision,
        }),
      }
      if (model !== undefined && connection !== undefined) {
        await model.startCheck(connection.connection_id, input)
      } else {
        attempt.current ??= { input, requestId: createPersonalMcpCheckIdempotencyKey() }
        const created = await client.createDraftCheck(attempt.current.input, attempt.current.requestId)
        if (guard.accepts(revision)) {
          setCheck(created)
          setFailedAttempt(false)
          attempt.current = undefined
        }
      }
    } catch (cause) {
      if (guard.accepts(revision)) {
        const ambiguous = !(cause instanceof PersonalMcpConnectionRequestError) || cause.status >= 500
        setFailedAttempt(ambiguous)
        if (!ambiguous) attempt.current = undefined
        setError(ambiguous ? t('personalMcpCheckUncertain') : message(cause, t))
      }
    } finally {
      if (guard.accepts(revision)) { busyRef.current = false; setBusy(undefined) }
    }
  }
  const cancel = async (): Promise<void> => {
    if (currentCheck === null || currentCheck === undefined || busyRef.current || !pending) return
    busyRef.current = true
    const revision = guard.begin()
    pollRequest.current?.abort()
    if (cancelRequest.current?.checkId !== currentCheck.check_id) {
      cancelRequest.current = { checkId: currentCheck.check_id, requestId: createPersonalMcpCheckIdempotencyKey() }
    }
    setBusy('cancel'); setError(undefined)
    try {
      if (model !== undefined && connection !== undefined) {
        await model.cancelCheck(connection.connection_id, currentCheck.check_id)
      } else {
        const canceled = await client.cancelDraftCheck(currentCheck.check_id, cancelRequest.current.requestId)
        if (guard.accepts(revision)) setCheck(canceled)
      }
    } catch (cause) {
      if (guard.accepts(revision)) {
        setError(message(cause, t))
        setPollError(false)
        setCheck({ ...currentCheck })
      }
    } finally {
      if (guard.accepts(revision)) { busyRef.current = false; setBusy(undefined) }
    }
  }

  return (
    <div className="pext-mcp-check">
      <label className="pext-mcp-form-field">
        <span>{t('mcpCheckSession')}</span>
        <select
          value={sessionId}
          disabled={blocked || busy !== undefined || pending || failedAttempt || model?.failedCheckAttempt !== undefined
            || sessionList.phase === 'pending' || sessions.length === 0}
          onChange={(event) => { onSessionChange(event.target.value) }}
        >
          <option value="">{sessionList.phase === 'pending' ? t('mcpSessionsLoading') : t('mcpSelectSession')}</option>
          {sessions.map(session => (
            <option key={session.id} value={session.id}>
              {session.label}{session.current ? ` (${t('mcpCurrentSession')})` : ''}
            </option>
          ))}
        </select>
      </label>
      {sessions.length === 0 && sessionList.phase !== 'pending'
        ? <p className="pext-mcp-check-session-empty">{t('mcpNoSession')}</p>
        : null}
      <div className="pext-mcp-check-actions">
        <button
          type="button"
          className="pext-mcp-button pext-mcp-button-primary"
          disabled={blocked || busy !== undefined || pending || failedAttempt || model?.failedCheckAttempt !== undefined || sessionId === ''}
          onClick={() => { void start() }}
        >
          {busy === 'start' ? t('mcpStartingCheck') : pending ? t('mcpCheckRunning') : t('mcpStartCheck')}
        </button>
        {!pending
          ? null
          : <button type="button" className="pext-mcp-button" disabled={busy !== undefined} onClick={() => { void cancel() }}>{busy === 'cancel' ? t('mcpCancelingCheck') : t('mcpCancelCheck')}</button>}
      </div>
      {error === undefined ? null : <div className="pext-error" role="alert">{error}</div>}
      {failedAttempt && <button type="button" className="pext-mcp-button" disabled={blocked || busy !== undefined}
        onClick={() => { void start() }}>{t('mcpRetryCheckRequest')}</button>}
      {model?.failedCheckAttempt !== undefined && <button type="button" className="pext-mcp-button" disabled={blocked || busy !== undefined}
        onClick={() => { void model.retryCheck() }}>{t('mcpRetryCheckRequest')}</button>}
      {pending && (pollError || model?.error !== undefined) && <button type="button" className="pext-mcp-button"
        disabled={blocked || busy !== undefined} onClick={() => {
          setError(undefined); setPollError(false)
          if (model !== undefined) void model.reload()
        }}>{t('mcpRefreshCheck')}</button>}
      <DraftCheckResult check={currentCheck} stale={stale} t={t} />
    </div>
  )
}

function DraftCheckResult({ check, stale, t }: {
  readonly check: PersonalMcpConnectionCheck | null | undefined
  readonly stale: boolean
  readonly t: PersonalMcpPageProps['t']
}): ReactNode {
  if (check === null || check === undefined) return <div className="pext-mcp-check-result">{t('mcpCheckNever')}</div>
  const labels = {
    queued: 'mcpCheckQueued', running: 'mcpCheckRunning',
    succeeded: check.discovered_tools === 0
      ? 'mcpCheckSucceededZero'
      : check.discovered_tools === null ? 'mcpCheckSucceededUnknown' : 'personalMcpCheckSucceeded',
    failed: 'personalMcpCheckFailed', canceled: 'mcpCheckCanceled', timed_out: 'mcpCheckTimedOut',
    expired: 'mcpCheckExpired',
  } as const
  const label = labels[check.state]
  const labelText = label === 'personalMcpCheckSucceeded'
    ? t(label).replace('{count}', String(check.discovered_tools))
    : t(label)
  return (
    <div className="pext-mcp-check-result" data-state={stale ? 'stale' : check.state}
      data-check-state={stale ? check.state : undefined}>
      <strong>{stale ? t('mcpCheckCurrentNotChecked') : labelText}</strong>
      {stale && <small className="pext-mcp-check-stale">{t('mcpCheckStale')}</small>}
      {stale && <span>{t('mcpCheckPreviousResult').replace('{result}', labelText)}</span>}
      {check.cancel_requested && (check.state === 'queued' || check.state === 'running')
        && <span>{t('mcpCancelingCheck')}</span>}
      {check.error_code === null ? null : <span>{t(personalMcpCheckErrorLabel(check.error_code))}</span>}
    </div>
  )
}

function message(cause: unknown, t: PersonalMcpPageProps['t']): string {
  return t(cause instanceof PersonalMcpConnectionRequestError ? cause.label : 'mcpLoadFailed')
}
