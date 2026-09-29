import { IconPlusOutlineRegular, IconSearchOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SshHttpError, normalizeSshFingerprint, validSshCreate, type PersonalSshConnection,
  type PersonalSshList, type PersonalSshPort, type SshCreateInput, type SshToggleInput } from './ssh-api.ts'
import { SkillToggle } from './SkillToggle.tsx'

type Translate = TranslateNS<'powerEvolve.extensionCenter'>
type Form = Omit<SshCreateInput, 'requestId' | 'port'> & { port: string }
const blank = (): Form => ({ displayName: '', host: '', port: '22', username: '', hostKeySha256: '',
  password: '', enabled: false })
const VALIDATION_REQUEST_ID = '00000000-0000-4000-8000-000000000000'

/** Personal SSH management on the native Plugins page. Password bytes bypass the Host. */
export function PersonalSshPage({ data, port, onChange, onReload, t }: {
  readonly data: PersonalSshList
  readonly port: PersonalSshPort
  readonly onChange: (items: readonly PersonalSshConnection[]) => void
  readonly onReload: () => void
  readonly t: Translate
}): ReactNode {
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<Form>(blank)
  const [pendingCreate, setPendingCreate] = useState<SshCreateInput>()
  const [pendingToggle, setPendingToggle] = useState<SshToggleInput>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return needle === '' ? data.items : data.items.filter(item =>
      [item.displayName, item.host, item.username].some(value => value.toLocaleLowerCase().includes(needle)))
  }, [data.items, search])
  const count = data.items.filter(item => item.enabled).length
  const portNumber = Number(form.port)
  const valid = validSshCreate({ ...form, requestId: VALIDATION_REQUEST_ID, port: portNumber })

  const create = async (input: SshCreateInput): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const item = await port.createPassword(input)
      onChange([...data.items.filter(row => row.connectionId !== item.connectionId), item])
      setPendingCreate(undefined); setForm(blank()); setFormOpen(false)
    } catch (cause) {
      if (cause instanceof SshHttpError && cause.status === 409) {
        setPendingCreate(undefined); setError(t('sshConflict'))
      } else if (cause instanceof SshHttpError && cause.status === 401) {
        setPendingCreate(undefined); setError(t('sessionExpired'))
      } else {
        setPendingCreate(input); setError(t('sshCreateUncertain'))
      }
    } finally { setBusy(false) }
  }

  const toggle = async (input: SshToggleInput): Promise<void> => {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const item = await port.toggle(input)
      onChange(data.items.map(row => row.connectionId === item.connectionId ? item : row))
      setPendingToggle(undefined)
    } catch (cause) {
      if (cause instanceof SshHttpError && cause.status === 409) {
        setPendingToggle(undefined); setError(t('sshConflict'))
      } else if (cause instanceof SshHttpError && cause.status === 401) {
        setPendingToggle(undefined); setError(t('sessionExpired'))
      } else {
        setPendingToggle(input); setError(t('sshToggleUncertain'))
      }
    } finally { setBusy(false) }
  }

  return <section className="pext-plugin-detail-content pext-ssh-page" data-power-evolve-ssh-page>
    <div className="pext-mcp-header"><div><h1>SSH</h1><p>{t('sshPluginDescription')}</p></div>
      <button type="button" className="pext-dialog-button pext-dialog-button-primary"
        disabled={!data.available || busy} onClick={() => { setFormOpen(true); setError(undefined) }}>
        <IconPlusOutlineRegular size={15} />{t('sshAddServer')}</button></div>
    <p className="pext-catalog-note">{t('sshNextTaskNotice')}</p>
    {!data.available && <div className="pext-error" role="status">{t('sshUnavailable')}</div>}
    <label className="pext-catalog-search"><span className="pext-visually-hidden">{t('sshSearch')}</span>
      <IconSearchOutlineRegular size={17} /><input type="search" value={search} placeholder={t('sshSearch')}
        onChange={event => { setSearch(event.target.value) }} /></label>
    <div className="pext-catalog-filter-row"><strong>{t('sshMyServers').replace('{count}', String(data.items.length))}</strong>
      <span>{t('sshEnabledCount').replace('{count}', String(count))}</span>
      <button type="button" className="pext-card-action" onClick={onReload}>{t('refreshList')}</button></div>
    {error && !formOpen && <div className="pext-error" role="alert">{error}</div>}
    {pendingToggle && <button type="button" className="pext-dialog-button" disabled={busy}
      onClick={() => { void toggle(pendingToggle) }}>{t('sshRetryToggle')}</button>}
    {visible.length === 0 ? <div className="pext-empty">{t(search ? 'sshNoMatch' : 'sshEmpty')}</div>
      : <div className="pext-ssh-list">{visible.map(item => <article className="pext-ssh-row" key={item.connectionId}>
        <div className="pext-ssh-row-copy"><strong>{item.displayName}</strong>
          <code>{item.username}@{item.host}:{item.port}</code>
          <small>{t('sshHostKey')} <code>{item.hostKeySha256}</code></small>
          <small>{t('revision').replace('{count}', String(item.revision))}</small></div>
        <div className="pext-ssh-row-actions"><span className="pext-extension-badge" data-enabled={item.enabled || undefined}>
          {t(item.enabled ? 'enabledState' : 'disabledState')}</span>
          <SkillToggle label={`${item.displayName} ${t('pluginEnable')}`} checked={item.enabled}
            disabled={busy || pendingToggle !== undefined || !data.available}
            onChange={enabled => { void toggle({ connectionId: item.connectionId,
              requestId: crypto.randomUUID(), baseRevision: item.revision, enabled }) }} />
          <button type="button" className="pext-dialog-button" disabled>{t('sshTestUnavailable')}</button></div>
      </article>)}</div>}
    <Modal open={formOpen} onClose={() => { if (!busy) { setFormOpen(false); setForm(blank()); setPendingCreate(undefined) } }}
      title={t('sshAddServer')} closeLabel={t('close')} className="pext-install-modal"
      footer={<div className="pext-skill-dialog-footer"><button type="button" className="pext-dialog-button"
        disabled={busy} onClick={() => { setFormOpen(false); setForm(blank()); setPendingCreate(undefined); setError(undefined) }}>
        {t('cancel')}</button><button type="button" className="pext-dialog-button pext-dialog-button-primary"
          disabled={busy || pendingCreate !== undefined || !valid || !data.available} onClick={() => { void create({
            ...form, requestId: crypto.randomUUID(), port: portNumber,
            hostKeySha256: normalizeSshFingerprint(form.hostKeySha256),
          }) }}>{busy ? t('sshSaving') : t('sshSaveServer')}</button></div>}>
      <div className="pext-ssh-form">
        <p>{t('sshFingerprintHint')}</p>
        <label>{t('sshDisplayName')}<input value={form.displayName} maxLength={100}
          disabled={busy || pendingCreate !== undefined} onChange={event => { setForm({ ...form, displayName: event.target.value }) }} /></label>
        <div className="pext-ssh-form-row"><label>{t('sshHost')}<input value={form.host} maxLength={253}
          disabled={busy || pendingCreate !== undefined} placeholder="server.example.com"
          onChange={event => { setForm({ ...form, host: event.target.value, hostKeySha256: '' }) }} /></label>
          <label>{t('sshPort')}<input type="number" min="1" max="65535" value={form.port}
            disabled={busy || pendingCreate !== undefined}
            onChange={event => { setForm({ ...form, port: event.target.value, hostKeySha256: '' }) }} /></label></div>
        <label>{t('sshUsername')}<input value={form.username} maxLength={100} autoComplete="username"
          disabled={busy || pendingCreate !== undefined} onChange={event => { setForm({ ...form, username: event.target.value }) }} /></label>
        <label>{t('sshHostKey')}<input value={form.hostKeySha256} maxLength={52} spellCheck={false}
          placeholder="SHA256:…" disabled={busy || pendingCreate !== undefined}
          onChange={event => { setForm({ ...form, hostKeySha256: event.target.value }) }} /></label>
        <label>{t('sshPassword')}<input type="password" value={form.password} autoComplete="new-password"
          disabled={busy || pendingCreate !== undefined} onChange={event => { setForm({ ...form, password: event.target.value }) }} /></label>
        <p>{t('sshPasswordOnly')}</p>
        <label className="pext-ssh-checkbox"><input type="checkbox" checked={form.enabled}
          disabled={busy || pendingCreate !== undefined}
          onChange={event => { setForm({ ...form, enabled: event.target.checked }) }} />{t('sshEnabledOnCreate')}</label>
        {error && <div className="pext-error" role="alert">{error}</div>}
        {pendingCreate && <button type="button" className="pext-dialog-button" disabled={busy}
          onClick={() => { void create(pendingCreate) }}>{t('sshRetryCreate')}</button>}
      </div>
    </Modal>
  </section>
}
