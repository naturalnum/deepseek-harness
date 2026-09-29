import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AccountHttpError, type AccountHttpClient, type AuthorizedModel, type CurrentAccount, type SettingsUpdateRequest,
} from './account-api.ts'

export type AccountSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'powerEvolve.account'> & {
  readonly client: AccountHttpClient
}

type Phase = 'loading' | 'ready' | 'saving' | 'retry' | 'refresh-required'
type Notice = 'saved' | 'conflict' | 'modelDenied'
type Problem = 'loadFailed' | 'saveRetry' | 'invalidTokens' | 'sessionExpired'

const pageStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560, padding: '18px 4px',
  color: 'var(--dsw-alias-label-primary)',
}
const cardStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 14, padding: 20, borderRadius: 16,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
}
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, fontWeight: 600 }
const inputStyle: CSSProperties = {
  minHeight: 36, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit',
}
const buttonStyle: CSSProperties = {
  minHeight: 36, alignSelf: 'flex-start', padding: '6px 14px', border: 0, borderRadius: 8,
  color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-button-primary-fill)',
  fontWeight: 600, cursor: 'pointer',
}
const mutedStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }

/** Keep the model catalog authoritative; no provider or credential entry is editable here. */
export function validSelection(model: string, tokens: string, models: readonly AuthorizedModel[]): boolean {
  const selected = models.find(item => item.id === model)
  if (!selected || !/^[1-9]\d*$/u.test(tokens)) return false
  const parsed = Number(tokens)
  return Number.isSafeInteger(parsed) && parsed <= Math.min(selected.maxTokens, 8192)
}

/** Personal settings inside the existing native Settings panel. */
export function AccountSection({ client, t }: AccountSectionProps) {
  const [account, setAccount] = useState<CurrentAccount>()
  const [models, setModels] = useState<readonly AuthorizedModel[]>([])
  const [model, setModel] = useState('')
  const [tokens, setTokens] = useState('')
  const [phase, setPhase] = useState<Phase>('loading')
  const [notice, setNotice] = useState<Notice>()
  const [problem, setProblem] = useState<Problem>()
  const [pending, setPending] = useState<SettingsUpdateRequest>()
  const read = useRef<AbortController>()
  const mounted = useRef(true)

  const reload = async (nextNotice?: Notice) => {
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    setPhase('loading'); setProblem(undefined)
    try {
      const [current, authorized] = await Promise.all([
        client.me(controller.signal), client.modelsList(controller.signal),
      ])
      if (!mounted.current || controller.signal.aborted) return
      setAccount(current); setModels(authorized)
      setModel(current.settings.model); setTokens(String(current.settings.maxTokens))
      setPending(undefined); setNotice(nextNotice); setPhase('ready')
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return
      setPhase('refresh-required')
      setProblem(error instanceof AccountHttpError && error.status === 401 ? 'sessionExpired' : 'loadFailed')
    }
  }

  useEffect(() => {
    mounted.current = true
    void reload()
    return () => { mounted.current = false; read.current?.abort() }
  }, [client])

  const submit = async (request: SettingsUpdateRequest) => {
    setPhase('saving'); setProblem(undefined); setNotice(undefined)
    try {
      await client.settingsUpdate(request)
      if (mounted.current) await reload('saved')
    } catch (error) {
      if (!mounted.current) return
      if (error instanceof AccountHttpError && error.status === 409) {
        setPending(undefined)
        await reload('conflict')
      } else if (error instanceof AccountHttpError && error.status === 403) {
        setPending(undefined)
        await reload('modelDenied')
      } else if (error instanceof AccountHttpError && error.status === 401) {
        setPending(undefined); setPhase('refresh-required'); setProblem('sessionExpired')
      } else {
        // An ambiguous transport/server failure must retry the same immutable request.
        setPhase('retry'); setProblem('saveRetry')
      }
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (phase !== 'ready' || !account) return
    if (!validSelection(model, tokens, models)) { setProblem('invalidTokens'); return }
    const request: SettingsUpdateRequest = {
      requestId: crypto.randomUUID(), expectedRevision: account.settings.revision,
      model, maxTokens: Number(tokens),
    }
    setPending(request)
    void submit(request)
  }
  const selected = models.find(item => item.id === model)
  const editable = phase === 'ready' && models.length > 0
  const changed = account !== undefined &&
    (model !== account.settings.model || tokens !== String(account.settings.maxTokens))
  const saveDisabled = !editable || !changed || !validSelection(model, tokens, models)

  return <div style={pageStyle} data-power-evolve-account-settings="">
    <h2 style={{ margin: 0, fontSize: 20 }}>{t('account')}</h2>
    {account && <section style={cardStyle} aria-label={t('username')}>
      <strong>{t('username')}</strong><span>{account.username}</span>
    </section>}
    {(phase === 'loading' || phase === 'refresh-required') && <div role="status">
      {phase === 'loading' ? t('accountUnavailable') : t(problem ?? 'loadFailed')}
    </div>}
    {phase === 'refresh-required' && <button type="button" style={buttonStyle} onClick={() => { void reload() }}>
      {t('refresh')}
    </button>}
    {account && phase !== 'refresh-required' && <form style={cardStyle} onSubmit={save}>
      <label style={fieldStyle}>{t('model')}
        <select value={model} style={inputStyle} disabled={!editable} onChange={event => { setModel(event.target.value); setProblem(undefined) }}>
          {!models.some(item => item.id === model) && <option value={model} disabled>{model}</option>}
          {models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      {models.length === 0 && <p style={mutedStyle}>{t('noModels')}</p>}
      <label style={fieldStyle}>{t('maxTokens')}
        <input type="number" min={1} max={selected?.maxTokens ?? 8192} step={1} inputMode="numeric"
          value={tokens} style={inputStyle} disabled={!editable}
          onChange={event => { setTokens(event.target.value); setProblem(undefined) }} />
      </label>
      {selected && <p style={mutedStyle}>{t('modelLimit')} {Math.min(selected.maxTokens, 8192)}</p>}
      {notice && <p role="status" style={mutedStyle}>{t(notice)}</p>}
      {problem && <p role="alert" style={{ margin: 0, color: 'var(--dsw-alias-state-error-primary)' }}>{t(problem)}</p>}
      {phase === 'retry'
        ? <button type="button" style={buttonStyle} onClick={() => { if (pending) void submit(pending) }}>{t('retrySave')}</button>
        : <button type="submit" style={{ ...buttonStyle, opacity: saveDisabled ? 0.48 : 1,
          cursor: saveDisabled ? 'not-allowed' : 'pointer' }} disabled={saveDisabled}>
          {t(phase === 'saving' ? 'saving' : 'save')}
        </button>}
    </form>}
  </div>
}
