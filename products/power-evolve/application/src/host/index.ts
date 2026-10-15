/** Authenticated product RPC carrier over the native Typert Gateway. */
import { randomUUID } from 'node:crypto'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGES_PER_MESSAGE, DEFAULT_MAX_MESSAGE_IMAGE_BYTES } from '@deepseek-ai/dsh-attachment-local'
import { LegacyMigrationHostImages } from '../platform/legacy-migration-v2-host-images.ts'
import { resolveNativeImageOptions } from './native-image-config.ts'
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
import { settings, createRequest, sessionFilesListRequest, sessionFileReadRequest, listRequest, pageRequest,
  promptRequest, settingsUpdateRequest, builtinSkillInstallRequest, skillInstallRequest, skillRequest,
  skillToggleRequest, sshCreateTicketRequest, sshToggleRequest, sshCheckRequest, sshCallRefRequest, sshCheckView,
  sshExecuteRefRequest, sshExecuteView, PlatformError } from '../contracts.ts'
import { readJson, sendFailure, sendJson, writeLine } from '../http.ts'
import { nativeInputQueueCommand } from '../native-input-ledger-contracts.ts'
import { serveNativeUi } from '../ui.ts'
import { BrowserAgentAuth } from './browser-auth.ts'
import { installNativeClientRouting } from './native-client-routing.ts'
import { installNativeRemote } from './native-remote.ts'
import { Scheduler } from './scheduler.ts'
import { CloudShellExecutor } from './cloud-shell.ts'
import { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import { mcpManagementRequests, mcpManagementEndpoints, mcpTicketValue } from '../mcp-management-rpc.ts'
import { sshManagementRequests, sshManagementEndpoints, sshConnectionValue,
  sshCredentialTicketValue, sshMutationReceiptValue } from '../ssh-management-contracts.ts'
import { ACCOUNT_ROUTES, accountCapabilitiesValue, accountEmptyRequest } from '../account-contracts.ts'
import { FILE_DOWNLOAD_CONTENT_PATH, fileDownloadPrepareRequest, fileDownloadView,
  fileDownloadUrl } from '@power-evolve/contracts/file-download'
import { parseFileDownloadQuery, proxyFileDownload } from '../file-download-http.ts'
import { EXECUTION_RESOLUTION_ROUTES, executionResolutionsListRequest, executionResolutionsList,
  executionResolutionInspectRequest, executionResolutionInspection,
  executionResolutionStatusRequest, executionResolutionStatus } from '@power-evolve/contracts/execution-resolution'
import type { StdioActionListRequestV2, StdioCreateRequestV2, StdioDeleteRequestV2,
  StdioListRequestV2, StdioToggleRequestV2, StdioUpdateRequestV2 } from '@power-evolve/contracts/stdio-management'
import { stdioActionRequestV2, stdioCheckRequestV2, stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { StdioManagementRpcV2, stdioManagementRequestsV2, stdioManagementEndpointsV2 } from '../stdio-v2-management-rpc.ts'

const requests = { ...mcpManagementRequests, ...sshManagementRequests, ...stdioManagementRequestsV2,
  me: z.object({}).strict(), logout: z.object({}).strict(), modelsList: z.object({}).strict(), settingsUpdate: settingsUpdateRequest,
  accountCapabilities: accountEmptyRequest,
  create: createRequest, list: listRequest, prompt: promptRequest, page: pageRequest, follow: pageRequest,
  filesList: sessionFilesListRequest, filesRead: sessionFileReadRequest,
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
  executionsList: z.object({}).strict(), executionCancel: z.object({ executionId: z.uuid() }).strict(),
  executionResolutionsList: executionResolutionsListRequest,
  executionResolutionInspect: executionResolutionInspectRequest,
  executionResolutionStatus: executionResolutionStatusRequest }
const endpoint = { ...mcpManagementEndpoints, ...sshManagementEndpoints, ...stdioManagementEndpointsV2,
  ...EXECUTION_RESOLUTION_ROUTES, me: '/identity/me', logout: '/identity/logout', modelsList: '/identity/models',
  settingsUpdate: '/identity/settings/update',
  accountCapabilities: ACCOUNT_ROUTES.capabilities,
  create: '/sessions/create', list: '/sessions/list', prompt: '/sessions/prompt', page: '/sessions/page',
  filesList: '/files/session/list', filesRead: '/files/session/read',
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
  executionsList: '/executions/list', executionCancel: '/executions/cancel' } as const
type Method = keyof typeof requests

declare module '@deepseek-ai/cordis' { interface Context { powerEvolve: ProductRemote; powerEvolveBrowserAuth: BrowserAgentAuth } }

class ProductRemote extends TypertRemoteService {
  private readonly stdio: StdioManagementRpcV2
  constructor(ctx: Context, private readonly options: { tokens: WeakMap<PeerScope, string>
    pollMs: number
    platformOrigin: string }) {
    super(ctx, 'powerEvolve')
    this.stdio = new StdioManagementRpcV2(ctx.powerEvolveRuntime)
  }
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
  @Remote async filesDownloadPrepare(request: z.infer<typeof fileDownloadPrepareRequest>, signal: AbortSignal) {
    const value = fileDownloadView.parse(await this.ctx.powerEvolveRuntime.call(
      endpoint.filesDownloadPrepare, this.token(), request, signal))
    if (value.sessionId !== request.sessionId
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
  @Remote stdioV2EnvironmentTicket(request: z.infer<typeof requests.stdioV2EnvironmentTicket>) {
    return this.stdio.environmentTicket(this.token(), request)
  }
  @Remote stdioV2EnvironmentReceipt(request: z.infer<typeof requests.stdioV2EnvironmentReceipt>) {
    return this.stdio.environmentReceipt(this.token(), request)
  }
  @Remote stdioV2Config(request: Record<string, never>) { return this.stdio.config(this.token(), request) }
  @Remote stdioV2ConnectionsList(request: StdioListRequestV2) { return this.stdio.list(this.token(), request) }
  @Remote stdioV2ConnectionsCreate(request: StdioCreateRequestV2) { return this.stdio.create(this.token(), request) }
  @Remote stdioV2ConnectionsUpdate(request: StdioUpdateRequestV2) { return this.stdio.update(this.token(), request) }
  @Remote stdioV2ConnectionsToggle(request: StdioToggleRequestV2) { return this.stdio.toggle(this.token(), request) }
  @Remote stdioV2ConnectionsDelete(request: StdioDeleteRequestV2) { return this.stdio.remove(this.token(), request) }
  @Remote stdioV2ConnectionsReceipt(request: z.infer<typeof stdioReceiptRequestV2>) { return this.stdio.receipt(this.token(), request) }
  @Remote stdioV2ConnectionsCheck(request: z.infer<typeof stdioCheckRequestV2>) { return this.stdio.check(this.token(), request) }
  @Remote stdioV2ActionsList(request: StdioActionListRequestV2) { return this.stdio.actions(this.token(), request) }
  @Remote stdioV2ActionsDetail(request: z.infer<typeof stdioActionRequestV2>) { return this.stdio.detail(this.token(), request) }
  @Remote stdioV2ActionsCancel(request: z.infer<typeof stdioActionRequestV2>) { return this.stdio.cancel(this.token(), request) }
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
  @Remote async *follow(request: z.infer<typeof pageRequest>, signal: AbortSignal): AsyncGenerator {
    const stopped = () => signal.aborted
    let after = request.after
    let previous = ''
    while (!signal.aborted) {
      const result = await this.call('page', { ...request, after })
      const parsed = z.object({ events: z.array(z.object({ seq: z.number().int() })), operations: z.array(z.json()) }).parse(result)
      const signature = JSON.stringify(parsed.operations)
      if (parsed.events.length || signature !== previous) { yield result; previous = signature }
      after = parsed.events.at(-1)?.seq ?? after
      try { await delay(this.options.pollMs, undefined, { signal }) }
      catch (error) { if (stopped()) return; throw error }
    }
  }
}

export const name = 'power-evolve-host'
export const inject = ['powerEvolveRuntime', 'sessionPersistence', 'agents', 'sessions', 'tools', 'webServer',
  'typert', 'typertGateway', 'agentLoop', 'pluginManager', 'sessionTitle']
export const Config = schema.object({
  origin: schema.string().required(), platformOrigin: schema.string().required(),
  concurrency: schema.number().step(1).min(1).required(), pollMs: schema.number().min(50).required(),
  nativeShellEnabled: schema.boolean().default(false),
  shellPollMs: schema.number().step(1).min(10).max(60_000).default(250),
  shellTimeoutMs: schema.number().step(1).min(1000).max(300_000).default(120_000),
  shellMaxTimeoutMs: schema.number().step(1).min(1000).max(300_000).default(120_000),
  shellMaxOutputBytes: schema.number().step(1).min(1).max(65_536).default(65_536),
  renewMs: schema.number().min(100).required(), operationTimeoutMs: schema.number().min(1000).required(),
  nativeInputPollMs: schema.number().step(1).min(10).max(60_000).default(100),
  nativeInputBatchSize: schema.number().step(1).min(1).max(128).default(16),
  maxRequestBytes: schema.number().min(1024).required(), maxStreams: schema.number().step(1).min(1).required(),
  fileDownloadTimeoutMs: schema.number().step(1).min(1).default(60_000),
  nativeStreamSendTimeoutMs: schema.number().step(1).min(1).max(2_147_483_647).default(10_000),
  nativeFollowMaxGenerationMs: schema.number().step(1).min(1000).max(3_600_000).default(60_000),
  nativeFollowMaxGenerationItems: schema.number().step(1).min(1).default(1024),
  nativeFollowMaxGenerationBytes: schema.number().step(1).min(1024).default(16_777_216),
  profileAdministrators: schema.array(
    schema.string().pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  ).default([]),
  nativeRuntimeRouting: schema.boolean().default(false),
  nativeClientMaxRequests: schema.number().step(1).min(1).max(10_000).default(100),
  nativeClientLifetimeMs: schema.number().step(1).min(1000).max(2_147_483_647).default(30_000),

  officePreviewEnabled: schema.boolean().default(false),
  officePreviewPollMs: schema.number().step(1).min(1).max(2_147_483_647).default(500),
  officePreviewRenderDeadlineMs: schema.number().step(1).min(1000).max(2_147_483_647).default(240_000),
  officePreviewCancelTimeoutMs: schema.number().step(1).min(1).max(2_147_483_647).default(10_000),
  officePreviewMaxActiveRenders: schema.number().step(1).min(1).default(4),
  legacyImageCacheRoot: schema.string().default(''),
  legacyImageMaxBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_BYTES),
  legacyImageMaxPixels: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_PIXELS),
  legacyImageMaxDimension: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_DIMENSION),
  legacyImageMaxImagesPerMessage: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
  legacyImageMaxMessageBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
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
  const runtimeUserId = ctx.powerEvolveRuntime.config.runtimeUserId
  const browserAuth = new BrowserAgentAuth(config.origin, config.platformOrigin, ctx.powerEvolveRuntime,
    runtimeUserId === '' ? undefined : runtimeUserId,
    runtimeUserId === '' ? undefined : token => ctx.powerEvolveRuntime.verifyBroker(token))
  ctx.provide('powerEvolveBrowserAuth', browserAuth)
  if (config.nativeRuntimeRouting && runtimeUserId === '') installNativeClientRouting(ctx, browserAuth, config.origin,
    ctx.powerEvolveRuntime.config.platformUrl, config.maxRequestBytes, ctx.powerEvolveRuntime.config.timeoutMs,
    { maxRequests: config.nativeClientMaxRequests, lifetimeMs: config.nativeClientLifetimeMs, platformOrigin: config.platformOrigin })
  const installRemote = (remoteCtx: Context) => {
    installNativeRemote(remoteCtx, browserAuth, config.origin, config.pollMs,
      config.maxRequestBytes, config.maxStreams, config.profileAdministrators,
      { maxGenerationMs: config.nativeFollowMaxGenerationMs, maxGenerationItems: config.nativeFollowMaxGenerationItems,
        maxGenerationBytes: config.nativeFollowMaxGenerationBytes }, config.nativeStreamSendTimeoutMs,
      config.officePreviewEnabled ? { pollMs: config.officePreviewPollMs,
        renderDeadlineMs: config.officePreviewRenderDeadlineMs, cancelTimeoutMs: config.officePreviewCancelTimeoutMs,
        maxActiveRenders: config.officePreviewMaxActiveRenders } : undefined, config.nativeRuntimeRouting)
  }
  if (runtimeUserId === '') installRemote(ctx)
  else await ctx.inject(['agentPresets', 'permissionPresets', 'nativeRuntimeSessions', 'nativeRuntimeExecution'], installRemote)
  const tokens = new WeakMap<PeerScope, string>()
  ctx.plugin(ProductRemote, { tokens, pollMs: config.pollMs, platformOrigin: config.platformOrigin })
  const invocations: InvocationDescriptor[] = Object.entries(requests).map(([method, request]) => ({
    id: `@power-evolve/application#powerEvolve/${method}`, service: 'powerEvolve', namespace: 'powerEvolve', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict',
      typeSymbol: `PowerEvolve/${method}`, create: () => request } }],
    result: { mode: 'strict', typeSymbol: 'PowerEvolve/Json', create: () => z.json() },
    ...(method === 'follow' ? { mode: 'stream' as const } : {}),
    ...(['follow', 'filesDownloadPrepare'].includes(method) ? { cancellation: { parameter: 'signal' } } : {}),
  }))
  ctx.typert.register({ package: '@power-evolve/application', face: 'host', schemas: [], model: { services: [],
    events: [], objects: [] }, invocations })
  if (runtimeUserId === '') ctx.sessions.registerMessageProjection(imageOffloadProjection)
  new LegacyMigrationHostImages(ctx, ctx.powerEvolveRuntime, resolveNativeImageOptions(config))
  if (!config.nativeRuntimeRouting && config.nativeShellEnabled && runtimeUserId === '') {
    if (config.shellTimeoutMs > config.shellMaxTimeoutMs) throw new Error('shellTimeoutMs exceeds shellMaxTimeoutMs')
    new CloudShellExecutor(ctx, ctx.powerEvolveRuntime, { pollMs: config.shellPollMs,
      timeoutMs: config.shellTimeoutMs, maxTimeoutMs: config.shellMaxTimeoutMs, maxOutputBytes: config.shellMaxOutputBytes })
    new ShellEnvRegistry(ctx, { dshHome: '/home/agent/.dsh' })
  }
  if (!config.nativeRuntimeRouting) await ctx.inject(runtimeUserId === '' ? ['attachments'] : ['attachments',
    'agentPresets', 'nativeRuntimeExecution', 'sandboxPolicy', 'sessionProjections'], (imageCtx) => {
    const scheduler = new Scheduler(imageCtx, config)
    if (runtimeUserId !== '') {
      imageCtx.on('agent/created', async ({ agent }) => {
        if (agent.session.header.origin !== 'subagent') return
        const runtime = imageCtx.powerEvolveRuntime, grant = runtime.require(agent.id)
        grant.settings = settings.parse(await runtime.call('/runtime/subagents/configure', grant.token, {
          provider: agent.options.provider ?? 'power-evolve', model: agent.options.model ?? grant.settings.model,
          maxTokens: agent.options.maxTokens ?? grant.settings.maxTokens }))
        runtime.assertGrant(grant)
        const images = imageCtx.attachments
        if (!(images instanceof LegacyMigrationHostImages)) throw new Error('Host migration image provider is missing')
        images.bind(agent.ctx, grant)
        await imageCtx.nativeRuntimeExecution.bind(agent, grant)
        const publisher = runtime.publication(grant)
        agent.ctx.effect(() => publisher.onFailure(() => { agent.cancel({ kind: 'disposed' }, { keepInbox: true }) }))
        agent.ctx.on('agent/assistant-stream', ({ agent: source, frame }) => { if (source === agent) publisher.frame(frame) })
        await scheduler.installTools(agent, grant)
      })
    }
    scheduler.start()
    imageCtx.effect(() => () => scheduler.close())
  })
  let streams = 0
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    let peer: PeerScope | undefined
    const abort = new AbortController()
    res.on('close', () => { abort.abort() })
    let streaming = false
    try {
      const url = new URL(req.url ?? '/', config.origin)
      const path = url.pathname
      if (path === '/native/input/queue') {
        if (req.method !== 'POST' || url.search) throw new PlatformError(400, 'invalid_request')
        const credential = await browserAuth.authenticate(req)
        const command = nativeInputQueueCommand.parse(await readJson(req, config.maxRequestBytes))
        sendJson(res, await ctx.powerEvolveRuntime.queueInput(credential.token, command)); return
      }
      if (req.method === 'GET' && path === '/health') {
        if (runtimeUserId !== '') {
          const token = req.headers['x-power-evolve-runner-token']
          await ctx.powerEvolveRuntime.verifyBroker(typeof token === 'string' ? token : undefined)
        }
        sendJson(res, { ready: true, service: 'host', activeAgents: ctx.agents.list().length, loadedSessions: ctx.sessions.list().length,
          activeGrants: ctx.powerEvolveRuntime.grants.size, instanceId,
          ...(runtimeUserId === '' ? {} : { runtimeUserId, runtimeId: ctx.powerEvolveRuntime.workerId,
            generation: ctx.powerEvolveRuntime.runtimeGeneration }) }); return
      }
      if (req.method === 'GET' && path === '/native/runtime/ready' && runtimeUserId !== '') {
        const token = req.headers['x-power-evolve-runner-token']
        await ctx.powerEvolveRuntime.verifyBroker(typeof token === 'string' ? token : undefined)
        const registry = ctx.get('agentPresets')
        const presets = registry === undefined ? [] : await registry.list()
        const services = ['settings', 'configEditor', 'permissionPresets', 'commands', 'sessionProjections', 'terminalController',
          'agentLoop', 'subagents', 'web', 'fs', 'subprocess', 'sandbox', 'clientModules', 'connection', 'nativeRuntimeUiAdmission']
        const ready = ctx.get('nativeRuntimeSessions')?.available === true && ctx.get('nativeRuntimeUiAdmission')?.available === true && services.every(service => ctx.get(service) !== undefined)
          && ['standard', 'ptc', 'minimal', 'cordis'].every(id => presets.some(preset => preset.id === id && preset.broken === undefined))
        sendJson(res, { ready, runtimeUserId, runtimeId: ctx.powerEvolveRuntime.workerId,
          generation: ctx.powerEvolveRuntime.runtimeGeneration, presets }); return
      }
      if (req.method === 'GET' && path === '/config') { sendJson(res, { loginUrl: `${config.platformOrigin}/login`,
        approvalUrl: `${config.platformOrigin}/approval` }); return }
      if (req.method === 'GET' && await serveNativeUi(url, res, config.platformOrigin)) return
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
      if (path === '/auth/exchange') {
        if (url.search) throw new PlatformError(400, 'invalid_request')
        await browserAuth.exchange(req, res)
        return
      }
      if (req.method === 'GET' && path === '/') { res.writeHead(308, { location: '/native/' }); res.end(); return }
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
      peer = { id: brandString<PeerId>(randomUUID()), ctx: scope.ctx, dispose: () => scope.dispose() }
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
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid,
    url: `http://${ctx.webServer.host}:${ctx.webServer.port}`, instanceId,
    ...(runtimeUserId === '' ? {} : { runtimeUserId, runtimeId: ctx.powerEvolveRuntime.workerId,
      generation: ctx.powerEvolveRuntime.runtimeGeneration }) }), { mode: 0o600 })
}
