import { useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SkillToggle } from './SkillToggle.tsx'
import { StdioMcpHttpError, type StdioMcpCall, type StdioMcpConnection,
  type StdioMcpList, type StdioMcpPort } from './stdio-mcp-api.ts'
import { StdioV2Panel, type StdioV2PanelProps } from './StdioV2Panel.tsx'

type Translate = TranslateNS<'powerEvolve.extensionCenter'>
type Toggle = { connectionId: string; requestId: string; baseRevision: number; enabled: boolean }

function stateLabel(state: string, t: Translate): string {
  switch (state) {
    case 'accepted': return t('stdioAccepted')
    case 'preparing': case 'ready': return t('stdioPreparing')
    case 'dispatch-intent': case 'running': return t('stdioRunning')
    case 'succeeded': return t('stdioSucceeded')
    case 'failed': return t('stdioFailed')
    default: return t('stdioUncertain')
  }
}

/** Manage one fixed process MCP connection on the existing native Plugins page. */
export function StdioMcpPage({ data, port, onChange, t, generic }: {
  readonly data?: StdioMcpList | undefined
  readonly port: StdioMcpPort
  readonly onChange: (items: readonly StdioMcpConnection[]) => void
  readonly t: Translate
  readonly generic?: Omit<StdioV2PanelProps, 't'> | undefined
}): ReactNode {
  return generic ? <StdioV2Panel {...generic} t={t} />
    : data ? <LegacyStdioMcpPage data={data} port={port} onChange={onChange} t={t} /> : null
}

function LegacyStdioMcpPage({ data, port, onChange, t }: {
  readonly data: StdioMcpList; readonly port: StdioMcpPort
  readonly onChange: (items: readonly StdioMcpConnection[]) => void; readonly t: Translate
}): ReactNode {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [pendingInstall, setPendingInstall] = useState<{ requestId: string; name: string }>()
  const [pendingToggle, setPendingToggle] = useState<Toggle>()
  const [calls, setCalls] = useState<readonly StdioMcpCall[]>([])
  const [callsBusy, setCallsBusy] = useState(false)
  const connection = data.items[0]

  const refreshCalls = async (): Promise<void> => {
    setCallsBusy(true)
    try { setCalls((await port.calls()).items) }
    catch (_unavailable) { setError(t('stdioCallsFailed')) }
    finally { setCallsBusy(false) }
  }
  useEffect(() => { void refreshCalls() }, [port])

  const install = async (input: { requestId: string; name: string }): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const item = await port.install(input)
      onChange([item]); setPendingInstall(undefined); setName('')
    } catch (cause) {
      if (cause instanceof StdioMcpHttpError && cause.status === 409) {
        setPendingInstall(undefined); setError(t('mcpRevisionConflict'))
      } else {
        setPendingInstall(input); setError(cause instanceof StdioMcpHttpError && cause.status === 401
          ? t('sessionExpired') : t('mcpInstallUncertain'))
      }
    } finally { setBusy(false) }
  }
  const toggle = async (input: Toggle): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const item = await port.toggle(input)
      onChange([item]); setPendingToggle(undefined)
    } catch (cause) {
      if (cause instanceof StdioMcpHttpError && cause.status === 409) {
        setPendingToggle(undefined); setError(t('mcpRevisionConflict'))
      } else {
        setPendingToggle(input); setError(cause instanceof StdioMcpHttpError && cause.status === 401
          ? t('sessionExpired') : t('mcpToggleUncertain'))
      }
    } finally { setBusy(false) }
  }

  return <section className="pext-plugin-detail-content" data-power-evolve-stdio-mcp-page>
    <div className="pext-plugin-detail-heading"><div><h1>{t('stdioMcpTitle')}</h1>
      <p>{t('stdioMcpDescription')}</p></div></div>
    <p className="pext-catalog-note">{t('stdioMcpNotice')}</p>
    {!data.available && <div className="pext-error" role="alert">{t('stdioMcpUnavailable')}</div>}
    {connection ? <>
      <div className="pext-plugin-detail-setting"><div><strong>{connection.name}</strong>
        <p>{connection.description}</p></div>
        <SkillToggle label={`${connection.name} ${t('pluginEnable')}`} checked={connection.enabled}
          disabled={busy || pendingToggle !== undefined || !data.available}
          onChange={enabled => { void toggle({ connectionId: connection.connectionId,
            requestId: crypto.randomUUID(), baseRevision: connection.revision, enabled }) }} /></div>
      <p className="pext-plugin-revision">{t('revision').replace('{count}', String(connection.revision))}</p>
    </> : <div className="pext-plugin-detail-setting"><label>{t('mcpConnectionName')}
      <input value={name} maxLength={80} onChange={event => { setName(event.target.value) }} /></label>
      <button type="button" className="pext-dialog-button" disabled={!data.available || busy || !name.trim() || !!pendingInstall}
        onClick={() => { void install({ requestId: crypto.randomUUID(), name: name.trim() }) }}>
        {t('mcpInstall')}</button></div>}
    {error && <div className="pext-error" role="alert">{error}</div>}
    {pendingInstall && <button type="button" className="pext-dialog-button" disabled={busy}
      onClick={() => { void install(pendingInstall) }}>{t('mcpRetryInstall')}</button>}
    {pendingToggle && <button type="button" className="pext-dialog-button" disabled={busy}
      onClick={() => { void toggle(pendingToggle) }}>{t('mcpRetryToggle')}</button>}
    <div className="pext-plugin-detail-setting"><div><strong>{t('stdioRecentCalls')}</strong>
      <p>{t('stdioResultHint')}</p></div><button type="button" className="pext-card-action"
        disabled={callsBusy} onClick={() => { void refreshCalls() }}>{t('refreshList')}</button></div>
    {calls.length ? <div>{calls.slice(0, 20).map(call => <div key={call.callId} className="pext-mcp-check-result">
      <strong>{stateLabel(call.state, t)}</strong><pre>{call.result ?? call.errorCode ?? call.callId}</pre>
    </div>)}</div> : <p className="pext-catalog-note">{t('stdioNoCalls')}</p>}
  </section>
}
