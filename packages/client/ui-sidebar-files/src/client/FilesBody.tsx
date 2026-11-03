/**
 * The file tree's body: the session's workspace root, listed one level at a time.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it asks
 * for goes through its injected face. The component itself only decides what to
 * draw for each absolute path and what a click means: a directory toggles, a
 * file opens through the owner's `tabActions` for a `file:` viewer to claim, and
 * anything else is shown but refuses to open. The header uses the shared
 * PathLabel for the root, followed by reload and workspace directory actions.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, IconRefreshOutlineRegular, Tooltip, classifyFileType,
  IconDownloadOutlineRegular, IconChevronDownOutlineRegular, IconProjectAddOutlineRegular,
  IconPauseOutlineRegular, IconPlayOutlineRegular, Menu, MenuItemButton, PathLabel,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import type {} from './locales.ts'
import type { FilesTabState, createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/** What every level shares: the tab's tree and the two gestures. */
interface TreeContext {
  readonly canManage: boolean
  readonly selected: readonly string[]
  readonly selectFile: (path: string) => void
  readonly selectedDirectory: string | undefined
  readonly draft: { parent: string; name: string; error?: string; pending?: boolean } | undefined
  readonly editDraft: (name: string) => void
  readonly confirmDraft: () => void
  readonly cancelDraft: () => void
  readonly state: FilesTabState
  readonly onToggle: (parent: string, path: string) => void
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  if (entry.type === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <button type="button" className={css.row} aria-current={tree.selectedDirectory === path ? true : undefined} aria-expanded={expanded} onClick={() => { tree.onToggle(parent, path) }}>
          {expanded ? <IconFolderOpenRegular className={css.icon} /> : <IconFolderCloseRegular className={css.icon} />}
          <span className={css.name}>{entry.name}</span>
        </button>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    return (
      <li className={css.item} data-files-entry="file" data-files-path={path}>
        <div className={css.fileRow}>
          {tree.canManage && <input type="checkbox" aria-label={tree.t('selectFile', { name: entry.name })}
            checked={tree.selected.includes(path)} onChange={() => { tree.selectFile(path) }} />}
          <button type="button" className={css.row} onClick={() => { tree.onOpen(path) }}>
            <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
            <span className={css.name}>{entry.name}</span>
          </button>
        </div>
      </li>
    )
  }
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className={css.note} data-files-row="loading">{t('loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
        {failureLine(t, level.failure)}
      </li>
    )
  }
  const entries = orderEntries(level.level.entries)
  return (
    <>
      {level.failure !== undefined && <li className={css.note} data-files-row="failed">{failureLine(t, level.failure)}</li>}
      {tree.draft?.parent === path && <li className={css.draft}>
        <IconFolderCloseRegular />
        <input autoFocus aria-label={t('newFolder')} value={tree.draft.name} disabled={tree.draft.pending === true}
          ref={(input) => { if (input !== null && !input.dataset.selected) { input.select(); input.dataset.selected = 'true' } }}
          onChange={(event) => { tree.editDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); tree.confirmDraft() }
            if (event.key === 'Escape') tree.cancelDraft() }} />
        {tree.draft.error && <span role="alert">{tree.draft.error}</span>}
      </li>}
      {entries.length === 0 && <li className={css.note} data-files-row="empty">{t('empty')}</li>}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/** The file tree's body: the workspace root and whatever the reader has opened under it. */
export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions,
  start, refresh, setAutoRefresh, toggle, t, renderSlot, management,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const [selected, setSelected] = useState<readonly string[]>([])
  const [selectedDirectory, setDirectory] = useState<string>()
  const [draft, setDraft] = useState<TreeContext['draft']>()
  const [uploadMenu, setUploadMenu] = useState(false)
  const [transfer, setTransfer] = useState<{ control: AbortController; completed: number; total: number }>()
  const [failure, setFailure] = useState<string>()
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  useEffect(() => tab.actions.bindCommands({ refresh: () => { refresh(tab.id) } }), [tab.actions, tab.id, refresh])
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  // Come back where the reader was: loaded levels outlive the body in the
  // store, so a remounted tree lays out at its full height before this runs
  // and the stored offset re-lands exactly. A fresh tree stores 0.
  const seeded = state !== undefined
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (seeded && body !== null) {
      body.scrollTop = state.scrollTop
      scrollTopRef.current = body.scrollTop
    }
  }, [seeded])
  // Scrolling only moves the ref; the store hears about it once, on unmount,
  // so a scroll neither re-renders the tree nor writes after the owner's
  // abort has forgotten the bucket.
  useEffect(() => () => {
    if (seeded && !signal.aborted) actions.scrolled(tab.id, scrollTopRef.current)
  }, [seeded, signal, tab.id, actions])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (state === undefined) return null
  const tree: TreeContext = {
    state, selected, selectedDirectory, draft, canManage: management !== undefined,
    selectFile: (path) => { setSelected(old => old.includes(path) ? old.filter(value => value !== path) : [...old, path]) },
    editDraft: (name) => { setDraft(old => old === undefined ? undefined : { ...old, name }) },
    cancelDraft: () => { setDraft(undefined) },
    confirmDraft: () => {
      if (draft === undefined || draft.pending === true || management === undefined) return
      const submitted = { ...draft, pending: true }
      setDraft(submitted)
      void management.createDirectory(sessionId, draft.parent, draft.name, signal).then(() => {
        setDraft(undefined); refresh(tab.id)
      }, () => { setDraft(old => old === submitted ? { ...draft, pending: false, error: t('folderFailed') } : old) })
    },
    onToggle: (parent, path) => {
      setDirectory(state.expanded.includes(path) ? undefined : path)
      toggle(tab.id, parent, path, state.expanded, signal)
    },
    // Every row is under the tree's root, so its address is session-relative.
    onOpen: (path) => { tabActions.openResource(fileAddressFor(sessionId, state.root, path)) },
    t,
  }
  const upload = (list: FileList | null, folder: boolean): void => {
    if (list === null || list.length === 0 || management === undefined || transfer !== undefined) return
    const control = new AbortController()
    const lifetime = AbortSignal.any([signal, control.signal])
    const files = Array.from(list, file => ({ file, path: folder ? file.webkitRelativePath : file.name }))
    setFailure(undefined)
    setTransfer({ control, completed: 0, total: files.reduce((sum, item) => sum + item.file.size, 0) })
    void management.upload(sessionId, selectedDirectory ?? state.root, files, lifetime, (completed, total) => {
      setTransfer({ control, completed, total })
    }).catch(() => { if (!signal.aborted) setFailure(t(control.signal.aborted ? 'cancelledUnknown' : 'transferFailed')) })
      .finally(() => { setTransfer(undefined); refresh(tab.id) })
  }
  const reload = (): void => {
    refresh(tab.id)
  }
  return (
    <div className={css.root} data-files-state="tree" data-files-root={state.root}>
      <div className={css.header}>
        <PathLabel path={state.root} className={css.path} data-files-path />
        <span hidden>
          <button type="button" className={css.tool} aria-label={t('autoRefresh')}
            aria-pressed={state.autoRefresh} data-files-auto-refresh
            title={t(state.autoRefresh ? 'autoRefresh.disable' : 'autoRefresh.enable')}
            onClick={() => { setAutoRefresh(tab.id, !state.autoRefresh) }}>
            {state.autoRefresh ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
          </button>
        </span>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            aria-keyshortcuts={tab.refreshShortcut?.aria}
            data-files-reload
            onClick={reload}
          >
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        {management !== undefined && <>
          <input ref={filesInput} type="file" multiple hidden onChange={(event) => {
            upload(event.target.files, false); event.target.value = ''
          }} />
          <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(event) => {
            upload(event.target.files, true); event.target.value = ''
          }} />
          <Tooltip label={t('upload')} side="bottom"><button type="button" className={css.tool}
            aria-label={t('upload')} disabled={transfer !== undefined} onClick={() => { filesInput.current?.click() }}><IconDownloadOutlineRegular className={css.uploadIcon} /></button></Tooltip>
          <Menu open={uploadMenu} onClose={() => { setUploadMenu(false) }} align="end" portal compact autoFocus
            className={css.uploadMenu} anchor={(
              <button type="button" className={css.dropdown} aria-label={t('uploadOptions')}
                aria-haspopup="menu" aria-expanded={uploadMenu} onClick={() => { setUploadMenu(old => !old) }}
                onKeyDown={(event) => {
                  if (!uploadMenu && event.key === 'ArrowDown') { event.preventDefault(); setUploadMenu(true) }
                }}><IconChevronDownOutlineRegular /></button>
            )}>
            <MenuItemButton onSelect={() => { setUploadMenu(false); folderInput.current?.click() }}>
              {t('uploadFolder')}
            </MenuItemButton>
          </Menu>
          <Tooltip label={t('download')} side="bottom"><button type="button" className={css.tool}
            aria-label={t('download')} disabled={selected.length === 0} onClick={() => {
              setFailure(undefined)
              void management.download(sessionId, selected, signal).catch(() => { setFailure(t('downloadFailed')) })
            }}><IconDownloadOutlineRegular /></button></Tooltip>
          <Tooltip label={t('newFolder')} side="bottom"><button type="button" className={css.tool}
            aria-label={t('newFolder')} disabled={draft?.pending === true} onClick={() => { setDraft({ parent: selectedDirectory ?? state.root, name: t('untitledFolder') }) }}><IconProjectAddOutlineRegular /></button></Tooltip>
        </>}
        {renderSlot('sidebar.right.tab.files.actions' , {
          absolutePath: state.root,
        })}
      </div>
      {transfer !== undefined && <div className={css.transfer} role="status">
        <progress value={transfer.completed} max={Math.max(1, transfer.total)} aria-label={t('upload')} />
        <span>{Math.floor(transfer.completed / Math.max(1, transfer.total) * 100)}%</span>
        <button type="button" onClick={() => { transfer.control.abort() }}>{t('cancel')}</button>
      </div>}
      {failure !== undefined && <div className={css.failure} role="alert">{failure}</div>}
      <div
        ref={bodyRef}
        className={css.body}
        data-files-body
        onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop }}
      >
        <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
      </div>
    </div>
  )
}
