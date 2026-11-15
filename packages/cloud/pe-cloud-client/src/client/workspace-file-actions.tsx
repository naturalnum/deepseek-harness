/** Cloud controls over the original Native workspace tree and account file operations. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FactoryComponentPropsOf, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, IconDownloadOutlineRegular, IconProjectAddOutlineRegular,
  IconUploadOutlineRegular, IconWarningOutlineRegular, Input, Menu, MenuItemButton, Modal, PathLabel, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { WorkspaceFileManagement, WorkspaceUploadFile } from './workspace-management-types.ts'
import { createWorkspaceFileActionsStore, insideWorkspace } from './workspace-file-actions-store.ts'
import { WORKSPACE_FILES_NAMESPACE, workspaceFileDictionaries, type WorkspaceFilesKey } from './workspace-file-locales.ts'
import css from './workspace-file-actions.module.css'

declare module '@deepseek-ai/dsh-client-ui-sidebar-files/client' {
  interface WorkspaceFileRowActionsDefinition {
    store: ReturnType<typeof createWorkspaceFileActionsStore>
    locale: typeof WORKSPACE_FILES_NAMESPACE
  }
}

/** Only callbacks captured by the original account page enter the control. */
interface FileActionsInjected {
  readonly signal: AbortSignal
  readonly upload: WorkspaceFileManagement['upload']
  readonly download: WorkspaceFileManagement['download']
  readonly createDirectory: WorkspaceFileManagement['createDirectory']
  readonly releaseDirectory: (sessionId: SessionId) => Promise<void>
}
/** Native owner data, framework store/locale seats, and captured account callbacks. */
export type WorkspaceFileActionsProps = PropsRuntime<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createWorkspaceFileActionsStore>>
  & PropsLocale<typeof WORKSPACE_FILES_NAMESPACE> & FileActionsInjected

/** Selection disappears with a row, so prior directory pages are not retained. */
export function WorkspaceFileRowActions(props: FactoryComponentPropsOf<'sidebar.files.workspace-entry-actions'>): ReactNode {
  const { entry, useStore, actions, t } = props
  const selection = useStore(value => value)
  useEffect(() => () => { actions.forget(entry.path) }, [actions, entry.path])
  const kind = entry.meta?.kind
  if (!insideWorkspace(selection.root, entry.path) || (kind !== 'file' && kind !== 'directory')) return null
  return <input type={kind === 'directory' ? 'radio' : 'checkbox'} className={css.select}
    name={kind === 'directory' ? `cloud-file-directory-${props.sessionId}` : undefined}
    aria-label={t('selectFile', { name: entry.name })}
    checked={kind === 'directory' ? selection.directory === entry.path : selection.selected.includes(entry.path)}
    onChange={() => { if (kind === 'directory') actions.directory(entry.path); else actions.select(entry.path) }} />
}

type OperationKind = 'upload' | 'download' | 'folder'
interface Progress { readonly kind: OperationKind; readonly completed: number; readonly total: number }

/** Original operations, one current cancellation owner, and failure-only feedback. */
export function WorkspaceFileActions(props: WorkspaceFileActionsProps): ReactNode {
  const { absolutePath, sessionId, useStore, actions, t } = props
  const selection = useStore(value => value)
  const filesInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null)
  const current = useRef<AbortController | undefined>(undefined), mounted = useRef(true)
  const [operation, setOperation] = useState<Progress>()
  const [failure, setFailure] = useState<WorkspaceFilesKey>()
  const [uploadMenu, setUploadMenu] = useState(false), [folderName, setFolderName] = useState<string>()
  const [errorOpen, setErrorOpen] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; current.current?.abort() }
  }, [])
  useEffect(() => {
    actions.root(absolutePath)
    return () => { current.current?.abort() }
  }, [absolutePath, actions])
  const directory = selection.root === absolutePath ? selection.directory ?? absolutePath : absolutePath
  const selected = selection.root === absolutePath ? selection.selected : []
  const disabled = operation !== undefined || props.signal.aborted || failure === 'directoryCloseFailed'
  const perform = async (kind: OperationKind,
    run: (signal: AbortSignal, progress: (completed: number, total: number) => void) => Promise<void>): Promise<void> => {
    if (current.current !== undefined || props.signal.aborted || failure === 'directoryCloseFailed') return
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, props.signal])
    current.current = controller
    setFailure(undefined); setOperation({ kind, completed: 0, total: 0 })
    let dispatched = kind === 'download'
    try {
      if (!dispatched) { await props.releaseDirectory(sessionId); signal.throwIfAborted() }
      dispatched = true
      await run(signal, (completed, total) => {
        if (mounted.current && !props.signal.aborted && current.current === controller) setOperation({ kind, completed, total })
      })
    } catch (_error) {
      if (mounted.current && !props.signal.aborted) setFailure(!dispatched && !signal.aborted ? 'directoryCloseFailed'
        : controller.signal.aborted && kind === 'upload' ? 'cancelledUnknown'
          : kind === 'folder' ? 'folderFailed' : kind === 'download' ? 'downloadFailed' : 'transferFailed')
    } finally {
      if (current.current === controller) {
        current.current = undefined
        if (mounted.current && !props.signal.aborted) setOperation(undefined)
      }
    }
  }
  const upload = (list: FileList | null, folder: boolean): void => {
    if (list === null || list.length === 0) return
    const files: WorkspaceUploadFile[] = Array.from(list, file => ({ file, path: folder ? file.webkitRelativePath : file.name }))
    const target = directory
    void perform('upload', async (signal, progress) => {
      try { await props.upload(sessionId, target, files, signal, progress) }
      finally { if (mounted.current && !props.signal.aborted) props.refresh?.() }
    })
  }
  if (props.refresh === undefined) return null
  return <div className={css.root} data-cloud-workspace-actions>
    {operation === undefined ? <div className={css.tools}>
      <input ref={filesInput} type="file" multiple hidden onChange={(event) => { upload(event.target.files, false); event.target.value = '' }} />
      <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }}
        onChange={(event) => { upload(event.target.files, true); event.target.value = '' }} />
      <Tooltip label={t('upload')} side="bottom"><button type="button" className={css.tool} aria-label={t('upload')}
        disabled={disabled} onClick={() => { filesInput.current?.click() }}><IconUploadOutlineRegular size={16} /></button></Tooltip>
      <Menu open={uploadMenu && !disabled} onClose={() => { setUploadMenu(false) }} align="end" portal compact autoFocus
        anchor={<button type="button" className={css.tool} aria-label={t('uploadOptions')} disabled={disabled}
          aria-haspopup="menu" aria-expanded={uploadMenu && !disabled} onClick={() => { setUploadMenu(value => !value) }}
          onKeyDown={(event) => { if (!uploadMenu && event.key === 'ArrowDown') { event.preventDefault(); setUploadMenu(true) } }}>
          <IconChevronDownOutlineRegular size={16} /></button>}>
        <MenuItemButton onSelect={() => { setUploadMenu(false); folderInput.current?.click() }}>{t('uploadFolder')}</MenuItemButton>
        <MenuItemButton onSelect={() => { setUploadMenu(false); actions.directory(absolutePath) }}>{t('selectFile', { name: absolutePath })}</MenuItemButton>
      </Menu>
      <Tooltip label={t('download')} side="bottom"><button type="button" className={css.tool} aria-label={t('download')}
        disabled={disabled || selected.length === 0} onClick={() => {
          const paths = [...selected]
          void perform('download', signal => props.download(sessionId, paths, signal))
        }}><IconDownloadOutlineRegular size={16} /></button></Tooltip>
      <Tooltip label={t('newFolder')} side="bottom"><button type="button" className={css.tool} aria-label={t('newFolder')}
        disabled={disabled} onClick={() => { setFolderName(t('untitledFolder')) }}><IconProjectAddOutlineRegular size={16} /></button></Tooltip>
    </div> : <div className={css.progress}>
      <progress value={operation.completed} max={Math.max(1, operation.total)} aria-label={t(operation.kind === 'folder' ? 'newFolder' : operation.kind)} />
      <button type="button" onClick={() => { current.current?.abort() }} disabled={current.current?.signal.aborted}>{t('cancel')}</button>
    </div>}
    <span className={css.errorSeat}>{failure !== undefined && <Tooltip label={t(failure)} side="bottom">
      <button type="button" className={css.tool} aria-label={t(failure)} onClick={() => { setErrorOpen(true) }}>
        <IconWarningOutlineRegular size={16} /></button></Tooltip>}</span>
    {failure !== undefined && <span className={css.srOnly} role="alert">{t(failure)}</span>}
    <Modal open={errorOpen && failure !== undefined} title={t(failure === 'downloadFailed' ? 'download' : failure === 'folderFailed' ? 'newFolder' : 'upload')}
      closeLabel={t('cancel')} onClose={() => { setErrorOpen(false) }}>
      {failure === undefined ? null : <p>{t(failure)}</p>}
    </Modal>
    <Modal open={folderName !== undefined} title={t('newFolder')} closeLabel={t('cancel')}
      onClose={() => { if (operation === undefined) setFolderName(undefined) }}>
      <form className={css.folder} onSubmit={(event) => {
        event.preventDefault()
        const target = directory, name = folderName
        if (name === undefined) return
        void perform('folder', async (signal) => {
          await props.createDirectory(sessionId, target, name, signal)
          if (mounted.current && !props.signal.aborted) { setFolderName(undefined); props.refresh?.() }
        })
      }}>
        <PathLabel path={directory} />
        <Input data-modal-autofocus aria-label={t('newFolder')} value={folderName ?? ''} disabled={disabled}
          onChange={(event) => { setFolderName(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Escape' && !disabled) { event.preventDefault(); setFolderName(undefined) } }} />
        <button type="submit" disabled={disabled || (folderName ?? '').trim() === ''}>{t('newFolder')}</button>
        <button type="button" disabled={disabled} onClick={() => { setFolderName(undefined) }}>{t('cancel')}</button>
      </form>
    </Modal>
  </div>
}

/** Install only while the original account page, Native slots and file provider remain current. */
export function installWorkspaceFileActions(ctx: Context, lifetime: AbortSignal): void {
  if (lifetime.aborted) return
  ctx.inject(['slots', 'locale', 'workspaceFileManagement'], (owner) => {
    if (lifetime.aborted) return
    const store = createWorkspaceFileActionsStore(), operations = owner.workspaceFileManagement
    const removers = new Set<() => void>()
    const track = (remove: () => void): (() => void) => {
      removers.add(remove)
      return () => { removers.delete(remove); remove() }
    }
    const withdraw = (): void => { for (const remove of [...removers].reverse()) remove(); removers.clear() }
    owner.effect(() => track(owner.locale.register(WORKSPACE_FILES_NAMESPACE, workspaceFileDictionaries)), 'Cloud workspace action copy')
    owner.effect(() => track(owner.slots.registerFactory({ name: 'sidebar.files.workspace-entry-actions',
      scope: 'session', store, locale: WORKSPACE_FILES_NAMESPACE }, WorkspaceFileRowActions)), 'Cloud workspace row selection')
    owner.effect(() => track(owner.slots.inject('sidebar.right.tab.files.actions', () => owner.slots.register({
      name: 'sidebar.right.tab.files.actions', id: 'cloud-workspace-files', order: 20, store, locale: WORKSPACE_FILES_NAMESPACE,
      inject: () => ({ signal: lifetime, upload: operations.upload, download: operations.download,
        createDirectory: operations.createDirectory,
        releaseDirectory: async (sessionId: SessionId) => { await owner.parallel('sidebar-files/release-directory', sessionId) } }),
    }, WorkspaceFileActions))), 'Cloud workspace toolbar')
    lifetime.addEventListener('abort', withdraw, { once: true })
    owner.effect(() => () => { lifetime.removeEventListener('abort', withdraw); withdraw() }, 'Cloud workspace action lifetime')
    if (lifetime.aborted) withdraw()
  })
}
