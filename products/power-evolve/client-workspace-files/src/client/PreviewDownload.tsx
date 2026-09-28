import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceFileLocaleKey } from './locales.ts'
import { saveBrowserFile, WorkspaceDownloadError, WorkspaceFileDownloadClient } from './workspace-file-download.ts'
import { validFileSessionId } from './session-id.ts'

type Props = PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<'powerEvolve.workspaceFiles'>
  & { readonly sessionId: string; readonly client: WorkspaceFileDownloadClient }

export function PreviewDownload(props: Props) {
  return <PreviewDownloadForFile key={`${props.sessionId}:${props.absolutePath}`} {...props} />
}

function PreviewDownloadForFile({ absolutePath, sessionId, client, t }: Props) {
  const pending = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WorkspaceFileLocaleKey | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  const download = async () => {
    if (pending.current !== null) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    try {
      saveBrowserFile(await client.read(sessionId, absolutePath, controller.signal))
    } catch (failure) {
      if (!controller.signal.aborted) {
        const status = failure instanceof WorkspaceDownloadError ? failure.status : 0
        setError(status === 404 ? 'downloadMissing' : status === 413 ? 'downloadLimit'
          : status === 401 || status === 403 ? 'downloadDenied' : 'downloadFailed')
      }
    } finally {
      if (pending.current === controller) pending.current = null
      setBusy(false)
    }
  }

  return <span className="pe-workspace-download" data-workspace-download="">
    <Tooltip label={t('download')} side="bottom" delayMs={500}>
      <button type="button" className="pe-workspace-download-button" aria-label={t('download')}
        aria-busy={busy} disabled={busy || !validFileSessionId(sessionId)} onClick={() => { void download() }}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M8 2v8m-3-3 3 3 3-3M3 10v3h10v-3" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </Tooltip>
    {error && <span className="pe-workspace-download-error" role="alert">{t(error)}</span>}
  </span>
}
