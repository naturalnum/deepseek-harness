/** Account-bound settings presentation; execution stays in the original chat tool flow. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteServerForm, RemoteServerReply, RemoteServerRequest,
  RemoteServerView } from '@deepseek-ai/dsh-pe-cloud-api/types'
import type {} from './locales.ts'
import css from './servers.module.css'

/** Captured generated Remote and immutable page lifetime; no secondary transport or account cache. */
export interface RemoteServersInjected {
  readonly scope: string
  call(this: void, request: RemoteServerRequest): Promise<RemoteServerReply>
}
export type RemoteServersProps = PropsRuntime<'settings.section'> & PropsLocale<'cloud-remote-servers'> & InjectFace<RemoteServersInjected>
const factFields = ['hostname', 'os', 'kernel', 'arch', 'cpuModel', 'cpuCores', 'memTotalKb', 'memAvailableKb',
  'diskTotalKb', 'diskAvailableKb', 'uptimeSeconds', 'collectedAt'] as const
const emptyForm = (): RemoteServerForm => ({ alias: '', host: '', user: '', port: 22, description: '', tags: [], alwaysAsk: false })
/** Reset all form/file state when the original account page changes.
 * @param props Original slot, locale and captured account adapter.
 * @returns Native settings content.
 */
export function ServersSection(props: RemoteServersProps): ReactNode { return <ServersBody key={props.scope} {...props}/> }
function ServersBody({ t, call }: RemoteServersProps): ReactNode {
  const [rows, setRows] = useState<readonly RemoteServerView[]>([]), [form, setForm] = useState<RemoteServerForm>(emptyForm)
  const [editing, setEditing] = useState<string>(), [credentialId, setCredentialId] = useState<string>()
  const [limits, setLimits] = useState<RemoteServerReply['limits']>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const keyInput = useRef<HTMLInputElement>(null), knownInput = useRef<HTMLInputElement>(null), importInput = useRef<HTMLInputElement>(null)
  const alive = useRef(true), pending = useRef(false)
  const active = (): boolean => alive.current
  const request = async (input: RemoteServerRequest | (() => Promise<RemoteServerRequest>)): Promise<boolean> => {
    if (pending.current || !active()) return false
    pending.current = true; setBusy(true); setError('')
    try {
      const request = typeof input === 'function' ? await input() : input
      if (!active()) return false
      const value = await call(request)
      if (!active()) return false
      setRows(value.servers); setLimits(value.limits); return true
    } catch (_error) { if (active()) setError(t('failed')); return false }
    finally { pending.current = false; if (active()) setBusy(false) }
  }
  useEffect(() => { alive.current = true; void request({ action: 'list' }); return () => { alive.current = false } }, [])
  const field = (key: 'alias' | 'host' | 'user' | 'description') => <label>{t(key)}<Input value={form[key]} disabled={busy}
    onChange={(event) =>{  setForm({ ...form, [key]: event.target.value }) }}/></label>
  const chooseCredential = (id: string): void => {
    if (keyInput.current) keyInput.current.value = ''; if (knownInput.current) knownInput.current.value = ''
    setCredentialId(id)
  }
  const edit = (row: RemoteServerView): void => { setEditing(row.entry.id); const { id: _id, ...value } = row.entry; setForm(value) }
  const save = async (): Promise<void> => {
    if (await request(editing === undefined ? { action: 'add', entry: form } : { action: 'update', id: editing, entry: form })) {
      setEditing(undefined); setForm(emptyForm())
    }
  }
  const move = (index: number, delta: number): void => {
    const ids = rows.map(row => row.entry.id), other = index + delta
    if (other < 0 || other >= ids.length) return
    const id = ids[index], adjacent = ids[other]
    if (id === undefined || adjacent === undefined) return
    ids[index] = adjacent; ids[other] = id
    void request({ action: 'reorder', ids })
  }
  const upload = async (): Promise<void> => {
    const key = keyInput.current?.files?.[0], hosts = knownInput.current?.files?.[0]
    if (key === undefined || hosts === undefined || credentialId === undefined || limits === undefined
      || key.size > limits.maxPrivateKeyBytes || hosts.size > limits.maxKnownHostsBytes) { setError(t('chooseFiles')); return }
    try {
      await request(async () => ({ action: 'credential', id: credentialId, privateKey: await key.text(), knownHosts: await hosts.text() }))
    } catch (_error) { if (active()) setError(t('failed')) }
    finally { if (keyInput.current) keyInput.current.value = ''; if (knownInput.current) knownInput.current.value = '' }
  }
  const importConfig = async (): Promise<void> => {
    const file = importInput.current?.files?.[0]
    if (file === undefined || limits === undefined || file.size > limits.maxImportBytes) { setError(t('failed')); return }
    try { await request(async () => ({ action: 'import', text: await file.text() })) }
    catch (_error) { if (active()) setError(t('failed')) }
    finally { if (importInput.current) importInput.current.value = '' }
  }
  return <section className={css.section} aria-label={t('title')}>
    <header><h2>{t('title')}</h2><Button disabled={busy} onClick={() => { void request({ action: 'list' }) }}>{t('refresh')}</Button></header>
    <p>{t('intro')}</p><p className={css.note}>{t('chatHint')}</p><p className={css.note}>{t('approvalHint')}</p>
    {error && <p role="alert" className={css.error}>{error}</p>}
    {busy && <p role="status">{t('pending')}</p>}
    {!rows.length && !busy && <p>{t('empty')}</p>}
    <div className={css.list}>{rows.map((row, index) => <article key={row.entry.id} className={css.card}>
      <header><strong>{row.entry.alias}</strong><span>{row.entry.user}@{row.entry.host}:{row.entry.port}</span></header>
      <p>{row.entry.description}</p>
      <p>{t(row.configured ? 'keyStored' : 'keyNeeded')} · {t(row.connectivity === undefined ? 'unknown' : row.connectivity.reachable ? 'reachable' : 'unreachable')}
        {row.connectivity && <time dateTime={row.connectivity.checkedAt}> {row.connectivity.checkedAt}</time>}</p>
      {row.factsOmitted && <p>{t('factsOmitted')}</p>}
      {row.facts && <details><summary>{t('facts')}</summary><dl className={css.facts}>{factFields.map(key =>
        <div key={key}><dt>{t(key)}</dt><dd>{row.facts?.[key] ?? t('unknown')}</dd></div>)}</dl></details>}
      <div className={css.actions}>
        <Button disabled={busy} onClick={() =>{  edit(row) }}>{t('edit')}</Button>
        <Button disabled={busy} onClick={() =>{  chooseCredential(row.entry.id) }}>{t('upload')}</Button>
        <Button disabled={busy || index === 0} onClick={() =>{  move(index, -1) }}>{t('up')}</Button>
        <Button disabled={busy || index === rows.length - 1} onClick={() =>{  move(index, 1) }}>{t('down')}</Button>
        <Button disabled={busy} onClick={() => { void request({ action: 'remove', id: row.entry.id }) }}>{t('remove')}</Button>
      </div>
    </article>)}</div>
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h3>{t(editing === undefined ? 'add' : 'edit')}</h3>{field('alias')}{field('host')}{field('user')}
      <label>{t('port')}<Input type="number" min={1} max={65535} value={form.port} disabled={busy}
        onChange={(event) =>{  setForm({ ...form, port: Number(event.target.value) }) }}/></label>
      {field('description')}<label>{t('tags')}<Input value={form.tags.join(', ')} disabled={busy}
        onChange={(event) =>{  setForm({ ...form,
          tags: event.target.value.split(',').map(value => value.trim()).filter(Boolean) }) }}/></label>
      <label><input type="checkbox" checked={form.alwaysAsk} disabled={busy}
        onChange={(event) =>{  setForm({ ...form, alwaysAsk: event.target.checked }) }}/>{t('alwaysAsk')}</label>
      <div className={css.actions}><Button type="submit" disabled={busy || !form.alias || !form.host || !form.user}>{t('save')}</Button>
        {editing && <Button type="button" onClick={() => { setEditing(undefined); setForm(emptyForm()) }}>{t('cancel')}</Button>}</div>
    </form>
    {credentialId && <div className={css.form}><h3>{rows.find(row => row.entry.id === credentialId)?.entry.alias}</h3><p>{t('credentialsHint')}</p>
      <label>{t('key')}<Input type="file" ref={keyInput} disabled={busy}/></label>
      <label>{t('knownHosts')}<Input type="file" ref={knownInput} disabled={busy}/></label>
      <Button disabled={busy} onClick={() => { void upload() }}>{t('upload')}</Button>
    </div>}
    <div className={css.form}><label>{t('import')}<Input type="file" ref={importInput} disabled={busy}
      onChange={() => { void importConfig() }}/></label><p className={css.note}>{t('importHint')}</p></div>
  </section>
}
