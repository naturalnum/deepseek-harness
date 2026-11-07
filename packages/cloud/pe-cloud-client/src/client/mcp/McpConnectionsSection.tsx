/** Account MCP form inside the original native Settings shell; no separate account cache or transport. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudMcpConnectionReply, CloudMcpConnectionRequest, CloudMcpConnectionView } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type {} from './locales.ts'
import css from '../remote-servers/servers.module.css'

/** Captured current-account connection operation and page identity. */
export interface McpConnectionsInjected {
  readonly scope: string
  call(this: void, request: CloudMcpConnectionRequest): Promise<CloudMcpConnectionReply>
}
/** Native settings slot props plus the account-owned Remote adapter. */
export type McpConnectionsProps = PropsRuntime<'settings.section'> & PropsLocale<'cloud-mcp-settings'> & InjectFace<McpConnectionsInjected>

/** Mount a fresh form whenever the original account page changes.
 * @param props Native slot, locale and account operation adapter.
 * @returns HTTP MCP configuration content in the original Settings shell.
 */
export function McpConnectionsSection(props: McpConnectionsProps): ReactNode { return <McpConnectionsBody key={props.scope} {...props}/> }

function McpConnectionsBody({ t, call }: McpConnectionsProps): ReactNode {
  const [reply, setReply] = useState<CloudMcpConnectionReply>()
  const [probe, setProbe] = useState<CloudMcpConnectionReply['test']>()
  const [editing, setEditing] = useState<CloudMcpConnectionView>()
  const [serverName, setServerName] = useState(''), [url, setUrl] = useState('')
  const [token, setToken] = useState(''), [headers, setHeaders] = useState(''), [clearHeaders, setClearHeaders] = useState(false)
  const [timeout, setTimeoutValue] = useState(0), [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [removing, setRemoving] = useState<CloudMcpConnectionView>()
  const alive = useRef(true), pending = useRef(false)
  const mounted = (): boolean => alive.current
  const request = async (input: CloudMcpConnectionRequest): Promise<boolean> => {
    if (!mounted() || pending.current) return false
    pending.current = true; setBusy(true); setError(''); setProbe(undefined)
    try {
      const value = await call(input)
      if (!mounted()) return false
      if (reply === undefined) setTimeoutValue(value.limits.maxToolCallTimeoutMs)
      setReply(value); setProbe(value.test); return true
    } catch (_error) { if (mounted()) setError(t('failed')); return false }
    finally { pending.current = false; if (mounted()) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true; void request({ action: 'list' })
    return () => { alive.current = false }
  }, [])
  const reset = (): void => {
    setProbe(undefined); setEditing(undefined); setServerName(''); setUrl(''); setToken(''); setHeaders(''); setClearHeaders(false)
    setTimeoutValue(reply?.limits.maxToolCallTimeoutMs ?? 0); setEnabled(true)
  }
  const edit = (row: CloudMcpConnectionView): void => {
    setProbe(undefined); setEditing(row); setServerName(row.serverName); setUrl(row.url); setTimeoutValue(row.toolCallTimeoutMs)
    setEnabled(row.enabled); setToken(''); setHeaders(''); setClearHeaders(false)
  }
  const connection = (): Extract<CloudMcpConnectionRequest, { action: 'save' }>['connection'] | undefined => {
    let parsed: Record<string, string> | undefined
    if (headers.trim()) {
      try {
        const raw: unknown = JSON.parse(headers)
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.values(raw).some(value => typeof value !== 'string')) {
          setError(t('invalidHeaders')); return undefined
        }
        parsed = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]))
      } catch (_error) { setError(t('invalidHeaders')); return undefined }
    }
    if (token) parsed = { ...parsed, Authorization: 'Bearer ' + token }
    if (clearHeaders) parsed = {}
    return { serverName, url, enabled, toolCallTimeoutMs: timeout, ...parsed === undefined ? {} : { headers: parsed } }
  }
  const save = async (): Promise<void> => {
    const value = connection()
    if (value === undefined || reply === undefined) return
    if (await request({ action: 'save', version: reply.version, ...editing === undefined ? {} : { id: editing.id }, connection: value })) reset()
  }
  const test = async (): Promise<void> => {
    const value = connection()
    if (value !== undefined) await request({ action: 'test', ...editing === undefined ? {} : { id: editing.id }, connection: value })
  }
  const valid = /^[A-Za-z0-9_-]{1,32}$/.test(serverName) && /^https?:\/\//.test(url) && Number.isSafeInteger(timeout) && timeout > 0
    && reply !== undefined && timeout <= reply.limits.maxToolCallTimeoutMs
  return <section className={css.section} aria-label={t('title')}>
    <header><h2>{t('title')}</h2><Button disabled={busy} onClick={() => { void request({ action: 'list' }) }}>{t('refresh')}</Button></header>
    <p>{t('intro')}</p><p className={css.note}>{t('httpHint')}</p>
    {error && <p role="alert" className={css.error}>{error}</p>}
    {busy && <p role="status">{t(reply === undefined ? 'loading' : 'pending')}</p>}
    {reply?.connections.length === 0 && <p>{t('empty')}</p>}
    <div className={css.list}>{reply?.connections.map(row => <article className={css.card} key={row.id}>
      <header><strong>{row.serverName}</strong><span>{t(row.enabled ? 'enabled' : 'disabled')}</span></header>
      <p>{row.url}</p><p>{t(row.configured ? 'headersStored' : 'noHeaders')} · {t('toolCount', { count: row.toolCount })}</p>
      <div className={css.actions}>
        <Button disabled={busy} onClick={() => { edit(row) }}>{t('edit')}</Button>
        <Button disabled={busy} onClick={() => { void request({ action: 'enabled', id: row.id,
          version: reply.version, enabled: !row.enabled }) }}>{t(row.enabled ? 'disable' : 'enable')}</Button>
        <Button disabled={busy} onClick={() => { setRemoving(row) }}>{t('remove')}</Button>
      </div>
      {removing?.id === row.id && <div><p>{t('removeHint')}</p><div className={css.actions}>
        <Button disabled={busy} onClick={() => { void request({ action: 'remove', id: row.id, version: reply.version })
          .then((applied) => { if (applied && mounted()) { setRemoving(undefined); if (editing?.id === row.id) reset() } }) }}>{t('removeConfirm')}</Button>
        <Button disabled={busy} onClick={() => { setRemoving(undefined) }}>{t('cancel')}</Button>
      </div></div>}
    </article>)}</div>
    <form className={css.form} onChange={() => { setProbe(undefined) }} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h3>{t(editing === undefined ? 'add' : 'edit')}</h3>
      <label>{t('serverName')}<Input value={serverName} disabled={busy} onChange={(event) => { setServerName(event.target.value) }}/></label>
      <label>{t('url')}<Input value={url} disabled={busy} onChange={(event) => { setUrl(event.target.value) }}/></label>
      <label>{t('token')}<Input type="password" autoComplete="new-password" value={token} disabled={busy || clearHeaders}
        onChange={(event) => { setToken(event.target.value) }}/></label>
      <label>{t('headers')}<textarea value={headers} disabled={busy || clearHeaders}
        onChange={(event) => { setHeaders(event.target.value) }}/></label>
      <p className={css.note}>{t('credentialsHint')}</p>
      <label><input type="checkbox" checked={clearHeaders} disabled={busy}
        onChange={(event) => { setClearHeaders(event.target.checked) }}/>{t('clearHeaders')}</label>
      <label>{t('timeout')}<Input type="number" min={1} max={reply?.limits.maxToolCallTimeoutMs} value={timeout} disabled={busy}
        onChange={(event) => { setTimeoutValue(Number(event.target.value)) }}/></label>
      <label><input type="checkbox" checked={enabled} disabled={busy}
        onChange={(event) => { setEnabled(event.target.checked) }}/>{t('enabled')}</label>
      <div className={css.actions}>
        <Button type="submit" disabled={busy || !valid}>{t('save')}</Button>
        <Button type="button" disabled={busy || !valid} onClick={() => { void test() }}>{t('test')}</Button>
        <Button type="button" disabled={busy} onClick={reset}>{t('cancel')}</Button>
      </div>
      {probe !== undefined && <p role="status">{t(probe.reachable ? 'reachable' : 'unreachable')}
        {probe.reachable && <> · {t('toolCount', { count: probe.toolCount })}</>}</p>}
    </form>
  </section>
}
