/** Private storage selection and existing Workspace recovery inside the native directory modal. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  bindingRequestId, storageDirectoryCreateRequest, workspaceBindingRestoreRequest, workspaceCreateSelection,
  type StorageSpaceView, type StorageDirectoriesView, type WorkspaceBindingView, type WorkspaceBindingReceipt,
} from '@power-evolve/contracts/workspace-binding'
import type { createCloudWorkspaceStore } from './store.ts'
import { WorkspaceBindingHttpError, type WorkspaceBindingActions } from './api.ts'
import { cloudWorkspaceSelectionPath } from './path.ts'
import type { CloudWorkspaceLocaleKey } from './locales.ts'

type Props = PropsRuntime<'conversation.hero.workspace.directoryFlow'>
  & PropsLocale<'powerEvolve.cloudWorkspaces'> & PropsStore<ReturnType<typeof createCloudWorkspaceStore>>
  & WorkspaceBindingActions
type Mode = 'new' | 'existing' | 'restore'

function failure(error: unknown): CloudWorkspaceLocaleKey {
  if (error instanceof WorkspaceBindingHttpError) {
    if (error.code === 'workspace_storage_overlap') return 'overlap'
    if (error.code === 'workspace_binding_generation_conflict' || error.code === 'workspace_binding_changed') return 'changed'
    if (error.status === 401 || error.status === 403) return 'denied'
    if (error.status === 409) return 'conflict'
  }
  return 'failed'
}

/** Shared native picker occupant; recovery never calls the owner's creation callback.
 * @param props - native owner, generated store hooks, localized text and bounded operation callbacks.
 * @returns the modal and its creation, browsing and recovery controls.
 */
export function CloudWorkspaceFlow({ open, busy, onPicked, onCancel, t, useStore, actions,
  listStorageSpaces, listMissingBindings, listStorageDirectories, createStorageDirectory, restoreBinding, checkBindingStatus }: Props) {
  const remembered = useStore(state => state)
  const [mode, setMode] = useState<Mode>('new')
  const [name, setName] = useState(remembered.create?.title ?? '')
  const [spaces, setSpaces] = useState<StorageSpaceView[]>([])
  const [missing, setMissing] = useState<WorkspaceBindingView[]>([])
  const [spaceId, setSpaceId] = useState('')
  const [parent, setParent] = useState('')
  const [cursor, setCursor] = useState<string | undefined>()
  const [page, setPage] = useState<StorageDirectoriesView | null>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [directoryName, setDirectoryName] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [directoryLoading, setDirectoryLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<CloudWorkspaceLocaleKey | null>(null)
  const [receipt, setReceipt] = useState<WorkspaceBindingReceipt | null>(null)
  const [reload, setReload] = useState(0)
  const operation = useRef<AbortController | null>(null)
  const submitted = useRef(false)
  const mounted = useRef(true)
  const currentAttempt = useRef<ReturnType<typeof workspaceBindingRestoreRequest.parse> | null>(null)
  const id = useId()
  const space = spaces.find(item => item.spaceId === spaceId && item.available)
  const workspace = missing.find(item => item.workspaceId === workspaceId)
  const pending = receipt?.state === 'accepted' || receipt?.state === 'stopping'
  const confirmedBlocked = receipt?.state === 'blocked' && receipt.workspaceId === workspace?.workspaceId
    && (receipt.requestId === workspace?.recoveryRequestId || receipt.requestId === remembered.restore?.requestId)
  const unconfirmedRecovery = workspace?.recoveryRequestId !== null && workspace?.recoveryRequestId !== undefined
    && receipt?.requestId !== workspace.recoveryRequestId && currentAttempt.current?.workspaceId !== workspace.workspaceId
  const resumed = currentAttempt.current?.workspaceId === workspace?.workspaceId ? currentAttempt.current
    : workspace?.recoveryRequestId ? { requestId: workspace.recoveryRequestId,
    workspaceId: workspace.workspaceId, expectedGeneration: workspace.generation }
    : remembered.restore?.workspaceId === workspace?.workspaceId || workspace === undefined ? remembered.restore : null
  const unknownRecoveryTarget = workspace?.recoveryRequestId !== null && workspace?.recoveryRequestId !== undefined
    && remembered.restore?.requestId !== workspace.recoveryRequestId
    && currentAttempt.current?.workspaceId !== workspace.workspaceId && !confirmedBlocked
  const locked = busy || working || mode === 'restore' && (pending || unconfirmedRecovery)
  const editLocked = locked || currentAttempt.current !== null && receipt === null
  const browsing = mode !== 'new'
  const selected = space !== undefined && page?.spaceId === space.spaceId && page.parentPath === parent && !directoryLoading

  useEffect(() => {
    if (!open) { submitted.current = false; currentAttempt.current = null; setReceipt(null); setWorking(false); setError(null); return }
    const controller = new AbortController()
    setCatalogLoading(true)
    void Promise.allSettled([listStorageSpaces(controller.signal), listMissingBindings(controller.signal)]).then(results => {
      if (controller.signal.aborted) return
      const [storage, bindings] = results
      if (storage.status === 'fulfilled') {
        setSpaces(storage.value)
        setSpaceId(current => storage.value.some(item => item.spaceId === current && item.available) ? current
          : (storage.value.find(item => item.available && item.isDefault) ?? storage.value.find(item => item.available))?.spaceId ?? '')
      } else setError(failure(storage.reason))
      if (bindings.status === 'fulfilled') {
        setMissing(bindings.value)
        setWorkspaceId(current => bindings.value.some(item => item.workspaceId === current) ? current : bindings.value[0]?.workspaceId ?? '')
      } else setError(failure(bindings.reason))
      setCatalogLoading(false)
    })
    return () => { controller.abort() }
  }, [open, reload, listStorageSpaces, listMissingBindings])

  useEffect(() => {
    if (!open || !browsing || space === undefined) { setPage(null); setDirectoryLoading(false); return }
    const controller = new AbortController()
    setDirectoryLoading(true)
    setPage(null)
    void listStorageDirectories({ spaceId: space.spaceId, parentPath: parent, limit: 100,
      ...(cursor === undefined ? {} : { cursor }) }, controller.signal).then(next => {
      if (!controller.signal.aborted) { setPage(next); setDirectoryLoading(false) }
    }, reason => {
      if (!controller.signal.aborted) { setError(failure(reason)); setDirectoryLoading(false) }
    })
    return () => { controller.abort() }
  }, [open, browsing, space?.spaceId, parent, cursor, reload, listStorageDirectories])

  useEffect(() => () => { operation.current?.abort(); operation.current = null }, [open])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const navigate = (path: string) => { setParent(path); setCursor(undefined); setError(null) }
  const requestId = () => bindingRequestId.parse(crypto.randomUUID())
  const create = () => {
    if (locked || submitted.current || (mode === 'existing' && !selected)) return
    const target = mode === 'existing' && space ? { spaceId: space.spaceId, rootRelativePath: parent } : undefined
    const previous = remembered.create
    const same = previous?.title === name.trim() && previous.target?.spaceId === target?.spaceId
      && previous.target?.rootRelativePath === target?.rootRelativePath
    const parsed = workspaceCreateSelection.safeParse({ requestId: same ? previous.requestId : requestId(), title: name,
      ...(target === undefined ? {} : { target }) })
    if (!parsed.success) { setError('invalid'); return }
    actions.rememberCreate(parsed.data)
    submitted.current = true
    setError(null)
    void Promise.resolve(onPicked(cloudWorkspaceSelectionPath(parsed.data))).then(result => {
      if (result === true) actions.completeCreate(parsed.data.requestId)
      else if (mounted.current) submitted.current = false
    }, () => {
      if (mounted.current) { submitted.current = false; setError('failed') }
    })
  }
  const begin = () => {
    if (operation.current !== null || busy) return null
    const controller = new AbortController()
    operation.current = controller
    setWorking(true)
    setError(null)
    return controller
  }
  const finish = (controller: AbortController) => {
    if (operation.current === controller) operation.current = null
    if (!controller.signal.aborted) setWorking(false)
  }
  const mkdir = async () => {
    if (!space || locked || !selected) return
    const previous = remembered.directory
    const input = storageDirectoryCreateRequest.safeParse({ requestId: previous?.spaceId === space.spaceId
      && previous.parentPath === parent && previous.name === directoryName.trim() ? previous.requestId : requestId(),
      spaceId: space.spaceId, parentPath: parent, name: directoryName.trim() })
    if (!input.success) { setError('invalidDirectory'); return }
    const controller = begin()
    if (!controller) return
    actions.rememberDirectory(input.data)
    try {
      const next = await createStorageDirectory(input.data, controller.signal)
      if (!controller.signal.aborted) { setDirectoryName(''); navigate(next.path) }
    } catch (reason) { if (!controller.signal.aborted) setError(failure(reason)) }
    finally { finish(controller) }
  }
  const recover = async (check: boolean) => {
    const previous = remembered.restore
    if (check ? !resumed : !space || !workspace || !selected || locked || unknownRecoveryTarget) return
    const input = check ? null : workspaceBindingRestoreRequest.parse({
      requestId: !confirmedBlocked && previous?.workspaceId === workspace!.workspaceId && previous.expectedGeneration === workspace!.generation
        && previous.spaceId === space!.spaceId && previous.rootRelativePath === parent ? previous.requestId : requestId(),
      workspaceId: workspace!.workspaceId, expectedGeneration: workspace!.generation,
      spaceId: space!.spaceId, rootRelativePath: parent,
    })
    const controller = begin()
    if (!controller) return
    if (input) { currentAttempt.current = input; actions.rememberRestore(input); setReceipt(null) }
    try {
      const next = await (input ? restoreBinding(input, controller.signal) : checkBindingStatus(resumed!, controller.signal))
      if (controller.signal.aborted) return
      setReceipt(next)
      setMissing(current => current.map(item => item.workspaceId === next.workspaceId
        ? { ...item, recoveryRequestId: next.requestId, state: next.state === 'blocked' ? 'blocked' : 'recovering' } : item))
      if (next.state === 'completed') {
        try {
          const current = await listMissingBindings(controller.signal)
          if (!controller.signal.aborted) setMissing(current)
        } catch (reason) { if (!controller.signal.aborted) setError('refreshFailed') }
      }
    } catch (reason) { if (!controller.signal.aborted) setError(failure(reason)) }
    finally { finish(controller) }
  }
  const changeMode = (next: Mode) => { setMode(next); setError(null); setReceipt(null) }
  const progress = receipt?.state === 'accepted' ? 'accepted' : receipt?.state === 'stopping' ? 'stopping'
    : receipt?.state === 'completed' ? 'completed' : receipt?.state === 'blocked' ? 'blocked' : null

  return <Modal open={open} onClose={() => { if (!busy && !working) onCancel() }} title={t('title')}
    closeLabel={t('close')} footer={<>
      <Button disabled={busy || working} onClick={onCancel}>{t('cancel')}</Button>
      {mode === 'restore'
        ? <Button variant="primary" disabled={locked || !workspace || !selected || unknownRecoveryTarget} aria-busy={working}
            onClick={() => { void recover(false) }}>{t('restore')}</Button>
        : <Button variant="primary" disabled={locked || (mode === 'existing' && !selected)} aria-busy={busy}
            onClick={create}>{t('create')}</Button>}
    </>}>
    <div className="pe-cloud-workspace-body">
      <SegmentedControl id={id} label={t('mode')} value={mode} disabled={editLocked}
        options={[{ value: 'new', label: t('newDirectory') }, { value: 'existing', label: t('existingDirectory') },
          { value: 'restore', label: t('recovery') }]} onChange={changeMode} />
      <div id={`${id}-${mode}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`} className="pe-cloud-workspace-body">
        {mode !== 'restore' ? <label className="pe-cloud-workspace-field">
          <span>{t('name')}</span>
          <input className="pe-cloud-workspace-input" data-modal-autofocus value={name} maxLength={80} disabled={locked}
            onChange={event => { setName(event.target.value); setError(null) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create() } }} />
        </label> : <>
          <p>{t('recoveryDescription')}</p>
          <label className="pe-cloud-workspace-field"><span>{t('missingWorkspace')}</span>
            <select className="pe-cloud-workspace-input" value={workspaceId} disabled={editLocked || catalogLoading}
              onChange={event => { setWorkspaceId(event.target.value); setReceipt(null); setError(null) }}>
              {missing.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
            </select>
          </label>
          {!catalogLoading && missing.length === 0 && <p>{t('noMissing')}</p>}
        </>}
        {mode === 'new' && <p>{t('newDescription')}</p>}
        {browsing && <>
          <label className="pe-cloud-workspace-field"><span>{t('storage')}</span>
            <select className="pe-cloud-workspace-input" value={spaceId} disabled={editLocked || catalogLoading}
              onChange={event => { setSpaceId(event.target.value); navigate('') }}>
              {spaces.map(item => <option key={item.spaceId} value={item.spaceId} disabled={!item.available}>{item.title}</option>)}
            </select>
          </label>
          {!catalogLoading && space === undefined && <p>{t('noStorage')}</p>}
          {space && <>
            <div className="pe-cloud-workspace-toolbar">
              <Button disabled={editLocked || directoryLoading || parent === ''} onClick={() => { navigate(parent.split('/').slice(0, -1).join('/')) }}>{t('parent')}</Button>
              <Button disabled={editLocked || directoryLoading} onClick={() => { navigate(''); setReload(value => value + 1) }}>{t('root')}</Button>
              <span>{t('selectedDirectory')}: <span data-storage-selection>{parent || t('root')}</span></span>
            </div>
            <ul className="pe-cloud-workspace-directories" aria-label={t('directories')} aria-busy={directoryLoading}>
              {page?.entries.map(entry => <li key={entry.path}><Button disabled={editLocked || directoryLoading}
                onClick={() => { navigate(entry.path) }}>{entry.name}</Button></li>)}
            </ul>
            {page && page.entries.length === 0 && <p>{t('noDirectories')}</p>}
            {page?.nextCursor && <Button disabled={editLocked || directoryLoading} onClick={() => { setCursor(page.nextCursor); setError(null) }}>{t('nextPage')}</Button>}
            <div className="pe-cloud-workspace-toolbar">
              <label className="pe-cloud-workspace-field"><span>{t('directoryName')}</span>
                <input className="pe-cloud-workspace-input" value={directoryName} maxLength={100} disabled={editLocked || !selected}
                  onChange={event => { setDirectoryName(event.target.value); setError(null) }} />
              </label>
              <Button disabled={editLocked || !selected || directoryName.trim() === ''} onClick={() => { void mkdir() }}>{t('mkdir')}</Button>
            </div>
          </>}
        </>}
      </div>
      {(catalogLoading || directoryLoading || working) && <p role="status">{t('loading')}</p>}
      {progress && <p role="status">{t(progress)}</p>}
      {mode === 'restore' && unknownRecoveryTarget && !receipt && <p role="status">{t('resumeRecovery')}</p>}
      {mode === 'restore' && resumed && <Button disabled={busy || working}
        onClick={() => { void recover(true) }}>{t('checkStatus')}</Button>}
      {error && <p className="pe-cloud-workspace-error" role="alert">{t(error)}</p>}
      {error && <Button disabled={locked} onClick={() => { setError(null); setCursor(undefined); setReload(value => value + 1) }}>{t('refresh')}</Button>}
    </div>
  </Modal>
}
