/** Original remote MCP connection list, details, and write-only editing dialogs. */
import { IconPlusOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PERSONAL_MCP_CONNECTION_SERVER_URL_MAX_LENGTH,
  type PersonalMcpConnection,
} from './personal-mcp-client.ts'
import { McpMetadataFields } from './McpMetadataFields.tsx'
import { SkillToggle } from './SkillToggle.tsx'
import { ConnectionCheckCard, DraftCheckControls } from './PersonalMcpCheck.tsx'
import {
  McpDefinitionGrid,
  McpDetailCard,
  McpDetailFrame,
  McpDialogField,
  McpDialogFrame,
  McpList,
  McpListRow,
  McpPageFrame,
} from './McpPresentation.tsx'
import type { PersonalMcpConnectionPort } from './personal-mcp-client.ts'
import {
  resolvePersonalMcpCheckSession,
  type PersonalMcpSessionSource,
} from './personal-mcp-session-view.ts'
import {
  buildPersonalMcpCreateRequest,
  buildPersonalMcpUpdateRequest,
  emptyPersonalMcpForm,
  matchesPersonalMcpSearch,
  newPersonalMcpHeader,
  personalMcpFormFromConnection,
  validatePersonalMcpForm,
  type PersonalMcpFormIssue,
  type PersonalMcpFormValue,
} from './personal-mcp-view.ts'
import { usePersonalMcp, type PersonalMcpModel } from './use-personal-mcp.ts'

/** Browser operations and an explicit native Session source. */
export interface PersonalMcpPageInjected {
  readonly personalMcp: PersonalMcpConnectionPort
  readonly sessions: PersonalMcpSessionSource
  readonly onConnectionsChange?: (items: readonly PersonalMcpConnection[]) => void
}

/** Locale and native slot props for the migrated personal MCP page. */
export type PersonalMcpPageProps = PropsLocale<'powerEvolve.extensionCenter'>
  & InjectFace<PersonalMcpPageInjected>

type DialogState = { readonly kind: 'create' } | {
  readonly kind: 'edit'
  readonly connectionId: string
}

const formIssueLabels: Readonly<Record<PersonalMcpFormIssue, Parameters<PersonalMcpPageProps['t']>[0]>> = {
  'display-name': 'mcpNameInvalid',
  'server-url': 'mcpUrlInvalid',
  'bearer-token': 'mcpBearerInvalid',
  'header-name': 'mcpHeaderNameInvalid',
  'header-value': 'mcpHeaderValueInvalid',
  'header-duplicate': 'mcpHeaderDuplicate',
  'header-limit': 'mcpHeaderLimit',
}

/** Render the original account-owned connection list, details, and editing dialog.
 * @param props - browser Port, Session snapshots, and native locale.
 * @returns the original MCP page layout.
 */
export function PersonalMcpPage(props: PersonalMcpPageProps): ReactNode {
  const [selectedId, setSelectedId] = useState<string>()
  const model = usePersonalMcp(props.personalMcp, props.t, selectedId)
  useEffect(() => {
    if (!model.loading) props.onConnectionsChange?.(model.connections)
  }, [model.connections, model.loading, props.onConnectionsChange])
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<DialogState>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const sessionList = useSyncExternalStore(
    listener => props.sessions.list.subscribe(listener),
    () => props.sessions.list.getSnapshot(),
  )
  const [sessionId, setSessionId] = useState<string>(() => sessionList.current ?? '')
  useEffect(() => {
    const resolved = resolvePersonalMcpCheckSession(sessionList, sessionId)
    if (resolved !== sessionId) setSessionId(resolved)
  }, [sessionId, sessionList.current, sessionList.ids])
  const visible = useMemo(
    () => model.connections.filter(connection => matchesPersonalMcpSearch(connection, search)),
    [model.connections, search],
  )
  const selected = selectedId === undefined
    ? undefined
    : model.connections.find(connection => connection.connection_id === selectedId)
  const dialogProps = {
    busy: model.busyId !== undefined,
    locked: model.failedMutation,
    requestError: model.error,
    personalMcp: props.personalMcp,
    sessionList,
    sessionId,
    t: props.t,
    onSessionChange: setSessionId,
    onClose: () => { setDialog(undefined) },
  }

  if (selected !== undefined) {
    const busy = model.busyId !== undefined
    const blocked = busy || model.failedMutation || !model.available
    return (
      <main className="pext-mcp-page" data-power-evolve-mcp-page>
        {model.error === undefined ? null : <div className="pext-error" role="alert">{model.error}</div>}
        {model.failedMutation && dialog === undefined && <button type="button" className="pext-mcp-button" disabled={busy}
          onClick={() => { void model.retryMutation() }}>{props.t('personalMcpRetryMutation')}</button>}
        <McpDetailFrame
          label={props.t('mcpConnectionDetails')}
          backLabel={props.t('backToMcpConnections')}
          name={selected.display_name}
          description={selected.presentation?.note || selected.server_url}
          {...(selected.presentation?.icon ? { icon: selected.presentation.icon } : {})}
          meta={`${selected.server_name} · ${props.t('mcpRevision')} ${String(selected.revision)}`}
          status={<ConnectionState connection={selected} t={props.t} />}
          action={(
            <div className="pext-mcp-detail-actions">
              <button
                type="button"
                className="pext-mcp-button"
                disabled={blocked}
                onClick={() => {
                  model.clearError()
                  setDialog({ kind: 'edit', connectionId: selected.connection_id })
                }}
              >
                {props.t('editMcpConnection')}
              </button>
              <button
                type="button"
                className="pext-mcp-button pext-mcp-button-danger"
                disabled={blocked}
                onClick={() => { setConfirmDelete(true) }}
              >
                {props.t('deleteMcpConnection')}
              </button>
            </div>
          )}
          onBack={() => { model.clearError(); setConfirmDelete(false); setSelectedId(undefined) }}
        >
          <div className="pext-mcp-notice">{props.t('personalMcpNextTaskNotice')}</div>
          {confirmDelete
            ? (
              <div className="pext-mcp-delete-confirm" role="alert">
                <span>{props.t('mcpDeleteWarning')}</span>
                <div>
                  <button type="button" className="pext-mcp-button" disabled={blocked} onClick={() => { setConfirmDelete(false) }}>
                    {props.t('cancel')}
                  </button>
                  <button
                    type="button"
                    className="pext-mcp-button pext-mcp-button-danger-solid"
                    disabled={blocked}
                    onClick={() => { void removeSelected(model, selected, setSelectedId) }}
                  >
                    {model.busyId === selected.connection_id
                      ? props.t('mcpDeleting')
                      : props.t('confirmDeleteMcpConnection')}
                  </button>
                </div>
              </div>
            )
            : null}
          <McpDetailCard
            title={props.t('mcpConnectionConfiguration')}
            description={props.t('mcpConnectionConfigurationHint')}
          >
            <McpDefinitionGrid entries={[
              { key: 'url', term: props.t('mcpServerUrl'), value: selected.server_url },
              { key: 'name', term: props.t('mcpServerName'), value: selected.server_name },
              {
                key: 'authentication',
                term: props.t('mcpAuthentication'),
                value: selected.authentication.kind === 'bearer'
                  ? props.t('mcpAuthenticationBearer')
                  : selected.authentication.kind === 'headers'
                    ? props.t('mcpAuthenticationHeaders')
                    : props.t('mcpAuthenticationNone'),
              },
              { key: 'revision', term: props.t('mcpRevision'), value: selected.revision },
            ]} monoFirst />
          </McpDetailCard>
          <ConnectionCheckCard
            connection={selected}
            client={props.personalMcp}
            model={model}
            sessionList={sessionList}
            sessionId={sessionId}
            t={props.t}
            onSessionChange={setSessionId}
          />
          <div className="pext-mcp-setting-row">
            <div>
              <strong>{selected.enabled ? props.t('mcpEnabled') : props.t('mcpDisabled')}</strong>
              <p>{props.t('personalMcpNextTaskNotice')}</p>
            </div>
            <SkillToggle
              label={`${selected.display_name} ${props.t('mcpEnable')}`}
              checked={selected.enabled}
              disabled={blocked}
              onChange={(enabled) => { void toggleConnection(model, selected, enabled) }}
            />
          </div>
        </McpDetailFrame>
        {dialog === undefined ? null : (
          <ConnectionDialog
            key={`${dialog.kind}:${selected.connection_id}:${String(selected.revision)}`}
            current={selected}
            {...dialogProps}
            onSubmit={async (form) => {
              const updated = model.failedMutation ? await model.retryMutation() : await model.update(
                selected.connection_id,
                buildPersonalMcpUpdateRequest(form, selected),
              )
              if (updated !== undefined) setDialog(undefined)
            }}
          />
        )}
      </main>
    )
  }

  const globallyBusy = model.busyId !== undefined || model.failedMutation
  return (
    <>
      <McpPageFrame
        title={props.t('personalMcpTitle')}
        subtitle={props.t('personalMcpSubtitle')}
        tabLabel={props.t('personalMcpTab')}
        tabMeta={model.connections.length}
        searchLabel={props.t('personalMcpSearch')}
        searchPlaceholder={props.t('personalMcpSearch')}
        searchValue={search}
        onSearchChange={setSearch}
        toolbar={(
          <>
            <span>{props.t('personalMcpNextTaskNotice')}</span>
            <div className="pext-mcp-toolbar-actions">
              <button
                type="button"
                className="pext-mcp-button"
                disabled={model.loading || globallyBusy}
                onClick={() => { void model.reload() }}
              >
                <IconRefreshOutlineRegular size={15} />{props.t('refreshList')}
              </button>
              <button
                type="button"
                className="pext-mcp-button pext-mcp-button-primary"
                disabled={globallyBusy || !model.available}
                onClick={() => { model.clearError(); setDialog({ kind: 'create' }) }}
              >
                <IconPlusOutlineRegular size={15} />{props.t('addMcpConnection')}
              </button>
            </div>
          </>
        )}
      >
        {model.error === undefined ? null : <div className="pext-error" role="alert">{model.error}</div>}
        {!model.available && !model.loading && <div className="pext-error" role="status">{props.t('personalMcpUnavailable')}</div>}
        {model.failedMutation && dialog === undefined && <button type="button" className="pext-mcp-button" disabled={model.busyId !== undefined}
          onClick={() => { void model.retryMutation() }}>{props.t('personalMcpRetryMutation')}</button>}
        {model.loading
          ? <div className="pext-loading">{props.t('loading')}</div>
          : visible.length === 0
            ? <div className="pext-empty">{model.connections.length === 0 ? props.t('personalMcpEmpty') : props.t('personalMcpNoMatch')}</div>
            : (
              <McpList>
                {visible.map(connection => (
                  <McpListRow
                    key={connection.connection_id}
                    openLabel={`${props.t('openMcpConnection')} ${connection.display_name}`}
                    title={connection.display_name}
                    badge={connection.authentication.kind === 'bearer'
                      ? props.t('mcpAuthenticationBearer')
                      : connection.authentication.kind === 'headers'
                        ? props.t('mcpAuthenticationHeaders')
                        : undefined}
                    description={connection.presentation?.note || connection.server_url}
                    {...(connection.presentation?.icon ? { icon: connection.presentation.icon } : {})}
                    meta={`${connection.server_name} · ${props.t('mcpRevision')} ${String(connection.revision)}`}
                    status={<ConnectionState connection={connection} t={props.t} />}
                    action={(
                      <SkillToggle
                        label={`${connection.display_name} ${props.t('mcpEnable')}`}
                        checked={connection.enabled}
                        disabled={globallyBusy || !model.available}
                        onChange={(enabled) => { void toggleConnection(model, connection, enabled) }}
                      />
                    )}
                    onOpen={() => { model.clearError(); setConfirmDelete(false); setSelectedId(connection.connection_id) }}
                  />
                ))}
              </McpList>
            )}
        {model.nextCursor === undefined ? null : (
          <div className="pext-load-more">
            <button
              type="button"
              className="pext-mcp-button"
              disabled={model.loadingMore || globallyBusy}
              onClick={() => { void model.loadMore() }}
            >
              {model.loadingMore ? props.t('loading') : props.t('loadMore')}
            </button>
          </div>
        )}
      </McpPageFrame>
      {dialog?.kind !== 'create' ? null : (
        <ConnectionDialog
          current={undefined}
          {...dialogProps}
          onSubmit={async (form) => {
            const created = model.failedMutation ? await model.retryMutation()
              : await model.create(buildPersonalMcpCreateRequest(form))
            if (created !== undefined) setDialog(undefined)
          }}
        />
      )}
    </>
  )
}

function ConnectionDialog({
  current,
  busy,
  locked,
  requestError,
  personalMcp,
  sessionList,
  sessionId,
  t,
  onSessionChange,
  onClose,
  onSubmit,
}: {
  readonly current: PersonalMcpConnection | undefined
  readonly busy: boolean
  readonly locked: boolean
  readonly requestError: string | undefined
  readonly personalMcp: PersonalMcpConnectionPort
  readonly sessionList: ReturnType<PersonalMcpSessionSource['list']['getSnapshot']>
  readonly sessionId: string
  readonly t: PersonalMcpPageProps['t']
  readonly onSessionChange: (value: string) => void
  readonly onClose: () => void
  readonly onSubmit: (form: PersonalMcpFormValue) => Promise<void>
}): ReactNode {
  const [form, setForm] = useState(() => current === undefined
    ? emptyPersonalMcpForm()
    : personalMcpFormFromConnection(current))
  const [validation, setValidation] = useState<ReturnType<typeof validatePersonalMcpForm>>()
  const update = (patch: Partial<PersonalMcpFormValue>): void => { setForm(value => ({ ...value, ...patch })) }
  const validationMessage = validation === undefined ? undefined : t(formIssueLabels[validation])
  const displayedError = validationMessage ?? requestError
  return (
    <McpDialogFrame
      open
      title={current === undefined ? t('createMcpConnection') : t('editMcpConnection')}
      closeLabel={t('close')}
      onClose={onClose}
      footer={(
        <div className="pext-mcp-dialog-actions">
          <button type="button" className="pext-mcp-button" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button
            type="button"
            className="pext-mcp-button pext-mcp-button-primary"
            disabled={busy}
            onClick={() => {
              const error = validatePersonalMcpForm(form, current)
              setValidation(error)
              if (error === undefined) void onSubmit(form)
            }}
          >
            {busy ? t('mcpSaving') : locked ? t('personalMcpRetryMutation') : t('saveMcpConnection')}
          </button>
        </div>
      )}
    >
      {displayedError === undefined ? null : <div className="pext-error" role="alert">{displayedError}</div>}
      <fieldset className="pext-mcp-edit-fields" disabled={busy || locked}>
        <McpDialogField label={t('mcpDisplayName')}>
          <input
            value={form.displayName}
            maxLength={200}
            autoComplete="off"
            onChange={(event) => { update({ displayName: event.target.value }); setValidation(undefined) }}
          />
        </McpDialogField>
        <McpMetadataFields value={form.presentation} t={t} onChange={(presentation) => { update({ presentation }) }} />
        <McpDialogField label={t('mcpServerUrl')}>
          <input
            type="url"
            value={form.serverUrl}
            maxLength={PERSONAL_MCP_CONNECTION_SERVER_URL_MAX_LENGTH}
            placeholder={t('mcpServerUrlPlaceholder')}
            autoComplete="off"
            onChange={(event) => { update({ serverUrl: event.target.value }); setValidation(undefined) }}
          />
        </McpDialogField>
        <McpDialogField label={t('mcpAuthentication')}>
          <select
            value={form.authenticationKind}
            onChange={(event) => {
              const kind = event.target.value === 'bearer'
                ? 'bearer'
                : event.target.value === 'headers' ? 'headers' : 'none'
              update({ authenticationKind: kind, bearerToken: '', clearBearerSecret: false })
              setValidation(undefined)
            }}
          >
            <option value="none">{t('mcpAuthenticationNone')}</option>
            <option value="bearer">{t('mcpAuthenticationBearer')}</option>
            <option value="headers">{t('mcpAuthenticationHeaders')}</option>
          </select>
        </McpDialogField>
        {form.authenticationKind !== 'bearer' ? null : (
          <>
            <McpDialogField label={t('mcpBearerToken')}>
              <input
                type="password"
                value={form.bearerToken}
                maxLength={8192}
                autoComplete="new-password"
                placeholder={current?.authentication.kind === 'bearer'
                && current.authentication.secret_configured ? t('mcpBearerTokenPlaceholder') : undefined}
                onChange={(event) => {
                  update({ bearerToken: event.target.value, clearBearerSecret: false })
                  setValidation(undefined)
                }}
              />
            </McpDialogField>
            {current?.authentication.kind === 'bearer' && current.authentication.secret_configured
              ? (
                <label className="pext-mcp-checkbox">
                  <input
                    type="checkbox"
                    checked={form.clearBearerSecret}
                    onChange={(event) => {
                      update({ clearBearerSecret: event.target.checked, bearerToken: '' })
                      setValidation(undefined)
                    }}
                  />
                  <span>{form.clearBearerSecret ? t('mcpClearBearer') : t('mcpBearerConfigured')}</span>
                </label>
              )
              : null}
          </>
        )}
        {form.authenticationKind !== 'headers' ? null : (
          <fieldset className="pext-mcp-headers">
            <legend>{t('mcpHeaders')}</legend>
            <p>{t('mcpHeadersHint')}</p>
            <div className="pext-mcp-header-list">
              {form.headers.map(header => (
                <div key={header.id} className="pext-mcp-header-row">
                  <input
                    value={header.name}
                    aria-label={t('mcpHeaderName')}
                    placeholder={t('mcpHeaderNamePlaceholder')}
                    autoComplete="off"
                    onChange={(event) => {
                      update({ headers: form.headers.map(item => item.id === header.id
                        ? { ...item, name: event.target.value }
                        : item) })
                      setValidation(undefined)
                    }}
                  />
                  <input
                    type="password"
                    value={header.value}
                    aria-label={`${header.name || t('mcpHeaderName')} ${t('mcpHeaderValue')}`}
                    placeholder={header.savedName === undefined ? t('mcpHeaderValue') : t('mcpHeaderValuePreserve')}
                    autoComplete="new-password"
                    onChange={(event) => {
                      update({ headers: form.headers.map(item => item.id === header.id
                        ? { ...item, value: event.target.value }
                        : item) })
                      setValidation(undefined)
                    }}
                  />
                  <button
                    type="button"
                    className="pext-mcp-button pext-mcp-button-danger"
                    aria-label={`${t('mcpRemoveHeader')} ${header.name}`}
                    onClick={() => { update({ headers: form.headers.filter(item => item.id !== header.id) }) }}
                  >
                    {t('mcpRemoveHeader')}
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="pext-mcp-button"
              disabled={form.headers.length >= 16}
              onClick={() => { update({ headers: [...form.headers, newPersonalMcpHeader(form.headers.length)] }) }}
            >
              <IconPlusOutlineRegular size={14} />{t('mcpAddHeader')}
            </button>
          </fieldset>
        )}
        <label className="pext-mcp-checkbox">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => { update({ enabled: event.target.checked }); setValidation(undefined) }}
          />
          <span>{current === undefined ? t('mcpEnabledOnCreate') : t('mcpEnabledField')}</span>
        </label>
      </fieldset>
      <section className="pext-mcp-draft-check">
        <strong>{t('mcpDraftCheckTitle')}</strong>
        <span>{t('mcpDraftCheckHint')}</span>
        <DraftCheckControls
          configuration={buildPersonalMcpCreateRequest(form, current)}
          {...(current === undefined ? {} : { connection: current })}
          client={personalMcp}
          blocked={busy || locked || validatePersonalMcpForm(form, current) !== undefined}
          sessionList={sessionList}
          sessionId={sessionId}
          t={t}
          onSessionChange={onSessionChange}
        />
      </section>
    </McpDialogFrame>
  )
}

function ConnectionState({
  connection,
  t,
}: {
  readonly connection: PersonalMcpConnection
  readonly t: PersonalMcpPageProps['t']
}): ReactNode {
  return (
    <span className="pext-mcp-state" data-enabled={connection.enabled || undefined}>
      {connection.enabled ? t('mcpEnabled') : t('mcpDisabled')}
    </span>
  )
}

async function toggleConnection(
  model: PersonalMcpModel,
  connection: PersonalMcpConnection,
  enabled: boolean,
): Promise<void> {
  await model.toggle(connection.connection_id, connection.revision, enabled)
}

async function removeSelected(
  model: PersonalMcpModel,
  connection: PersonalMcpConnection,
  setSelectedId: (value: string | undefined) => void,
): Promise<void> {
  if (await model.remove(connection.connection_id, connection.revision)) setSelectedId(undefined)
}
