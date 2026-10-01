/** Native Files row and toolbar contributions, with cancellable preparation and browser-owned downloads. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import { IconCloseOutlineRegular, IconDownloadOutlineRegular, IconLoadingOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileDownloadView } from '@power-evolve/contracts/file-download'
import { DownloadError, MAX_DOWNLOAD_FILES, startBrowserDownload } from './download-client.ts'
import type { DownloadFailure } from './download-client.ts'
import { canSelect } from './download-selection.ts'
import type { createDownloadSelectionStore } from './download-selection.ts'
import type { WorkspaceFileLocaleKey } from './locales.ts'

type Copy = PropsLocale<'powerEvolve.workspaceFiles'>
type SelectionStore = PropsStore<ReturnType<typeof createDownloadSelectionStore>>
const EMPTY_PATHS: readonly string[] = []

/** Preparation input comes from the viewed Files tree, independent of the global current Session. */
export interface DownloadActions {
  readonly prepareDownload: (sessionId: string, paths: readonly string[], signal: AbortSignal) => Promise<FileDownloadView>
}
/** Tab-record cleanup retained across body unmounts. */
export interface SelectionLifetime {
  /** Attach cleanup to the tab record, independent of whether its body is mounted. */
  readonly bindSelection: (tabId: string, signal: AbortSignal) => void
}

/** Renderer-bound inputs for a native Files row selection control. */
export type FileSelectionProps = PropsRuntime<'sidebar.right.tab.files.entry.leading'> & SelectionStore & Copy

/** Select a file without invoking the row's open or expand gesture.
 * @param props - the row owner, viewed Session, tab hook, selection store and copy.
 * @returns a file checkbox or an alignment spacer for a non-file entry.
 */
export function FileSelection({ sessionId, tabId, root, path, type, useTabInfo, useStore, actions, t }: FileSelectionProps) {
  const { tab } = useTabInfo()
  const selection = useStore(state => state.byTab[tabId])
  const paths = selection?.sessionId === sessionId && selection.root === root ? selection.paths : EMPTY_PATHS
  const checked = paths.includes(path)
  if (type !== 'file') return <span className="pe-download-checkbox-space" aria-hidden="true" />
  const unavailable = !canSelect(sessionId, EMPTY_PATHS, path)
  const limited = !checked && (paths.length >= MAX_DOWNLOAD_FILES || !canSelect(sessionId, paths, path))
  return <input type="checkbox" className="pe-download-checkbox"
    data-workspace-download-select={path} aria-label={t('selectFile', { name: path })}
    title={unavailable ? t('downloadUnavailable') : limited ? t('selectionLimit') : undefined}
    checked={checked} disabled={tab.signal.aborted || unavailable || limited}
    onClick={event => { event.stopPropagation() }}
    onChange={() => { if (!tab.signal.aborted) actions.toggle(sessionId, tabId, root, path) }}
  />
}

/** Renderer-bound inputs for native Files batch preparation and tab cleanup. */
export type FileDownloadProps = PropsRuntime<'sidebar.right.tab.files.actions'> & SelectionStore & Copy & DownloadActions & SelectionLifetime

/** Prepare the current selection and delegate its download to the browser.
 * @param props - the viewed tab/root, Session store, preparation face and copy.
 * @returns clear-selection and download controls; preparation is cancelled when they unmount.
 */
export function FileDownload({ sessionId, tabId, root, useTabInfo, useStore, actions, bindSelection, prepareDownload, t }: FileDownloadProps) {
  const { tab } = useTabInfo()
  const selection = useStore(state => state.byTab[tabId])
  const paths = selection?.sessionId === sessionId && selection.root === root ? selection.paths : EMPTY_PATHS
  useEffect(() => {
    if (tab.signal.aborted) return
    actions.resetRoot(sessionId, tabId, root)
    bindSelection(tabId, tab.signal)
  }, [actions, sessionId, tabId, root, tab.signal, bindSelection])
  return <div className="pe-download-controls" data-workspace-download-toolbar="">
    {paths.length > 0 && <Tooltip label={t('clearSelection')} side="bottom">
      <button type="button" className="pe-workspace-download-button" onClick={() => { actions.forget(tabId) }}
        disabled={tab.signal.aborted} aria-label={t('clearSelection')}><IconCloseOutlineRegular /></button>
    </Tooltip>}
    <DownloadButton key={`${sessionId}:${tabId}:${root}:${JSON.stringify(paths)}`}
      sessionId={sessionId} paths={paths} signal={tab.signal} prepareDownload={prepareDownload} t={t} />
  </div>
}

interface DownloadButtonProps extends Copy, DownloadActions {
  readonly sessionId: string
  readonly paths: readonly string[]
  readonly signal: AbortSignal
}

const failureCopy: Record<DownloadFailure, WorkspaceFileLocaleKey> = {
  limit: 'downloadLimit', missing: 'downloadMissing', busy: 'downloadBusy', denied: 'downloadDenied',
  changed: 'downloadChanged', timeout: 'downloadTimeout', failed: 'downloadFailed',
}

function DownloadButton({ sessionId, paths, signal, prepareDownload, t }: DownloadButtonProps) {
  const request = useRef<AbortController | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const cancel = () => { request.current?.abort() }
    signal.addEventListener('abort', cancel, { once: true })
    return () => { cancel(); signal.removeEventListener('abort', cancel) }
  }, [signal])
  const run = async () => {
    if (request.current !== null) { request.current.abort(); return }
    if (signal.aborted || paths.length === 0) return
    const controller = new AbortController()
    request.current = controller
    setPreparing(true)
    setError('')
    try {
      const result = await prepareDownload(sessionId, paths, controller.signal)
      if (!controller.signal.aborted && !signal.aborted) startBrowserDownload(result)
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(t(failureCopy[failure instanceof DownloadError ? failure.reason : 'failed']))
      }
    } finally {
      if (request.current === controller) { request.current = null; setPreparing(false) }
    }
  }
  const label = preparing ? t('cancelDownloadPreparation') : paths.length === 0 ? t('download')
    : t('downloadSelected', { count: paths.length })
  return <div className="pe-workspace-download" data-workspace-download="selection">
    <Tooltip label={preparing ? t('downloadPreparing') : label} side="bottom">
      <button type="button" className="pe-workspace-download-button pe-download-button" aria-label={label}
        disabled={paths.length === 0 || signal.aborted} aria-busy={preparing} onClick={() => { void run() }}>
        {preparing ? <IconLoadingOutlineRegular /> : <IconDownloadOutlineRegular />}
        {paths.length > 0 && <span className="pe-download-count" aria-hidden="true">{paths.length}</span>}
      </button>
    </Tooltip>
    {error !== '' && <span className="pe-workspace-download-error" role="alert">{error}</span>}
  </div>
}
