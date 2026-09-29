import { IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { FixedMcpHttpError, type FixedMcpConnection, type FixedMcpList, type FixedMcpPort,
  type FixedMcpToggle } from './mcp-api.ts'
import { SkillToggle } from './SkillToggle.tsx'

type Translate = TranslateNS<'powerEvolve.extensionCenter'>

/** Personal connection management for one operator-fixed read-only MCP preset. */
export function PersonalMcpPage({ data, port, onChange, onReload, t }: {
  readonly data: FixedMcpList
  readonly port: FixedMcpPort
  readonly onChange: (items: readonly FixedMcpConnection[]) => void
  readonly onReload: () => void
  readonly t: Translate
}): ReactNode {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [installOpen, setInstallOpen] = useState(false)
  const [name, setName] = useState('')
  const [pendingInstall, setPendingInstall] = useState<{ requestId: string; name: string }>()
  const [pendingToggle, setPendingToggle] = useState<FixedMcpToggle>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [checkBusy, setCheckBusy] = useState(false)
  const [checkResult, setCheckResult] = useState<string>()
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return needle === '' ? data.items : data.items.filter(item =>
      [item.name, item.description, item.toolName].some(value => value.toLocaleLowerCase().includes(needle)))
  }, [data.items, search])
  const selected = data.items.find(item => item.connectionId === selectedId)

  const install = async (input: { requestId: string; name: string }): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const item = await port.install(input)
      onChange([...data.items.filter(row => row.connectionId !== item.connectionId), item])
      setPendingInstall(undefined); setInstallOpen(false); setName('')
    } catch (cause) {
      if (cause instanceof FixedMcpHttpError && cause.status === 409) {
        setPendingInstall(undefined); setError(t('mcpRevisionConflict'))
      } else if (cause instanceof FixedMcpHttpError && cause.status === 401) {
        setPendingInstall(undefined); setError(t('sessionExpired'))
      } else {
        setPendingInstall(input); setError(t('mcpInstallUncertain'))
      }
    } finally { setBusy(false) }
  }

  const toggle = async (input: FixedMcpToggle): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const item = await port.toggle(input)
      onChange(data.items.map(row => row.connectionId === item.connectionId ? item : row))
      setPendingToggle(undefined)
    } catch (cause) {
      if (cause instanceof FixedMcpHttpError && cause.status === 409) {
        setPendingToggle(undefined); setError(t('mcpRevisionConflict'))
      } else if (cause instanceof FixedMcpHttpError && cause.status === 401) {
        setPendingToggle(undefined); setError(t('sessionExpired'))
      } else {
        setPendingToggle(input); setError(t('mcpToggleUncertain'))
      }
    } finally { setBusy(false) }
  }

  const check = async (connectionId: string): Promise<void> => {
    if (checkBusy) return
    setCheckBusy(true); setCheckResult(undefined); setError(undefined)
    try { setCheckResult((await port.check(connectionId)).result) }
    catch (cause) { setError(cause instanceof FixedMcpHttpError && cause.status === 401
      ? t('sessionExpired') : t('mcpCheckFailed')) }
    finally { setCheckBusy(false) }
  }

  if (selected) {
    return <section className="pext-plugin-detail-content" data-power-evolve-mcp-connection={selected.connectionId}>
      <button type="button" className="pext-card-action" onClick={() => {
        setSelectedId(undefined); setCheckResult(undefined); setError(undefined) }}>{t('mcpBackToConnections')}</button>
      <div className="pext-plugin-detail-heading"><div><h1>{selected.name}</h1><p>{selected.description}</p></div></div>
      <div className="pext-plugin-detail-setting"><div><strong>{t('pluginAccess')}</strong>
        <p>{t('mcpNextTaskNotice')}</p></div>
        <SkillToggle label={`${selected.name} ${t('pluginEnable')}`} checked={selected.enabled}
          disabled={busy || pendingToggle !== undefined || !data.available}
          onChange={enabled => { void toggle({ connectionId: selected.connectionId,
            requestId: crypto.randomUUID(), baseRevision: selected.revision, enabled }) }} /></div>
      <div className="pext-plugin-detail-setting"><div><strong>{t('mcpCheckTitle')}</strong>
        <p>{t('mcpCheckHint')}</p></div>
        <button type="button" className="pext-dialog-button" disabled={checkBusy || busy || !selected.enabled || !data.available}
          onClick={() => { void check(selected.connectionId) }}>
          {checkBusy ? t('mcpChecking') : t('mcpStartCheck')}</button></div>
      {checkResult !== undefined && <div className="pext-mcp-check-result" role="status">
        <strong>{t('mcpCheckSucceeded')}</strong><pre>{checkResult}</pre></div>}
      {error && <div className="pext-error" role="alert">{error}</div>}
      {pendingToggle && <button type="button" className="pext-dialog-button" disabled={busy}
        onClick={() => { void toggle(pendingToggle) }}>{t('mcpRetryToggle')}</button>}
      <p className="pext-plugin-revision">{t('revision').replace('{count}', String(selected.revision))}</p>
    </section>
  }

  return <section className="pext-plugin-detail-content pext-mcp-connections" data-power-evolve-mcp-page>
    <div className="pext-mcp-header"><div><h1>MCP</h1><p>{t('mcpFixedDescription')}</p></div>
      <button type="button" className="pext-dialog-button pext-dialog-button-primary"
        disabled={!data.available || data.items.length > 0 || busy || pendingInstall !== undefined}
        onClick={() => { setInstallOpen(true); setError(undefined) }}>
        <IconPlusOutlineRegular size={15} />{t(data.items.length > 0 ? 'mcpInstalled' : 'mcpInstall')}</button></div>
    <p className="pext-catalog-note">{t('mcpFixedNotice')}</p>
    <p className="pext-mcp-preset">{data.preset.description} <code>{data.preset.toolName}</code></p>
    <label className="pext-catalog-search"><span className="pext-visually-hidden">{t('mcpSearch')}</span>
      <IconSearchOutlineRegular size={17} /><input type="search" value={search}
        placeholder={t('mcpSearch')} onChange={event => { setSearch(event.target.value) }} /></label>
    <div className="pext-catalog-filter-row"><strong>{t('mcpMyConnections').replace('{count}', String(data.items.length))}</strong>
      <button type="button" className="pext-card-action" onClick={onReload}>{t('refreshList')}</button></div>
    {!data.available && <div className="pext-error" role="status">{t('mcpUnavailable')}</div>}
    {error && <div className="pext-error" role="alert">{error}</div>}
    {visible.length === 0 ? <div className="pext-empty">{search ? t('mcpNoMatch') : t('mcpEmpty')}</div>
      : <div className="pext-mcp-list">{visible.map(item => <article className="pext-mcp-row" key={item.connectionId}>
        <button type="button" className="pext-extension-title" onClick={() => {
          setSelectedId(item.connectionId); setError(undefined); setCheckResult(undefined) }}>{item.name}</button>
        <span className="pext-extension-badge" data-enabled={item.enabled || undefined}>
          {t(item.enabled ? 'enabledState' : 'disabledState')}</span>
        <p>{item.description}</p><small>{item.toolName}</small>
      </article>)}</div>}
    {installOpen && <div className="pext-mcp-install" role="group" aria-label={t('mcpInstall')}>
      <label>{t('mcpConnectionName')}<input value={name} maxLength={80}
        disabled={busy || pendingInstall !== undefined} onChange={event => { setName(event.target.value) }} /></label>
      <div><button type="button" className="pext-dialog-button" onClick={() => {
        setInstallOpen(false); setPendingInstall(undefined); setError(undefined) }}>{t('cancel')}</button>
        <button type="button" className="pext-dialog-button pext-dialog-button-primary"
          disabled={busy || pendingInstall !== undefined || !name.trim()}
          onClick={() => { void install({ requestId: crypto.randomUUID(), name: name.trim() }) }}>
          {t('mcpInstall')}</button></div>
      {pendingInstall && <button type="button" className="pext-dialog-button" disabled={busy}
        onClick={() => { void install(pendingInstall) }}>{t('mcpRetryInstall')}</button>}
    </div>}
  </section>
}
