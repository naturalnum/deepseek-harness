import { IconPlusOutlineRegular, IconSearchOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SshHttpError, type PersonalSshConnection,
  type PersonalSshList, type PersonalSshPort, type SshCheckCall, type SshCheckInput,
  type SshCreateInput, type SshUpdateInput, type SshDeleteInput, type SshToggleInput } from './ssh-api.ts'
import { CONNECTION_MODAL_CONTENT_CLASS_NAME, connectionModalClassName } from './connection-modal-layout.ts'
import { emptyPersonalSshForm, personalSshFormFromConnection, validPersonalSshForm,
  buildPersonalSshCreate, buildPersonalSshUpdate, type PersonalSshFormValue } from './personal-ssh-view.ts'
import { SkillToggle } from './SkillToggle.tsx'

type Translate = TranslateNS<'powerEvolve.extensionCenter'>
type Mutation = { readonly kind: 'create'; readonly input: SshCreateInput }
  | { readonly kind: 'update'; readonly input: SshUpdateInput }
  | { readonly kind: 'toggle'; readonly input: SshToggleInput }
  | { readonly kind: 'delete'; readonly input: SshDeleteInput }
const activeCheck = (state: SshCheckCall['state']): boolean => !['succeeded', 'failed', 'cancelled'].includes(state)

/** Personal SSH management using the original write-only form and saved checks.
 * @param props - public connections, browser operations, and native locale.
 * @returns personal SSH management and authentication check status.
 */
export function PersonalSshPage({ data, port, onChange, onReload, t }: {
  readonly data: PersonalSshList
  readonly port: PersonalSshPort
  readonly onChange: (items: readonly PersonalSshConnection[]) => void
  readonly onReload: () => void
  readonly t: Translate
}): ReactNode {
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<PersonalSshFormValue>(emptyPersonalSshForm)
  const [editing, setEditing] = useState<PersonalSshConnection>()
  const [deleteId, setDeleteId] = useState<string>()
  const [pending, setPending] = useState<Mutation>()
  const busyRef = useRef(false)
  const latestItems = useRef(data.items)
  latestItems.current = data.items
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [checkedId, setCheckedId] = useState<string>()
  const [call, setCall] = useState<SshCheckCall>()
  const [pendingCheck, setPendingCheck] = useState<SshCheckInput>()
  const [checkBusy, setCheckBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelRequestedId, setCancelRequestedId] = useState<string>()
  const [checkError, setCheckError] = useState<string>()
  const [recentCalls, setRecentCalls] = useState<readonly SshCheckCall[]>([])
  const [callsError, setCallsError] = useState<string>()
  const [pollGeneration, setPollGeneration] = useState(0)
  const mounted = useRef(true)
  const observeCall = useCallback((next: SshCheckCall): void => {
    setCall(previous => {
      if (!previous || previous.callId !== next.callId) return previous
      if (!activeCheck(previous.state) && activeCheck(next.state)) return previous
      return next
    })
    setRecentCalls(previous => {
      const existing = previous.find(item => item.callId === next.callId)
      const selected = existing && !activeCheck(existing.state) && activeCheck(next.state) ? existing : next
      return [selected, ...previous.filter(item => item.callId !== next.callId)].slice(0, 100)
    })
  }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!data.available) return
    let stopped = false
    let controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const poll = async (): Promise<void> => {
      while (!stopped) {
        controller = new AbortController()
        try {
          const items = await port.callList(controller.signal)
          if (stopped) return
          setRecentCalls(items)
          setCall(previous => {
            if (!previous) return previous
            const updated = items.find(item => item.callId === previous.callId)
            return updated && (activeCheck(previous.state) || !activeCheck(updated.state)) ? updated : previous
          })
          setCallsError(undefined)
          if (!items.some(item => activeCheck(item.state))) return
        } catch (_cause) {
          if (!stopped) setCallsError(t('sshCheckStatusUncertain'))
        }
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 5000) })
      }
    }
    void poll()
    return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); wake?.() }
  }, [data.available, pollGeneration, port, t])
  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return needle === '' ? data.items : data.items.filter(item =>
      [item.displayName, item.host, item.username].some(value => value.toLocaleLowerCase().includes(needle)))
  }, [data.items, search])
  const count = data.items.filter(item => item.enabled).length
  const valid = validPersonalSshForm(form, editing)
  const locked = busy || pending !== undefined
  const openEditor = (current?: PersonalSshConnection): void => {
    if (locked || !data.available) return
    setEditing(current); setForm(current ? personalSshFormFromConnection(current) : emptyPersonalSshForm())
    setFormOpen(true); setError(undefined); setDeleteId(undefined)
  }
  const closeEditor = (): void => {
    if (locked) return
    setFormOpen(false); setEditing(undefined); setForm(emptyPersonalSshForm()); setError(undefined)
  }
  const patch = (fields: Partial<PersonalSshFormValue>): void => { setForm(previous => ({ ...previous, ...fields })) }
  const mutate = async (mutation: Mutation): Promise<void> => {
    if (busyRef.current || !data.available) return
    busyRef.current = true
    setBusy(true); setPending(mutation); setError(undefined)
    try {
      const item = mutation.kind === 'create' ? await port.create(mutation.input)
        : mutation.kind === 'update' ? await port.update(mutation.input)
          : mutation.kind === 'toggle' ? await port.toggle(mutation.input) : await port.remove(mutation.input)
      if (!mounted.current) return
      const rows = latestItems.current
      onChange(item.deletedAt !== null
        ? rows.filter(row => row.connectionId !== item.connectionId || row.revision > item.revision)
        : rows.some(row => row.connectionId === item.connectionId)
          ? rows.map(row => row.connectionId === item.connectionId && row.revision <= item.revision ? item : row)
          : mutation.kind === 'create' ? [...rows, item] : rows)
      setPending(undefined); setDeleteId(undefined)
      if (mutation.kind === 'create' || mutation.kind === 'update') {
        setForm(emptyPersonalSshForm()); setEditing(undefined); setFormOpen(false)
      }
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof SshHttpError && [400, 401, 403, 404, 409].includes(cause.status)) {
        setPending(undefined)
        setError(t(cause.status === 401 ? 'sessionExpired' : cause.status === 409 ? 'sshConflict' : 'sshWriteRejected'))
      } else {
        setError(t(mutation.kind === 'toggle' ? 'sshToggleUncertain'
          : mutation.kind === 'delete' ? 'sshDeleteUncertain' : 'sshCreateUncertain'))
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const check = async (input: SshCheckInput): Promise<void> => {
    if (checkBusy || !data.available) return
    setCheckBusy(true); setCheckedId(input.connectionId); setCheckError(undefined); setCancelRequestedId(undefined)
    try {
      const next = await port.check(input)
      if (!mounted.current) return
      setCall(next); setPendingCheck(undefined); observeCall(next); setPollGeneration(value => value + 1)
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof SshHttpError && [400, 401, 403, 404, 409].includes(cause.status)) {
        setPendingCheck(undefined); setCheckError(t(cause.status === 401 ? 'sessionExpired' : 'sshCheckRejected'))
      } else {
        setPendingCheck(input); setCheckError(t('sshCheckAdmissionUncertain'))
      }
    } finally { if (mounted.current) setCheckBusy(false) }
  }

  const refreshCall = async (callId: string): Promise<void> => {
    if (checkBusy) return
    setCheckBusy(true); setCheckError(undefined)
    try { const next = await port.callStatus(callId); if (mounted.current) observeCall(next) }
    catch (_cause) { if (mounted.current) setCheckError(t('sshCheckStatusUncertain')) }
    finally { if (mounted.current) setCheckBusy(false) }
  }

  const cancelCall = async (callId: string): Promise<void> => {
    if (cancelBusy) return
    setCancelBusy(true); setCancelRequestedId(callId); setCheckError(undefined)
    try { const next = await port.callCancel(callId); if (mounted.current) observeCall(next) }
    catch (_cause) { if (mounted.current) setCheckError(t('sshCancelUncertain')) }
    finally { if (mounted.current) setCancelBusy(false) }
  }

  const checkLabel = (state: SshCheckCall['state']): string => t(state === 'succeeded' ? 'sshCheckSucceeded'
    : state === 'failed' ? 'sshCheckFailed' : state === 'uncertain' ? 'sshCheckUncertain'
      : state === 'cancelled' ? 'sshCheckCancelled' : state === 'running' ? 'sshCheckRunning' : 'sshCheckPending')

  return <section className="pext-plugin-detail-content pext-ssh-page" data-power-evolve-ssh-page>
    <div className="pext-mcp-header"><div><h1>SSH</h1><p>{t('sshPluginDescription')}</p></div>
      <button type="button" className="pext-dialog-button pext-dialog-button-primary"
        disabled={!data.available || locked} onClick={() => { openEditor() }}>
        <IconPlusOutlineRegular size={15} />{t('sshAddServer')}</button></div>
    <p className="pext-catalog-note">{t('sshNextTaskNotice')}</p>
    {!data.available && <div className="pext-error" role="status">{t('sshUnavailable')}</div>}
    <label className="pext-catalog-search"><span className="pext-visually-hidden">{t('sshSearch')}</span>
      <IconSearchOutlineRegular size={17} /><input type="search" value={search} placeholder={t('sshSearch')}
        onChange={event => { setSearch(event.target.value) }} /></label>
    <div className="pext-catalog-filter-row"><strong>{t('sshMyServers').replace('{count}', String(data.items.length))}</strong>
      <span>{t('sshEnabledCount').replace('{count}', String(count))}</span>
      <button type="button" className="pext-card-action" onClick={() => { onReload()
        setPollGeneration(value => value + 1) }}>{t('refreshList')}</button></div>
    {error && !formOpen && <div className="pext-error" role="alert">{error}</div>}
    {pending && !formOpen && <button type="button" className="pext-dialog-button" disabled={busy || !data.available}
      onClick={() => { void mutate(pending) }}>{t(pending.kind === 'delete' ? 'sshRetryDelete' : 'sshRetryToggle')}</button>}
    {visible.length === 0 ? <div className="pext-empty">{t(search ? 'sshNoMatch' : 'sshEmpty')}</div>
      : <div className="pext-ssh-list">{visible.map(item => <article className="pext-ssh-row" key={item.connectionId}>
        <div className="pext-ssh-row-copy"><strong>{item.displayName}</strong>
          <code>{item.username}@{item.host}:{item.port}</code>
          <small>{t(item.authentication === 'password' ? 'sshPassword' : 'sshPrivateKey')}
            {item.workingDirectory === null ? '' : ` · ${item.workingDirectory}`}</small>
          <small>{t('sshHostKey')} <code>{item.hostKeySha256}</code></small>
          <small>{t('revision').replace('{count}', String(item.revision))}</small></div>
        <div className="pext-ssh-row-actions"><span className="pext-extension-badge" data-enabled={item.enabled || undefined}>
          {t(item.enabled ? 'enabledState' : 'disabledState')}</span>
          <SkillToggle label={`${item.displayName} ${t('pluginEnable')}`} checked={item.enabled}
            disabled={locked || !data.available}
            onChange={enabled => { void mutate({ kind: 'toggle', input: { connectionId: item.connectionId,
              requestId: crypto.randomUUID(), baseRevision: item.revision, enabled } }) }} />
          <button type="button" className="pext-dialog-button" disabled={!data.available || !item.enabled
            || checkBusy || (call !== undefined && activeCheck(call.state)) || pendingCheck !== undefined}
            onClick={() => { setCall(undefined); void check({ requestId: crypto.randomUUID(),
              connectionId: item.connectionId, connectionRevision: item.revision }) }}>
            {t('sshTestAuthentication')}</button>
          <button type="button" className="pext-dialog-button" disabled={locked || !data.available}
            onClick={() => { openEditor(item) }}>{t('sshEditServer')}</button>
          <button type="button" className="pext-dialog-button" disabled={locked || !data.available}
            onClick={() => {
              if (deleteId !== item.connectionId) { setDeleteId(item.connectionId); return }
              void mutate({ kind: 'delete', input: { requestId: crypto.randomUUID(),
                connectionId: item.connectionId, baseRevision: item.revision } })
            }}>{t(deleteId === item.connectionId ? 'sshConfirmDeleteServer' : 'sshDeleteServer')}</button></div>
        {checkedId === item.connectionId && (call || pendingCheck || checkError) && <div className="pext-ssh-check-state" role="status">
          <strong>{call ? checkLabel(call.state) : t('sshCheckUncertain')}</strong>
          <p>{t('sshCheckAuthenticationOnly')}</p>
          {cancelRequestedId === call?.callId && call && activeCheck(call.state) && <p>{t('sshCancellationPending')}</p>}
          {call?.errorCode && <small>{t('sshCheckErrorCode').replace('{code}', call.errorCode)}</small>}
          {checkError && <p>{checkError}</p>}
          <div>{pendingCheck && <button type="button" className="pext-dialog-button" disabled={checkBusy}
            onClick={() => { void check(pendingCheck) }}>{t('sshRetryCheck')}</button>}
            {call && <button type="button" className="pext-dialog-button" disabled={checkBusy}
              onClick={() => { void refreshCall(call.callId) }}>{t('refreshList')}</button>}
            {call && activeCheck(call.state) && <button type="button" className="pext-dialog-button"
              disabled={cancelBusy} onClick={() => { void cancelCall(call.callId) }}>
              {cancelBusy ? t('sshCancelling') : t('sshCancelCheck')}</button>}</div>
        </div>}
      </article>)}</div>}
    {data.available && <section className="pext-ssh-recent" aria-label={t('sshRecentChecks')}>
      <div className="pext-catalog-filter-row"><strong>{t('sshRecentChecks')}</strong>
        <button type="button" className="pext-card-action" onClick={() => { setPollGeneration(value => value + 1) }}>
          {t('refreshList')}</button></div>
      {callsError && <div className="pext-error" role="alert">{callsError}</div>}
      {recentCalls.length === 0 ? <p>{t('sshNoRecentChecks')}</p>
        : <div className="pext-ssh-recent-list">{recentCalls.slice(0, 8).map(recent => <article key={recent.callId}>
          <code>{recent.callId.slice(0, 8)}</code><strong>{checkLabel(recent.state)}</strong>
          {recent.errorCode && <small>{t('sshCheckErrorCode').replace('{code}', recent.errorCode)}</small>}
          {cancelRequestedId === recent.callId && activeCheck(recent.state) && <small>{t('sshCancellationPending')}</small>}
          {cancelRequestedId === recent.callId && checkError && <small>{checkError}</small>}
          <button type="button" className="pext-dialog-button" disabled={checkBusy}
            onClick={() => { void refreshCall(recent.callId) }}>{t('sshRefreshCheck')}</button>
          {activeCheck(recent.state) && <button type="button" className="pext-dialog-button" disabled={cancelBusy}
            onClick={() => { void cancelCall(recent.callId) }}>{t('sshCancelCheck')}</button>}
        </article>)}</div>}
      {recentCalls.length > 8 && <small>{t('sshMoreRecentChecks').replace('{count}', String(recentCalls.length - 8))}</small>}
    </section>}
    <Modal open={formOpen} onClose={closeEditor}
      title={t(editing ? 'sshEditServer' : 'sshAddServer')} closeLabel={t('close')}
      className={connectionModalClassName('pext-install-modal pext-mcp-modal')}
      contentClassName={CONNECTION_MODAL_CONTENT_CLASS_NAME}
      footer={<div className="pext-skill-dialog-footer"><button type="button" className="pext-dialog-button"
        disabled={locked} onClick={closeEditor}>{t('cancel')}</button>
        <button type="button" className="pext-dialog-button pext-dialog-button-primary"
          disabled={locked || !valid || !data.available} onClick={() => {
            const requestId = crypto.randomUUID()
            void mutate(editing ? { kind: 'update', input: buildPersonalSshUpdate(form, editing, requestId) }
              : { kind: 'create', input: buildPersonalSshCreate(form, requestId) })
          }}>{busy ? t('sshSaving') : t('sshSaveServer')}</button></div>}>
      <p className="pext-catalog-note">{t('sshFingerprintHint')}</p>
      <div className="pext-ssh-form pext-install-form">
        <SshField label={t('sshDisplayName')}><input value={form.displayName} maxLength={100} disabled={locked}
          onChange={event => { patch({ displayName: event.target.value }) }} /></SshField>
        <div className="pext-ssh-form-row">
          <SshField label={t('sshHost')}><input value={form.host} maxLength={253} disabled={locked}
            placeholder="server.example.com" onChange={event => { patch({ host: event.target.value, hostKeySha256: '' }) }} /></SshField>
          <SshField label={t('sshPort')}><input type="number" min="1" max="65535" value={form.port} disabled={locked}
            onChange={event => { patch({ port: event.target.value, hostKeySha256: '' }) }} /></SshField>
        </div>
        <SshField label={t('sshUsername')}><input value={form.username} maxLength={100} autoComplete="username" disabled={locked}
          onChange={event => { patch({ username: event.target.value }) }} /></SshField>
        <SshField label={t('mcpAuthentication')}><select value={form.authenticationKind} disabled={locked}
          onChange={event => { patch({ authenticationKind: event.target.value === 'private_key' ? 'private_key' : 'password',
            password: '', privateKey: '', passphrase: '', clearPassphrase: false }) }}>
          <option value="password">{t('sshPassword')}</option><option value="private_key">{t('sshPrivateKey')}</option>
        </select></SshField>
        {form.authenticationKind === 'password'
          ? <SshField label={t('sshPassword')}><input type="password" value={form.password} autoComplete="new-password" disabled={locked}
            placeholder={editing?.authentication === 'password' && editing.secretConfigured ? t('sshSecretPreserve') : undefined}
            onChange={event => { patch({ password: event.target.value }) }} /></SshField>
          : <>
            <SshField label={t('sshPrivateKey')}><textarea rows={5} value={form.privateKey} spellCheck={false} disabled={locked}
              placeholder={editing?.authentication === 'private_key' && editing.secretConfigured ? t('sshSecretPreserve') : undefined}
              onChange={event => { patch({ privateKey: event.target.value }) }} /></SshField>
            <SshField label={t('sshPassphrase')}><input type="password" value={form.passphrase} autoComplete="new-password"
              disabled={locked || form.clearPassphrase}
              placeholder={editing?.authentication === 'private_key' && editing.passphraseConfigured ? t('sshSecretPreserve') : t('sshOptional')}
              onChange={event => { patch({ passphrase: event.target.value }) }} /></SshField>
            {editing?.authentication === 'private_key' && <label className="pext-ssh-checkbox">
              <input type="checkbox" checked={form.clearPassphrase} disabled={locked}
                onChange={event => { patch({ clearPassphrase: event.target.checked, passphrase: '' }) }} />{t('sshClearPassphrase')}</label>}
          </>}
        <p>{t('sshCredentialUploadHint')}</p>
        <SshField label={t('sshWorkingDirectory')}><input value={form.workingDirectory} maxLength={1024} disabled={locked}
          placeholder="~/project" onChange={event => { patch({ workingDirectory: event.target.value }) }} /></SshField>
        <SshField label={t('sshHostKey')}><input value={form.hostKeySha256} maxLength={52} spellCheck={false} disabled={locked}
          placeholder="SHA256:…" onChange={event => { patch({ hostKeySha256: event.target.value }) }} /></SshField>
        <label className="pext-ssh-checkbox"><input type="checkbox" checked={form.enabled} disabled={locked}
          onChange={event => { patch({ enabled: event.target.checked }) }} />{t('sshConnectionEnabled')}</label>
        {error && <div className="pext-error" role="alert">{error}</div>}
        {pending && <button type="button" className="pext-dialog-button" disabled={busy || !data.available}
          onClick={() => { void mutate(pending) }}>{t('sshRetryCreate')}</button>}
      </div>
    </Modal>
  </section>
}

function SshField({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return <label className="pext-mcp-form-field"><span>{label}</span>{children}</label>
}
