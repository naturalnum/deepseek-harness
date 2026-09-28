import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { artifactDownloadUrl, type Artifact, type ArtifactHttpClient, type ArtifactPreview } from './api.ts'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'powerEvolve.artifacts'>
  & { readonly sessionId: string; readonly workspaceId: string | undefined; readonly client: ArtifactHttpClient;
    readonly changed: EventTarget }

function previewBody(preview: ArtifactPreview, noPreview: string) {
  if (preview.text !== undefined) return <pre className="pe-artifacts-preview">{preview.text}</pre>
  if (preview.data !== undefined && preview.data.length < 3_000_000
    && /^image\/(?:png|jpeg|gif|webp)$/.test(preview.mime) && /^[A-Za-z0-9+/]*={0,2}$/.test(preview.data)) {
    return <img alt="" src={`data:${preview.mime};base64,${preview.data}`} className="pe-artifacts-image" />
  }
  return <p>{noPreview}</p>
}

/** Native right Sidebar page for the authenticated Artifact catalog. */
export function ArtifactsTab({ useTabInfo, sessionId, workspaceId, client, changed, t }: Props) {
  const { tab } = useTabInfo()
  const [scope, setScope] = useState<'session' | 'workspace'>('session')
  const [items, setItems] = useState<readonly Artifact[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<ArtifactPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const request = useRef<AbortController | null>(null)
  const previewRequest = useRef<AbortController | null>(null)
  const load = useCallback(async (next: string | null = null) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError(false)
    try {
      const filter = scope === 'workspace' && workspaceId !== undefined ? { workspaceId } : { sessionId }
      const page = await client.list({ ...filter, ...(next ? { cursor: next } : {}) }, controller.signal)
      if (!controller.signal.aborted) {
        setItems(previous => next ? [...previous, ...page.items] : page.items)
        setCursor(page.nextCursor)
      }
    } catch {
      if (!controller.signal.aborted) setError(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [client, scope, sessionId, workspaceId])
  useEffect(() => {
    if (tab.signal.aborted) return
    void load()
    return () => { request.current?.abort(); previewRequest.current?.abort() }
  }, [load, tab.signal])
  useEffect(() => {
    const refresh = () => { void load() }
    changed.addEventListener('published', refresh)
    return () => changed.removeEventListener('published', refresh)
  }, [changed, load])
  const showPreview = async (artifactId: string) => {
    previewRequest.current?.abort()
    const controller = new AbortController()
    previewRequest.current = controller
    setSelected(artifactId)
    setPreview(null)
    setPreviewError(false)
    try {
      const value = await client.preview(artifactId, controller.signal)
      if (!controller.signal.aborted) setPreview(value)
    } catch {
      if (!controller.signal.aborted) setPreviewError(true)
    }
  }
  return <section className="pe-artifacts-tab" data-artifacts-tab="">
    <header className="pe-artifacts-header">
      <strong>{t('title')}</strong>
      <select aria-label={t('title')} value={scope} onChange={event => { setScope(event.target.value as 'session' | 'workspace'); setItems([]); setCursor(null); setSelected(null); setPreview(null) }}>
        <option value="session">{t('session')}</option>
        {workspaceId && <option value="workspace">{t('workspace')}</option>}
      </select>
      <button type="button" onClick={() => { void load() }}>{t('refresh')}</button>
    </header>
    {loading && <p role="status">{t('loading')}</p>}
    {error && <p role="alert">{t('listFailed')}</p>}
    {!loading && !error && items.length === 0 && <p>{t('empty')}</p>}
    <ul className="pe-artifacts-list">
      {items.map(item => <li key={item.artifactId} className="pe-artifacts-item">
        <div className="pe-artifacts-filename">{item.filename}</div>
        <small>{t('sizeBytes', { size: item.sizeBytes.toLocaleString() })} · {new Date(item.createdAt).toLocaleString()}</small>
        <div className="pe-artifacts-actions">
          <button type="button" onClick={() => { void showPreview(item.artifactId) }}>{t('preview')}</button>
          <a href={artifactDownloadUrl(item.artifactId)} download={item.filename}>{t('download')}</a>
        </div>
        {selected === item.artifactId && (previewError
          ? <p role="alert">{t('previewFailed')}</p>
          : preview === null ? <p role="status">{t('loading')}</p>
            : <>{previewBody(preview, t('noPreview'))}{preview.truncated && <p>{t('truncated')}</p>}</>)}
      </li>)}
    </ul>
    {cursor && <button type="button" disabled={loading} onClick={() => { void load(cursor) }}>{t('more')}</button>}
  </section>
}
