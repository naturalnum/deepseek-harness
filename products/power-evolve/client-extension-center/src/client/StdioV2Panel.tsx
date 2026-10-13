/** Generic STDIO management inside the existing native Plugins card; every Check selects an existing Session. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { stdioCheckRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementSchemasV2, type StdioConnectionV2 } from '@power-evolve/contracts/stdio-management'
import type { PersonalMcpSessionSource } from './personal-mcp-session-view.ts'
import { SkillToggle } from './SkillToggle.tsx'
import { StdioV2State, stdioV2Configuration } from './stdio-v2-state.ts'

type Translate = TranslateNS<'powerEvolve.extensionCenter'>
const blank = { name: '', program: '', argv: '[]', cwd: '.' }

/** Existing-card props; no page creates Sessions, selects a deployment or grants approval. */
export interface StdioV2PanelProps {
  readonly state: StdioV2State
  readonly sessions: PersonalMcpSessionSource
  readonly approvalUrl: () => Promise<string>
  readonly onUnavailable?: (() => void) | undefined
  readonly onInstalledChange?: ((installed: boolean) => void) | undefined
  readonly t: Translate
}

/** Manage literal configurations and complete persisted outcomes using the original native Session source.
 * Session-list methods keep their receiver; request IDs also work in plain HTTP browser contexts.
 * @param props Owned controller, existing Sessions and trusted independent-approval destination.
 * @returns Generic management content within the original STDIO card.
 */
export function StdioV2Panel({ state, sessions, approvalUrl, onUnavailable, onInstalledChange, t }: StdioV2PanelProps): ReactNode {
  const storedView = useSyncExternalStore(state.subscribe, state.getSnapshot)
  const subscribeToSessions = useCallback((listener: () => void) => sessions.list.subscribe(listener), [sessions.list])
  const readSessions = useCallback(() => sessions.list.getSnapshot(), [sessions.list])
  const snapshot = useSyncExternalStore(subscribeToSessions, readSessions)
  const [sessionId, setSessionId] = useState('')
  const [edited, setEdited] = useState<StdioConnectionV2>()
  const [fields, setFields] = useState(blank)
  const [invalid, setInvalid] = useState(false)
  const [approval, setApproval] = useState<string>()
  const [approvalFailed, setApprovalFailed] = useState(false)
  const mounted = useRef(false)
  const sameSession = snapshot.phase === 'ready' && snapshot.ids.includes(storedView.sessionId) && storedView.sessionId === sessionId
  const view = sameSession ? storedView : { ...storedView, sessionId: '', connections: undefined, actions: undefined,
    detail: undefined, pending: undefined, pendingCancel: undefined, receipt: undefined, error: undefined, backendCode: undefined }
  const visibleFields = sameSession ? fields : blank
  useEffect(() => {
    let active = true
    mounted.current = true
    state.select(sessionId, snapshot.phase === 'ready' ? snapshot.ids : [])
    void state.load().then((available) => {
      if (!active) return
      const connections = state.getSnapshot().connections
      if (available === false) onUnavailable?.()
      else if (available === true && connections) onInstalledChange?.(connections.items.length > 0)
    })
    return () => { active = false; mounted.current = false; state.stop() }
  }, [state, sessionId, snapshot, onUnavailable, onInstalledChange])
  useEffect(() => { setEdited(undefined); setFields(blank); setInvalid(false) }, [view.sessionId])
  useEffect(() => {
    let active = true
    setApproval(undefined); setApprovalFailed(false)
    void approvalUrl().then((value) => {
      const url = new URL(value)
      if (url.username || url.password || url.pathname !== '/approval' || url.search || url.hash
        || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error('Invalid approval destination')
      }
      if (active) setApproval(url.href)
    }).catch(() => { if (active) setApprovalFailed(true) })
    return () => { active = false }
  }, [approvalUrl])
  const config = view.config
  const connectionCursor = view.connections?.next
  const actionOffset = view.actions?.nextOffset
  const disabled = view.busy || view.pending !== undefined || !view.sessionId || !config?.available
  const edit = (item?: StdioConnectionV2): void => {
    setEdited(item); setInvalid(false)
    setFields(item ? { name: item.configuration.name, program: item.configuration.invocation.program,
      argv: JSON.stringify(item.configuration.invocation.argv), cwd: item.configuration.invocation.cwd } : blank)
  }
  const save = (): void => {
    if (!config?.available || disabled) return
    try {
      const configuration = stdioV2Configuration(fields, config), schemas = stdioManagementSchemasV2(config.limits, config.management)
      const requestId = randomUUID()
      void state.submit(edited ? { kind: 'update', input: schemas.update.parse({ requestId,
        connectionId: edited.connectionId, expectedRevision: edited.revision, configuration }) }
        : { kind: 'create', input: schemas.create.parse({ requestId, configuration }) })
      setInvalid(false)
    } catch (_invalidFields) { setInvalid(true) }
  }
  const change = (key: keyof typeof blank, value: string): void => { setFields(current => ({ ...current, [key]: value })) }
  const reload = (after?: StdioConnectionV2['connectionId'], offset = 0): void => {
    void state.load(after, offset).then((available) => {
      if (!mounted.current) return
      const connections = state.getSnapshot().connections
      if (available === false) onUnavailable?.()
      else if (available === true && after === undefined && connections) onInstalledChange?.(connections.items.length > 0)
    })
  }
  return <section className="pext-plugin-detail-content" data-power-evolve-stdio-v2-panel>
    <h1>{t('stdioV2Title')}</h1><p>{t('stdioV2Notice')}</p>
    <label>{t('stdioV2Session')}<select value={snapshot.ids.includes(sessionId) ? sessionId : ''}
      disabled={snapshot.phase !== 'ready'} onChange={(event) => { setSessionId(event.target.value) }}>
      <option value="">{t('stdioV2SelectSession')}</option>
      {snapshot.ids.map(id => <option key={id} value={id}>{snapshot.byId[id]?.displayTitle ?? id}</option>)}
    </select></label>
    <p>{t('stdioV2Cloud')}</p>
    {config?.available === false && <p role="status">{t('stdioV2Unavailable')}</p>}
    {view.busy && <p role="status">{t('pluginLoading')}</p>}
    <button type="button" disabled={view.busy} onClick={() => { reload() }}>{t('refreshList')}</button>
    {view.error && <p role="alert">{t(view.error === 'expired' ? 'sessionExpired'
      : view.error === 'uncertain' ? 'stdioV2Uncertain' : 'stdioLoadFailed')}</p>}
    {view.backendCode && <pre>{view.backendCode}</pre>}
    {view.pending && <div><pre>{view.pending.input.requestId}</pre>
      <button type="button" disabled={view.busy} onClick={() => { void state.reconcile() }}>{t('stdioV2ReadReceipt')}</button></div>}
    {view.receipt && <div><p>{t('stdioV2ReceiptNotice')}</p><pre data-stdio-v2-receipt>{JSON.stringify(view.receipt, null, 2)}</pre></div>}
    <h2>{t('stdioV2Connections')}</h2>
    {view.connections?.items.map(item => <div key={item.connectionId} className="pext-plugin-detail-setting">
      <strong>{item.configuration.name}</strong><span>{t('revision').replace('{count}', String(item.revision))}</span>
      {config?.available && <>
        <SkillToggle label={`${item.configuration.name} ${t('pluginEnable')}`} checked={item.enabled}
          disabled={disabled || !item.enabled && item.catalogId === null} onChange={(enabled) => {
            void state.submit({ kind: 'toggle', input: stdioManagementSchemasV2(config.limits, config.management)
              .toggle.parse({ requestId: randomUUID(), connectionId: item.connectionId, expectedRevision: item.revision, enabled }) })
          }} />
        <button type="button" disabled={disabled} onClick={() => { edit(item) }}>{t('stdioV2Edit')}</button>
        <button type="button" disabled={disabled} onClick={() => {
          void state.submit({ kind: 'check', input: stdioCheckRequestV2.parse({ requestId: randomUUID(),
            connectionId: item.connectionId, expectedRevision: item.revision, sessionId: view.sessionId, target: { kind: 'cloud' } }) })
        }}>{t('stdioV2Check')}</button>
        <button type="button" disabled={disabled} onClick={() => {
          void state.submit({ kind: 'delete', input: stdioManagementSchemasV2(config.limits, config.management)
            .remove.parse({ requestId: randomUUID(), connectionId: item.connectionId, expectedRevision: item.revision }) })
        }}>{t('stdioV2Delete')}</button>
      </>}
    </div>)}
    {connectionCursor && <button type="button" disabled={view.busy}
      onClick={() => { reload(connectionCursor) }}>{t('stdioV2NextConnections')}</button>}
    <button type="button" disabled={disabled} onClick={() => { edit() }}>{t('stdioV2New')}</button>
    <fieldset disabled={disabled}><legend>{t(edited ? 'stdioV2Edit' : 'stdioV2New')}</legend>
      <label>{t('mcpConnectionName')}<input value={visibleFields.name} onChange={(event) => { change('name', event.target.value) }} /></label>
      <label>{t('stdioV2Program')}<input value={visibleFields.program} onChange={(event) => { change('program', event.target.value) }} /></label>
      <label>{t('stdioV2Argv')}<textarea value={visibleFields.argv} onChange={(event) => { change('argv', event.target.value) }} /></label>
      <label>{t('stdioV2Cwd')}<input value={visibleFields.cwd} onChange={(event) => { change('cwd', event.target.value) }} /></label>
      <p>{t('stdioV2Literal')}</p><button type="button" onClick={save}>{t('stdioV2Save')}</button>
    </fieldset>
    {invalid && <p role="alert">{t('stdioV2Invalid')}</p>}
    <h2>{t('stdioRecentCalls')}</h2><p>{t('stdioV2CancelNotice')}</p>
    {view.actions?.items.map(item => <div key={item.actionId}>
      <pre>{item.phase}: {item.state} / {item.executionState}</pre>
      <button type="button" disabled={view.busy} onClick={() => { void state.detail(item.actionId) }}>{t('stdioV2Details')}</button>
      <button type="button" disabled={view.busy || view.pendingCancel === item.actionId || item.cancelRequested || ['succeeded', 'failed', 'cancelled'].includes(item.state)}
        onClick={() => { void state.cancel(item.actionId) }}>{t('stdioV2Cancel')}</button>
    </div>)}
    {actionOffset !== null && actionOffset !== undefined && <button type="button" disabled={view.busy}
      onClick={() => { reload(undefined, actionOffset) }}>{t('stdioV2NextActions')}</button>}
    {view.detail && <pre data-stdio-v2-detail>{JSON.stringify(view.detail, null, 2)}</pre>}
    {approval ? <a href={approval} target="_blank" rel="noopener noreferrer">{t('openApproval')}</a>
      : approvalFailed ? <p role="alert">{t('approvalUnavailable')}</p> : null}
  </section>
}
