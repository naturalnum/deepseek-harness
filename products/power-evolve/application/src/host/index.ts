/** Authenticated product RPC carrier over the native Typert Gateway. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createScope } from '@deepseek-ai/dsh-scope'
import { TypertRemoteService, Remote, type PeerScope, type PeerId, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { createRequest, sessionFilesListRequest, sessionFileReadRequest, sessionFilePutRequest, listRequest, pageRequest, promptRequest, settingsUpdateRequest, builtinSkillInstallRequest, skillInstallRequest, skillRequest, skillToggleRequest, sshCreateTicketRequest, sshToggleRequest, sshCheckRequest, sshCallRefRequest, sshCheckView, sshExecuteRefRequest, sshExecuteView, PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson, writeLine } from '../http.ts'
import { serveNativeUi, serveUi } from '../ui.ts'
import { BrowserAgentAuth } from './browser-auth.ts'
import { installNativeRemote } from './native-remote.ts'
import { Scheduler } from './scheduler.ts'
import { mcpManagementRequests, mcpManagementEndpoints, mcpTicketValue } from '../mcp-management-rpc.ts'
import { sshManagementRequests, sshManagementEndpoints, sshConnectionValue,
  sshCredentialTicketValue, sshMutationReceiptValue } from '../ssh-management-contracts.ts'
import { ACCOUNT_ROUTES, accountCapabilitiesValue, accountEmptyRequest } from '../account-contracts.ts'
import { FILE_DOWNLOAD_CONTENT_PATH, fileDownloadPrepareRequest, fileDownloadView,
  fileDownloadUrl } from '@power-evolve/contracts/file-download'
import { parseFileDownloadQuery, proxyFileDownload } from '../file-download-http.ts'
import { WORKSPACE_BINDING_ROUTES, storageDirectoriesRequest, storageDirectoryCreateRequest,
  storageSpacesView, storageDirectoriesView, storageDirectoryView, workspaceBindingsMissingView,
  workspaceBindingRestoreRequest, workspaceBindingStatusRequest, workspaceBindingReceipt } from '@power-evolve/contracts/workspace-binding'
import { artifactPublishRequest, executionFilesRequest, executionFilesView,
  EXECUTION_FILES_PLATFORM_PATH } from '@power-evolve/contracts/execution-files'
import { EXECUTION_RESOLUTION_ROUTES, executionResolutionsListRequest, executionResolutionsList,
  executionResolutionInspectRequest, executionResolutionInspection,
  executionResolutionStatusRequest, executionResolutionStatus } from '@power-evolve/contracts/execution-resolution'
import { DESKTOP_BROWSER_SCOPE_PLATFORM_PATH, desktopBrowserScopeRequest,
  desktopBrowserScopeView } from '@power-evolve/contracts/desktop-browser-scope'

const requests = { ...mcpManagementRequests, ...sshManagementRequests, me: z.object({}).strict(), logout: z.object({}).strict(), modelsList: z.object({}).strict(), settingsUpdate: settingsUpdateRequest,
  storageSpaces: z.object({}).strict(), storageDirectories: storageDirectoriesRequest,
  storageDirectoryCreate: storageDirectoryCreateRequest, workspaceBindingsMissing: z.object({}).strict(),
  workspaceBindingRestore: workspaceBindingRestoreRequest, workspaceBindingStatus: workspaceBindingStatusRequest,
  accountCapabilities: accountEmptyRequest,
  desktopBrowserScope: desktopBrowserScopeRequest,
  create: createRequest, list: listRequest, prompt: promptRequest, page: pageRequest, follow: pageRequest,
  filesList: sessionFilesListRequest, filesRead: sessionFileReadRequest, filesPut: sessionFilePutRequest,
  filesDownloadPrepare: fileDownloadPrepareRequest,
  skillsList: z.object({}).strict(), skillsRead: skillRequest,
  skillsCatalog: z.object({}).strict(), skillsInstallBuiltin: builtinSkillInstallRequest,
  skillsInstall: skillInstallRequest, skillsToggle: skillToggleRequest,
  skillsUploadTicket: z.object({ requestId: z.uuid(), sizeBytes: z.number().int().min(1).max(1024 * 1024),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
  skillsRevoke: skillRequest, actionsList: z.object({}).strict(),
  pluginsList: z.object({}).strict(),
  pluginsNotesSetEnabled: z.object({ requestId: z.uuid(), expectedRevision: z.number().int().positive(),
    enabled: z.boolean() }).strict(),
  mcpList: z.object({}).strict(),
  mcpInstall: z.object({ requestId: z.uuid(), name: z.string().trim().min(1).max(80) }).strict(),
  mcpToggle: z.object({ connectionId: z.uuid(), requestId: z.uuid(), baseRevision: z.number().int().positive(),
    enabled: z.boolean() }).strict(),
  mcpCheck: z.object({ connectionId: z.uuid() }).strict(),
  stdioMcpList: z.object({}).strict(),
  stdioMcpInstall: z.object({ requestId: z.uuid(), name: z.string().trim().min(1).max(80) }).strict(),
  stdioMcpToggle: z.object({ connectionId: z.uuid(), requestId: z.uuid(),
    baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict(),
  stdioMcpCalls: z.object({}).strict(), stdioMcpStatus: z.object({ callId: z.uuid() }).strict(),
  sshList: z.object({}).strict(), sshCreateTicket: sshCreateTicketRequest, sshToggle: sshToggleRequest,
  sshCheck: sshCheckRequest, sshCallStatus: sshCallRefRequest, sshCallCancel: sshCallRefRequest,
  sshCallList: z.object({}).strict(),
  sshExecuteList: z.object({}).strict(), sshExecuteStatus: sshExecuteRefRequest,
  sshExecuteCancel: sshExecuteRefRequest,
  artifactsPublish: artifactPublishRequest,
  artifactsList: z.object({ workspaceId: z.uuid().optional(), sessionId: z.uuid().optional(),
    cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  artifactsPreview: z.object({ artifactId: z.uuid() }).strict(),
  executionsList: z.object({}).strict(), executionCancel: z.object({ executionId: z.uuid() }).strict(),
  executionFiles: executionFilesRequest,
  executionResolutionsList: executionResolutionsListRequest,
  executionResolutionInspect: executionResolutionInspectRequest,
  executionResolutionStatus: executionResolutionStatusRequest,
  devicesList: z.object({}).strict(), devicesPair: z.object({}).strict(),
  devicesRevoke: z.object({ deviceId: z.uuid() }).strict(),
  directoriesRevoke: z.object({ directoryId: z.uuid() }).strict() }
const endpoint = { ...mcpManagementEndpoints, ...sshManagementEndpoints, ...WORKSPACE_BINDING_ROUTES,
  ...EXECUTION_RESOLUTION_ROUTES, me: '/identity/me', logout: '/identity/logout', modelsList: '/identity/models', settingsUpdate: '/identity/settings/update',
  accountCapabilities: ACCOUNT_ROUTES.capabilities,
  desktopBrowserScope: DESKTOP_BROWSER_SCOPE_PLATFORM_PATH,
  create: '/sessions/create', list: '/sessions/list', prompt: '/sessions/prompt', page: '/sessions/page',
  filesList: '/files/session/list', filesRead: '/files/session/read', filesPut: '/files/session/put',
  filesDownloadPrepare: '/files/download/prepare',
  skillsList: '/skills/list', skillsRead: '/skills/read',
  skillsCatalog: '/skills/catalog', skillsInstallBuiltin: '/skills/install-builtin',
  skillsInstall: '/skills/install', skillsToggle: '/skills/toggle',
  skillsUploadTicket: '/skills/upload-ticket', skillsRevoke: '/skills/revoke', actionsList: '/connectors/actions',
  pluginsList: '/plugins/list', pluginsNotesSetEnabled: '/plugins/notes/set-enabled',
  mcpList: '/mcp/list', mcpInstall: '/mcp/install', mcpToggle: '/mcp/toggle', mcpCheck: '/mcp/check',
  stdioMcpList: '/stdio-mcp/list', stdioMcpInstall: '/stdio-mcp/install',
  stdioMcpToggle: '/stdio-mcp/toggle', stdioMcpCalls: '/stdio-mcp/calls',
  stdioMcpStatus: '/stdio-mcp/status',
  sshList: '/ssh/list', sshCreateTicket: '/ssh/create-ticket', sshToggle: '/ssh/toggle',
  sshCheck: '/ssh/check', sshCallStatus: '/ssh/call-status', sshCallCancel: '/ssh/call-cancel',
  sshCallList: '/ssh/call-list',
  sshExecuteList: '/ssh/execute/list', sshExecuteStatus: '/ssh/execute/status',
  sshExecuteCancel: '/ssh/execute/cancel',
  artifactsPublish: '/artifacts/publish', artifactsList: '/artifacts/list', artifactsPreview: '/artifacts/preview',
  executionsList: '/executions/list', executionCancel: '/executions/cancel',
  executionFiles: EXECUTION_FILES_PLATFORM_PATH,
  devicesList: '/devices/list', devicesPair: '/devices/pair',
  devicesRevoke: '/devices/revoke', directoriesRevoke: '/devices/directories/revoke' } as const
type Method = keyof typeof requests

declare module '@deepseek-ai/cordis' { interface Context { powerEvolve: ProductRemote; powerEvolveBrowserAuth: BrowserAgentAuth } }

class ProductRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly options: { tokens: WeakMap<PeerScope, string>; pollMs: number;
    platformOrigin: string }) { super(ctx, 'powerEvolve') }
  private token(): string {
    const peer = this.ctx.invocation?.peer
    const token = peer && this.options.tokens.get(peer)
    if (!token) throw new PlatformError(401, 'unauthorized_peer')
    return token
  }
  private call(method: keyof typeof endpoint, request: unknown) {
    return this.ctx.powerEvolveRuntime.call(endpoint[method], this.token(), request)
  }
  @Remote me(request: z.infer<typeof requests.me>) { return this.call('me', request) }
  @Remote async desktopBrowserScope(request: z.infer<typeof desktopBrowserScopeRequest>) {
    const input = desktopBrowserScopeRequest.parse(request)
    const result = desktopBrowserScopeView.safeParse(await this.call('desktopBrowserScope', input))
    if (!result.success || result.data.sessionId !== input.sessionId) {
      throw new PlatformError(502, 'desktop_browser_scope_unavailable')
    }
    return result.data
  }
  @Remote async storageSpaces(request: z.infer<typeof requests.storageSpaces>) {
    return storageSpacesView.parse(await this.call('storageSpaces', request))
  }
  @Remote async storageDirectories(request: z.infer<typeof storageDirectoriesRequest>) {
    return storageDirectoriesView.parse(await this.call('storageDirectories', request))
  }
  @Remote async storageDirectoryCreate(request: z.infer<typeof storageDirectoryCreateRequest>) {
    return storageDirectoryView.parse(await this.call('storageDirectoryCreate', request))
  }
  @Remote async workspaceBindingsMissing(request: z.infer<typeof requests.workspaceBindingsMissing>) {
    return workspaceBindingsMissingView.parse(await this.call('workspaceBindingsMissing', request))
  }
  @Remote async workspaceBindingRestore(request: z.infer<typeof workspaceBindingRestoreRequest>) {
    return workspaceBindingReceipt.parse(await this.call('workspaceBindingRestore', request))
  }
  @Remote async workspaceBindingStatus(request: z.infer<typeof workspaceBindingStatusRequest>) {
    return workspaceBindingReceipt.parse(await this.call('workspaceBindingStatus', request))
  }
  @Remote logout(request: z.infer<typeof requests.logout>) { return this.call('logout', request) }
  @Remote modelsList(request: z.infer<typeof requests.modelsList>) { return this.call('modelsList', request) }
  @Remote async accountCapabilities(request: z.infer<typeof requests.accountCapabilities>) {
    return accountCapabilitiesValue.parse(await this.call('accountCapabilities', request))
  }
  @Remote settingsUpdate(request: z.infer<typeof settingsUpdateRequest>) { return this.call('settingsUpdate', request) }
  @Remote mcpConnectionsList(request: z.infer<typeof requests.mcpConnectionsList>) {
    return this.call('mcpConnectionsList', request)
  }
  @Remote mcpConnectionsCreate(request: z.infer<typeof requests.mcpConnectionsCreate>) {
    return this.call('mcpConnectionsCreate', request)
  }
  @Remote mcpConnectionsUpdate(request: z.infer<typeof requests.mcpConnectionsUpdate>) {
    return this.call('mcpConnectionsUpdate', request)
  }
  @Remote mcpConnectionsToggle(request: z.infer<typeof requests.mcpConnectionsToggle>) {
    return this.call('mcpConnectionsToggle', request)
  }
  @Remote mcpConnectionsDelete(request: z.infer<typeof requests.mcpConnectionsDelete>) {
    return this.call('mcpConnectionsDelete', request)
  }
  @Remote async mcpConnectionsTicket(request: z.infer<typeof requests.mcpConnectionsTicket>) {
    const result = mcpTicketValue.parse(await this.call('mcpConnectionsTicket', request))
    if (result.state === 'pending') {
      const upload = new URL(result.uploadUrl)
      if (upload.origin !== this.options.platformOrigin || upload.pathname !== '/mcp/connections/upload'
        || upload.username || upload.password || upload.search || upload.hash) {
        throw new PlatformError(503, 'mcp_upload_unavailable')
      }
    }
    return result
  }
  @Remote mcpConnectionsReceipt(request: z.infer<typeof requests.mcpConnectionsReceipt>) {
    return this.call('mcpConnectionsReceipt', request)
  }
  @Remote mcpConnectionsCheck(request: z.infer<typeof requests.mcpConnectionsCheck>) {
    return this.call('mcpConnectionsCheck', request)
  }
  @Remote mcpConnectionsDraftCheck(request: z.infer<typeof requests.mcpConnectionsDraftCheck>) {
    return this.call('mcpConnectionsDraftCheck', request)
  }
  @Remote mcpConnectionsCheckStatus(request: z.infer<typeof requests.mcpConnectionsCheckStatus>) {
    return this.call('mcpConnectionsCheckStatus', request)
  }
  @Remote mcpConnectionsCheckCancel(request: z.infer<typeof requests.mcpConnectionsCheckCancel>) {
    return this.call('mcpConnectionsCheckCancel', request)
  }
  @Remote create(request: z.infer<typeof createRequest>) { return this.call('create', request) }
  @Remote list(request: z.infer<typeof listRequest>) { return this.call('list', request) }
  @Remote prompt(request: z.infer<typeof promptRequest>) { return this.call('prompt', request) }
  @Remote page(request: z.infer<typeof pageRequest>) { return this.call('page', request) }
  @Remote filesList(request: z.infer<typeof sessionFilesListRequest>) { return this.call('filesList', request) }
  @Remote filesRead(request: z.infer<typeof sessionFileReadRequest>) { return this.call('filesRead', request) }
  @Remote filesPut(request: z.infer<typeof sessionFilePutRequest>) { return this.call('filesPut', request) }
  @Remote async filesDownloadPrepare(request: z.infer<typeof fileDownloadPrepareRequest>, signal: AbortSignal) {
    const value = fileDownloadView.parse(await this.ctx.powerEvolveRuntime.call(
      endpoint.filesDownloadPrepare, this.token(), request, signal))
    if (value.sessionId !== request.sessionId || value.fileCount !== request.paths.length
      || value.downloadUrl !== fileDownloadUrl({ ...request, revision: value.revision })) {
      throw new PlatformError(502, 'download_unavailable')
    }
    return value
  }
  @Remote skillsCatalog(request: z.infer<typeof requests.skillsCatalog>) { return this.call('skillsCatalog', request) }
  @Remote skillsInstallBuiltin(request: z.infer<typeof builtinSkillInstallRequest>) { return this.call('skillsInstallBuiltin', request) }
  @Remote skillsList(request: z.infer<typeof requests.skillsList>) { return this.call('skillsList', request) }
  @Remote skillsRead(request: z.infer<typeof skillRequest>) { return this.call('skillsRead', request) }
  @Remote skillsInstall(request: z.infer<typeof skillInstallRequest>) { return this.call('skillsInstall', request) }
  @Remote skillsToggle(request: z.infer<typeof skillToggleRequest>) { return this.call('skillsToggle', request) }
  @Remote async skillsUploadTicket(request: z.infer<typeof requests.skillsUploadTicket>) {
    const result = z.discriminatedUnion('state', [
      z.object({ state: z.literal('ready'), item: z.json() }).strict(),
      z.object({ state: z.literal('pending'), ticket: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
        uploadUrl: z.url(), expiresAt: z.iso.datetime() }).strict(),
    ]).parse(await this.call('skillsUploadTicket', request))
    if (result.state === 'pending') {
      const upload = new URL(result.uploadUrl)
      if (upload.origin !== this.options.platformOrigin || upload.pathname !== '/skills/upload'
        || upload.username || upload.password || upload.search || upload.hash) {
        throw new PlatformError(503, 'skill_upload_unavailable')
      }
    }
    return result
  }
  @Remote skillsRevoke(request: z.infer<typeof skillRequest>) { return this.call('skillsRevoke', request) }
  @Remote actionsList(request: z.infer<typeof requests.actionsList>) { return this.call('actionsList', request) }
  @Remote pluginsList(request: z.infer<typeof requests.pluginsList>) { return this.call('pluginsList', request) }
  @Remote pluginsNotesSetEnabled(request: z.infer<typeof requests.pluginsNotesSetEnabled>) {
    return this.call('pluginsNotesSetEnabled', request)
  }
  @Remote mcpList(request: z.infer<typeof requests.mcpList>) { return this.call('mcpList', request) }
  @Remote mcpInstall(request: z.infer<typeof requests.mcpInstall>) { return this.call('mcpInstall', request) }
  @Remote mcpToggle(request: z.infer<typeof requests.mcpToggle>) { return this.call('mcpToggle', request) }
  @Remote mcpCheck(request: z.infer<typeof requests.mcpCheck>) { return this.call('mcpCheck', request) }
  @Remote stdioMcpList(request: z.infer<typeof requests.stdioMcpList>) { return this.call('stdioMcpList', request) }
  @Remote stdioMcpInstall(request: z.infer<typeof requests.stdioMcpInstall>) { return this.call('stdioMcpInstall', request) }
  @Remote stdioMcpToggle(request: z.infer<typeof requests.stdioMcpToggle>) { return this.call('stdioMcpToggle', request) }
  @Remote stdioMcpCalls(request: z.infer<typeof requests.stdioMcpCalls>) { return this.call('stdioMcpCalls', request) }
  @Remote stdioMcpStatus(request: z.infer<typeof requests.stdioMcpStatus>) { return this.call('stdioMcpStatus', request) }
  @Remote sshList(request: z.infer<typeof requests.sshList>) { return this.call('sshList', request) }
  @Remote async sshConnectionsList(request: z.infer<typeof requests.sshConnectionsList>) {
    return z.object({ available: z.boolean(), items: z.array(sshConnectionValue) }).strict()
      .parse(await this.call('sshConnectionsList', request))
  }
  @Remote async sshConnectionsUpdate(request: z.infer<typeof requests.sshConnectionsUpdate>) {
    return sshConnectionValue.parse(await this.call('sshConnectionsUpdate', request))
  }
  @Remote async sshConnectionsToggle(request: z.infer<typeof requests.sshConnectionsToggle>) {
    return sshConnectionValue.parse(await this.call('sshConnectionsToggle', request))
  }
  @Remote async sshConnectionsDelete(request: z.infer<typeof requests.sshConnectionsDelete>) {
    return sshConnectionValue.parse(await this.call('sshConnectionsDelete', request))
  }
  @Remote async sshConnectionsTicket(request: z.infer<typeof requests.sshConnectionsTicket>) {
    const result = sshCredentialTicketValue.parse(await this.call('sshConnectionsTicket', request))
    const upload = new URL(result.uploadUrl)
    if (upload.origin !== this.options.platformOrigin || upload.pathname !== '/ssh/upload'
      || upload.username || upload.password || upload.search || upload.hash) {
      throw new PlatformError(503, 'ssh_upload_unavailable')
    }
    return result
  }
  @Remote async sshConnectionsReceipt(request: z.infer<typeof requests.sshConnectionsReceipt>) {
    return sshMutationReceiptValue.parse(await this.call('sshConnectionsReceipt', request))
  }
  @Remote async sshCreateTicket(request: z.infer<typeof sshCreateTicketRequest>) {
    const item = z.object({ connectionId: z.uuid(), displayName: z.string(), host: z.string(),
      port: z.number().int(), username: z.string(), hostKeySha256: z.string(), enabled: z.boolean(),
      revision: z.number().int(), credentialRevision: z.number().int() }).strict()
    const result = z.discriminatedUnion('state', [
      z.object({ state: z.literal('ready'), item }).strict(),
      z.object({ state: z.literal('pending'), ticket: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u),
        uploadUrl: z.url(), expiresAt: z.iso.datetime() }).strict(),
    ]).parse(await this.call('sshCreateTicket', request))
    if (result.state === 'pending') {
      const upload = new URL(result.uploadUrl)
      if (upload.origin !== this.options.platformOrigin || upload.pathname !== '/ssh/upload'
        || upload.username || upload.password || upload.search || upload.hash) {
        throw new PlatformError(503, 'ssh_upload_unavailable')
      }
    }
    return result
  }
  @Remote sshToggle(request: z.infer<typeof sshToggleRequest>) { return this.call('sshToggle', request) }
  @Remote async sshCheck(request: z.infer<typeof sshCheckRequest>) {
    return sshCheckView.parse(await this.call('sshCheck', request))
  }
  @Remote async sshCallStatus(request: z.infer<typeof sshCallRefRequest>) {
    return sshCheckView.parse(await this.call('sshCallStatus', request))
  }
  @Remote async sshCallCancel(request: z.infer<typeof sshCallRefRequest>) {
    return sshCheckView.parse(await this.call('sshCallCancel', request))
  }
  @Remote async sshCallList(request: Record<string, never>) {
    return z.object({ items: z.array(sshCheckView).max(100) }).strict().parse(await this.call('sshCallList', request))
  }
  @Remote async sshExecuteList(request: Record<string, never>) {
    return z.object({ items: z.array(sshExecuteView).max(100) }).strict().parse(
      await this.call('sshExecuteList', request))
  }
  @Remote async sshExecuteStatus(request: z.infer<typeof sshExecuteRefRequest>) {
    return sshExecuteView.parse(await this.call('sshExecuteStatus', request))
  }
  @Remote async sshExecuteCancel(request: z.infer<typeof sshExecuteRefRequest>) {
    return sshExecuteView.parse(await this.call('sshExecuteCancel', request))
  }
  @Remote artifactsPublish(request: z.infer<typeof requests.artifactsPublish>) { return this.call('artifactsPublish', request) }
  @Remote async executionFiles(request: z.infer<typeof executionFilesRequest>, signal: AbortSignal) {
    return executionFilesView.parse(await this.ctx.powerEvolveRuntime.call(
      EXECUTION_FILES_PLATFORM_PATH, this.token(), request, signal))
  }
  @Remote artifactsList(request: z.infer<typeof requests.artifactsList>) { return this.call('artifactsList', request) }
  @Remote artifactsPreview(request: z.infer<typeof requests.artifactsPreview>) { return this.call('artifactsPreview', request) }
  @Remote executionsList(request: z.infer<typeof requests.executionsList>) { return this.call('executionsList', request) }
  @Remote async executionResolutionsList(request: z.infer<typeof executionResolutionsListRequest>) {
    return executionResolutionsList.parse(await this.call('executionResolutionsList', request))
  }
  @Remote async executionResolutionInspect(request: z.infer<typeof executionResolutionInspectRequest>) {
    return executionResolutionInspection.parse(await this.call('executionResolutionInspect', request))
  }
  @Remote async executionResolutionStatus(request: z.infer<typeof executionResolutionStatusRequest>) {
    return executionResolutionStatus.parse(await this.call('executionResolutionStatus', request))
  }
  @Remote executionCancel(request: z.infer<typeof requests.executionCancel>) { return this.call('executionCancel', request) }
  @Remote devicesList(request: z.infer<typeof requests.devicesList>) { return this.call('devicesList', request) }
  @Remote devicesPair(request: z.infer<typeof requests.devicesPair>) { return this.call('devicesPair', request) }
  @Remote devicesRevoke(request: z.infer<typeof requests.devicesRevoke>) { return this.call('devicesRevoke', request) }
  @Remote directoriesRevoke(request: z.infer<typeof requests.directoriesRevoke>) { return this.call('directoriesRevoke', request) }
  @Remote async *follow(request: z.infer<typeof pageRequest>, signal: AbortSignal): AsyncGenerator<unknown> {
    let after = request.after
    let previous = ''
    while (!signal.aborted) {
      const result = await this.call('page', { ...request, after })
      const parsed = z.object({ events: z.array(z.object({ seq: z.number().int() })), operations: z.array(z.json()) }).parse(result)
      const signature = JSON.stringify(parsed.operations)
      if (parsed.events.length || signature !== previous) { yield result; previous = signature }
      after = parsed.events.at(-1)?.seq ?? after
      try { await delay(this.options.pollMs, undefined, { signal }) }
      catch (error) { if (signal.aborted) return; throw error }
    }
  }
}

export const name = 'power-evolve-host'
export const inject = ['powerEvolveRuntime', 'sessionPersistence', 'agents', 'sessions', 'tools', 'webServer', 'typert', 'typertGateway', 'agentLoop']
export const Config = schema.object({
  origin: schema.string().required(), platformOrigin: schema.string().required(),
  deviceOrigin: schema.string().required(),
  concurrency: schema.number().step(1).min(1).required(), pollMs: schema.number().min(50).required(),
  renewMs: schema.number().min(100).required(), operationTimeoutMs: schema.number().min(1000).required(),
  maxRequestBytes: schema.number().min(1024).required(), maxStreams: schema.number().step(1).min(1).required(),
  fileDownloadTimeoutMs: schema.number().step(1).min(1).default(60_000),
  officePreviewEnabled: schema.boolean().default(false),
  officePreviewPollMs: schema.number().step(1).min(1).max(2_147_483_647).default(500),
  officePreviewRenderDeadlineMs: schema.number().step(1).min(1000).max(2_147_483_647).default(240_000),
  officePreviewCancelTimeoutMs: schema.number().step(1).min(1).max(2_147_483_647).default(10_000),
  officePreviewMaxActiveRenders: schema.number().step(1).min(1).default(4),
  readyFile: schema.string().required(),
})
/** Validated Host origin, dispatch and carrier configuration. */
export type Config = ReturnType<typeof Config>

/** Mount only product RPC methods; native global settings and execution endpoints stay unexposed.
 * @param ctx - host profile plugin lifetime.
 * @param config - admission, dispatch, and carrier bounds.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const instanceId = randomUUID()
  const browserAuth = new BrowserAgentAuth(config.origin, config.platformOrigin, ctx.powerEvolveRuntime)
  ctx.provide('powerEvolveBrowserAuth', browserAuth)
  installNativeRemote(ctx, browserAuth, config.origin, config.pollMs, config.maxRequestBytes, config.maxStreams,
    config.officePreviewEnabled ? { pollMs: config.officePreviewPollMs,
      renderDeadlineMs: config.officePreviewRenderDeadlineMs, cancelTimeoutMs: config.officePreviewCancelTimeoutMs,
      maxActiveRenders: config.officePreviewMaxActiveRenders } : undefined)
  const tokens = new WeakMap<PeerScope, string>()
  ctx.plugin(ProductRemote, { tokens, pollMs: config.pollMs, platformOrigin: config.platformOrigin })
  const invocations: InvocationDescriptor[] = Object.entries(requests).map(([method, request]) => ({
    id: `@power-evolve/application#powerEvolve/${method}`, service: 'powerEvolve', namespace: 'powerEvolve', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: `PowerEvolve/${method}`, create: () => request } }],
    result: { mode: 'strict', typeSymbol: 'PowerEvolve/Json', create: () => z.json() },
    ...(method === 'follow' ? { mode: 'stream' as const } : {}),
    ...(['follow', 'filesDownloadPrepare', 'executionFiles'].includes(method) ? { cancellation: { parameter: 'signal' } } : {}),
  }))
  ctx.typert.register({ package: '@power-evolve/application', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations })
  const scheduler = new Scheduler(ctx, config)
  scheduler.start()
  ctx.effect(() => () => scheduler.close())
  let streams = 0
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    let peer: PeerScope | undefined
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    let streaming = false
    try {
      const url = new URL(req.url ?? '/', config.origin)
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') {
        sendJson(res, { ready: true, service: 'host', activeAgents: ctx.agents.list().length, loadedSessions: ctx.sessions.list().length, activeGrants: ctx.powerEvolveRuntime.grants.size, instanceId }); return
      }
      if (req.method === 'GET' && path === '/config') { sendJson(res, { loginUrl: `${config.platformOrigin}/login`,
        approvalUrl: `${config.platformOrigin}/approval`, deviceOrigin: config.deviceOrigin }); return }
      if (req.method === 'GET' && await serveNativeUi(path, res, config.platformOrigin)) return
      if (req.method === 'GET' && path === FILE_DOWNLOAD_CONTENT_PATH) {
        const credential = await browserAuth.authenticate(req, true)
        const request = parseFileDownloadQuery(url)
        if (streams >= config.maxStreams) throw new PlatformError(429, 'download_busy')
        streams++; streaming = true
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.fileDownloadTimeoutMs)])
        try { await proxyFileDownload(ctx.powerEvolveRuntime.config.platformUrl, credential.token, request, res, signal) }
        catch (error) {
          if (!(error instanceof PlatformError) && signal.aborted && signal.reason instanceof DOMException
            && signal.reason.name === 'TimeoutError') throw new PlatformError(504, 'download_timeout')
          throw error
        }
        return
      }
      const artifactContent = /^\/api\/powerEvolve\/artifacts\/([^/]+)\/content$/u.exec(path)
      if (req.method === 'GET' && artifactContent) {
        const artifactId = z.uuid().parse(artifactContent[1])
        const credential = await browserAuth.authenticate(req, true)
        const upstream = await fetch(new URL(`/artifacts/${artifactId}/content`, ctx.powerEvolveRuntime.config.platformUrl), {
          headers: { authorization: `Bearer ${credential.token}` }, signal: abort.signal, redirect: 'error',
        })
        if (!upstream.ok || !upstream.body) throw new PlatformError(upstream.status === 404 ? 404 : 503, 'artifact_unavailable')
        const length = Number(upstream.headers.get('content-length'))
        if (!Number.isInteger(length) || length < 0 || length > 2 * 1024 * 1024) throw new PlatformError(503, 'artifact_unavailable')
        res.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-disposition': upstream.headers.get('content-disposition') ?? 'attachment',
          'content-length': String(length), 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff' })
        let received = 0
        for await (const chunk of upstream.body) {
          abort.signal.throwIfAborted()
          received += chunk.byteLength
          if (received > length) throw new PlatformError(503, 'artifact_unavailable')
          if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal })
        }
        if (received !== length) throw new PlatformError(503, 'artifact_unavailable')
        res.end()
        return
      }
      if (path === '/auth/exchange') {
        if (url.search) throw new PlatformError(400, 'invalid_request')
        await browserAuth.exchange(req, res)
        return
      }
      if (req.method === 'GET' && await serveUi(path, 'client', res)) return
      if (req.method !== 'POST' || !path.startsWith('/api/powerEvolve/')) throw new PlatformError(404, 'not_found')
      const method = z.enum(Object.keys(requests) as [Method, ...Method[]]).parse(path.slice('/api/powerEvolve/'.length))
      const credential = await browserAuth.authenticate(req)
      const token = credential.token
      if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? '')) {
        throw new PlatformError(415, 'invalid_content_type')
      }
      const input = z.object({ request: requests[method] }).strict().parse(await readJson(req, config.maxRequestBytes))
      if (method === 'follow') {
        if (streams >= config.maxStreams) throw new PlatformError(429, 'stream_limit')
        // Check Session ownership before committing stream response headers.
        await ctx.powerEvolveRuntime.call('/sessions/page', token, input.request)
        streams++; streaming = true
      }
      const scope = createScope(ctx, {})
      peer = { id: brandString<PeerId>(randomUUID()), ctx: scope.ctx, dispose: scope.dispose }
      tokens.set(peer, token)
      const invocation = { namespace: 'powerEvolve', method, args: { request: input.request }, peer, signal: abort.signal }
      if (streaming) {
        const iterable = await ctx.typertGateway.stream(invocation)
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
        for await (const item of iterable) await writeLine(res, item, abort.signal)
        res.end()
      } else {
        const result = await ctx.typertGateway.invoke(invocation)
        if (method === 'logout' && credential.fromCookie) browserAuth.clear(res)
        sendJson(res, result)
      }
    } catch (error) { if (!abort.signal.aborted) sendFailure(res, error) }
    finally {
      if (streaming) streams--
      if (peer) { tokens.delete(peer); await peer.dispose() }
    }
  }))
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid, url: `http://${ctx.webServer.host}:${ctx.webServer.port}`, instanceId }), { mode: 0o600 })
}
