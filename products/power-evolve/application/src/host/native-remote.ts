/** Tenant-scoped carrier for the native DSH Web Session client. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeWireResult, nativeRuntimeResponse, sendNativeRuntimeResponse } from './native-rpc-response.ts'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteStreamMuxServer, rejectRemoteStreamUpgrade } from '@deepseek-ai/dsh-api-gateway'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { createScope } from '@deepseek-ai/dsh-scope'
import { z } from 'zod'
import { isAttachmentError } from '@deepseek-ai/dsh-attachment'
import { nativeBrowserImageRequest } from '../platform/native-image-route.ts'
import { requestId, sessionId, PlatformError } from '../contracts.ts'
import { nativeInputQueueCommand, inputCommandReceipt } from '../native-input-ledger-contracts.ts'
import { nativeInputRecordDigest } from '../native-input-ledger-records.ts'
import { nativeDirectoryList, nativeDirectoryCreate, nativeWorkspaceCreate, nativeWorkspaceRename,
  nativeWorkspaceDelete, nativeWorkspaceOrder, nativeSessionOrder, nativeSessionArchive,
  nativeSessionGrouping } from '../native-workspace-contracts.ts'
import { nativeSessionRename, nativeSessionSearch, nativeSessionFork, nativeModelSelect } from '../native-session-contracts.ts'
import { fileReceiptId, nativeFileAttachment, nativePromptContent, NATIVE_FILE_MAX_BYTES } from '../native-attachment-contracts.ts'
import { readJson, sendFailure, sendJson } from '../http.ts'
import type { BrowserAgentAuth } from './browser-auth.ts'
import type {} from './scope.ts'
import { nativePermissionKnobs, nativePermissionProjection } from './native-permission-projection.ts'
import { followNativeSession, type NativeFollowLimits } from './native-session-follow.ts'
import { nativeSettings } from './native-settings.ts'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import { installNativeRuntimeRoutingUpgrade } from './native-runtime-routing.ts'
import type {} from './native-runtime-sessions.ts'
import { nativeRuntimeEvents } from './native-runtime-events.ts'
import { NativeOfficePreview, NativeOfficePreviewError,
  type NativeOfficePreviewOptions, type NativeOfficePreviewContent } from './native-office-preview.ts'

const address = z.object({ kind: z.literal('session'), sessionId }).strict()
const window = z.object({ maxMessages: z.number().int().min(1).max(500).optional(),
  turnWindow: z.object({ minMessages: z.number().int().positive(), minTurns: z.number().int().positive() }).strict().optional() })
const page = window.extend({ address, throughSeq: z.number().int().min(-1), beforeSeq: z.number().int().nonnegative().optional() }).strict()
const follow = window.extend({ address, assistantStream: z.literal(true).optional() }).strict()
const prompt = z.object({ sessionId, requestId, mode: z.literal('queue'),
  content: nativePromptContent,
  clientTimeZone: z.string().max(100).optional(),
  clientHints: z.record(z.string(), z.string().max(256)).optional() }).strict()

const envelope = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1).max(128),
  method: z.string().min(1).max(120), payload: z.object({ args: z.unknown() }).strict() }).strict()
const projectionRequest = z.object({ sessionId }).strict()
const workspace = z.object({ workspaceId: z.uuid(), path: z.string(), title: z.string(),
  sessionIds: z.array(sessionId), createdAt: z.string(), updatedAt: z.string() }).strict()
const workspaceBaseline = z.object({ items: z.array(workspace),
  archivedSessionIds: z.array(sessionId), pinnedSessionIds: z.array(sessionId) }).strict()
const sessionSummary = z.object({ sessionId, updatedAt: z.number(), agentAvailable: z.boolean(),
  running: z.boolean(), blank: z.boolean(), cwd: z.string().optional(),
  projections: z.object({ kind: z.literal('sequenced'), asOfSeq: z.number().int().min(-1),
    values: z.record(z.string(), z.json()), permissionKnobs: nativePermissionKnobs.optional() }).strict() }).loose()
const sessionList = z.object({ items: z.array(sessionSummary) }).strict()
const fileScope = z.object({ workspaceFileScopeId: sessionId, path: z.string().min(1).max(1024) }).strict()
const fileRead = fileScope.extend({ range: z.object({ offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional() }).strict() }).strict()
const fileBytes = fileScope.extend({ options: z.object({
  baseFile: z.string().min(1).max(1024).optional(),
  range: z.object({ offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(32 * 1024 * 1024).optional() }).strict().optional(),
}).strict() }).strict()
const binaryFileResult = z.object({ absolutePath: z.string(), version: z.string(), bytes: z.number(),
  offset: z.number(), data: z.string(), eof: z.boolean() }).strict()
const withRequest = <T extends z.ZodType>(request: T) => z.object({ request }).strict()
const uploadResult = z.object({ receiptId: fileReceiptId, file: nativeFileAttachment }).strict()

type NativeCall = (path: string, token: string, input: unknown, signal?: AbortSignal) => Promise<unknown>

function failure(error: unknown): { code: string; message: string; details: object } {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { code: remote.code, message: remote.message, details: remote.details }
  if (error instanceof NativeOfficePreviewError) {
    return error.code === 'cancelled'
      ? { code: 'gateway/cancelled', message: 'The document preview was cancelled.', details: {} }
      : { code: 'document-render/failed', message: 'Office conversion failed.', details: { reason: error.code } }
  }
  if (error instanceof PlatformError) {
    const detail = error.details ?? {}
    if (isAttachmentError(error)) return { code: 'session/attachment-invalid',
      message: 'Image attachment is unavailable.', details: { reason: error.code } }
    if (error.code === 'native_image_not_referenced') return { code: 'session/attachment-invalid',
      message: 'Image is not referenced by this Session.', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } }
    if (error.code === 'model_image_unsupported') return { code: 'session/attachment-invalid',
      message: 'The selected model does not support image input.', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } }
    if (error.code === 'directory_unreadable') return { code: 'directory-picker/unreadable',
      message: 'Cloud directory is unavailable.', details: detail }
    if (error.code === 'directory_exists') return { code: 'directory-picker/exists',
      message: 'Cloud directory already exists.', details: detail }
    if (error.code === 'workspace_name_conflict') return { code: 'workspace/name-conflict',
      message: 'Workspace title is already in use.', details: detail }
    if (error.code === 'native_move_invalid') return { code: 'workspace/move-invalid',
      message: 'Session is not a member of this Workspace.', details: detail }
    if (error.code === 'native_session_active') return { code: 'workspace/session-active',
      message: 'Session still has active work.', details: detail }
    if (error.code === 'native_session_archived') return { code: 'gateway/bad-request', message: 'Session is archived.', details: {} }
    if (error.code === 'native_title_invalid') return { code: 'session/title-invalid',
      message: 'Session title must contain visible text.', details: detail }
    if (error.code === 'native_search_invalid') return { code: 'gateway/bad-request',
      message: 'Search requires visible text without NUL, at most 500 UTF-16 code units.', details: {} }
    if (error.code === 'native_search_cancelled') return { code: 'gateway/cancelled', message: 'The search was cancelled.', details: {} }
    if (error.code === 'native_search_timeout' || error.code === 'native_search_budget_exceeded'
      || error.code === 'native_search_unavailable') {
      return { code: 'gateway/service-unavailable', message: 'Session search is unavailable.', details: { reason: error.code } }
    }
    if (error.code === 'attachment_not_staged') return { code: 'session/attachment-invalid',
      message: 'File was not staged for this Session request.', details: { reason: 'FILE_NOT_STAGED' } }
    if (error.code === 'attachment_bytes_limit') return { code: 'gateway/arguments-invalid',
      message: 'Upload exceeds its file or owner byte limit.', details: {} }
    if (error.code === 'attachment_count_limit') return { code: 'session/agent-busy',
      message: 'Session file capacity is unavailable.', details: { reason: 'CAPACITY' } }
    if (error.code === 'native_fork_unavailable') return { code: 'session/fork-unavailable',
      message: 'The requested Session prefix cannot be forked.', details: detail }
    if (error.code === 'native_remote_not_enabled' || error.code === 'native_stream_not_enabled') {
      return { code: 'gateway/invocation-unavailable', message: 'Remote endpoint is not enabled', details: {} }
    }
    if (error.code === 'workspace_not_found') {
      return { code: 'workspace/not-found', message: 'Workspace not found', details: {} }
    }
    if (error.code === 'file_not_found') return { code: 'workspace-file/not-found', message: 'File not found', details: { path: '' } }
    if (error.code === 'file_not_directory') return { code: 'workspace-file/not-directory',
      message: 'Path is not a directory', details: { path: '', kind: 'file' } }
    if (error.code === 'file_not_text') return { code: 'workspace-file/not-text', message: 'File is not UTF-8 text', details: { path: '' } }
    if (error.code === 'file_too_large') return { code: 'workspace-file/too-large',
      message: 'File exceeds read limit', details: { path: '', limit: 32 * 1024 * 1024 } }
    if (error.code === 'invalid_path') return { code: 'workspace-file/outside-workspace',
      message: 'File path is unavailable', details: { path: '' } }
    if (error.code === 'invalid_execution_target') return { code: 'gateway/arguments-invalid',
      message: 'Invalid execution target', details: {} }
    if (error.status === 404) return { code: 'session/not-found', message: 'Session not found', details: {} }
    if (error.status === 401 || error.status === 403) return { code: 'gateway/forbidden', message: 'Access denied', details: {} }
    if (error.status === 409) return { code: 'session/conflict', message: 'Session request conflicts with stored state', details: {} }
    if (error.status === 429) return { code: 'session/agent-busy', message: 'Session capacity is unavailable',
      details: { reason: 'CAPACITY' } }
  }
  if (error instanceof z.ZodError) return { code: 'gateway/arguments-invalid', message: 'Invalid Remote request', details: {} }
  return { code: 'gateway/service-unavailable', message: 'Remote request unavailable', details: {} }
}

function assertHostAuthority(request: IncomingMessage, origin: string): void {
  if (request.headers.host !== new URL(origin).host || !request.url?.startsWith('/')) {
    throw new PlatformError(403, 'invalid_host_authority')
  }
}

async function sendNativeBytes(response: ServerResponse, rpcId: string, raw: unknown): Promise<void> {
  const { data, ...value } = binaryFileResult.parse(raw)
  const bytes = Buffer.from(data, 'base64')
  await sendMultipart(response, rpcId, value, new Uint8Array(bytes))
}

async function sendMultipart(response: ServerResponse, rpcId: string, value: object, bytes: Uint8Array): Promise<void> {
  const parts = new FormData()
  parts.set('bytes-0', new Blob([new Uint8Array(bytes)]))
  parts.set('metadata', JSON.stringify({ type: 'server-response', rpcId,
    result: { ok: true, value: { ...value, data: null } },
    attachments: [{ path: ['data'], codec: 'bytes', part: 'bytes-0' }] }))
  const encoded = new Response(parts)
  const body = Buffer.from(await encoded.arrayBuffer())
  if (response.destroyed) return
  response.writeHead(200, { 'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
    'content-length': String(body.length), 'cache-control': 'no-store' })
  response.end(body)
}

/** Register one browser-authenticated native Session carrier without exposing Host-local Remotes.
 * Upgrade admission preserves 401/403 refusals and rejects unavailable verification with 503.
 * @param ctx - Host plugin lifetime and configured Platform runtime.
 * @param auth - browser credential verification at the Platform.
 * @param origin - permitted Host authority for HTTP and WebSocket requests.
 * @param pollMs - configured interval for live reads and temporary Session read failures.
 * @param maxRequestBytes - maximum native HTTP request body size.
 * @param maxStreams - maximum concurrent native logical streams.
 * @param profileAdministrators - deployment-owned user IDs allowed to change the shared Profile.
 * @param followLimits - explicit lifetime and total item/byte limits for assistant follow generations.
 * @param streamSendTimeoutMs - downlink frame deadline including queue time.
 * @param officeOptions - explicit Office preview budgets; omission leaves Office unavailable.
 */
export function installNativeRemote(ctx: Context, auth: BrowserAgentAuth, origin: string,
  pollMs: number, maxRequestBytes: number, maxStreams: number, profileAdministrators: readonly string[],
  followLimits: NativeFollowLimits, streamSendTimeoutMs: number, officeOptions?: NativeOfficePreviewOptions,
  nativeRuntimeRouting = false): void {
  const tokens = new WeakMap<PeerScope, string>()
  const call: NativeCall = (path, token, input, signal) => ctx.powerEvolveRuntime.call(path, token, input, signal)
  const projection = (raw: unknown) => nativePermissionProjection(ctx.powerEvolveRuntime.config.runtimeUserId === '' ? undefined : ctx, raw)
  const list = async (token: string) => sessionList.parse(await call('/native/sessions/list', token, {})).items
    .map(item => ({ ...item, projections: { kind: 'sequenced' as const, ...projection(item.projections) } }))
  const office = officeOptions === undefined ? undefined
    : new NativeOfficePreview((path, token, input, signal) => ctx.powerEvolveRuntime.call(path, token, input, signal), officeOptions)
  if (office !== undefined) ctx.effect(() => () => office.close())
  const tokenOf = (peer: PeerScope): string => {
    const token = tokens.get(peer)
    if (!token) throw new PlatformError(401, 'unauthorized_peer')
    return token
  }
  const unary = async (method: string, args: unknown, token: string, rpcId: string, signal: AbortSignal): Promise<unknown> => {
    if (method === '$events/result' && ctx.powerEvolveRuntime.config.runtimeUserId !== '') {
      ctx.typertGateway.remoteEventResult({ args })
      return undefined
    }
    if (method.startsWith('settings/')) {
      if (ctx.powerEvolveRuntime.config.runtimeUserId === '') return nativeSettings(call, method, args, token)
      return new NativeWireResult(await ctx.typertGateway.wireRpc.invoke(method, { args: z.record(z.string(),
        z.unknown()).parse(args) }, undefined, signal))
    }
    if (method.startsWith('pluginManager/')) {
      const operation = method.slice('pluginManager/'.length)
      if (ctx.powerEvolveRuntime.config.runtimeUserId !== '') {
        return new NativeWireResult(await ctx.typertGateway.wireRpc.invoke(method, { args: z.record(z.string(),
          z.unknown()).parse(args) }, undefined, signal))
      }
      const readOnly = ['listVersionExemptions', 'listPlugins', 'listBundles', 'registries'].includes(operation)
      const identity = z.object({ userId: z.uuid() }).parse(await call('/identity/me', token, {}))
      const capability = profileAdministrators.includes(identity.userId)
        ? z.object({ userId: z.uuid(), role: z.string(), canManage: z.boolean() }).parse(await call('/account/capabilities', token, {}))
        : undefined
      const writable = capability?.userId === identity.userId && capability.role === 'ADMIN' && capability.canManage
      if (!readOnly && !writable) throw new PlatformError(403, 'profile_permission_required')
      const manager = ctx.get('pluginManager')
      if (manager === undefined) throw new PlatformError(404, 'native_remote_not_enabled')
      if (!writable && operation === 'listPlugins') {
        z.object({}).strict().parse(args)
        return (await manager.listPlugins()).map(({ patchId: _patchId, ...row }) => ({ ...row,
          readOnlyReason: row.readOnlyReason ?? 'permission-required' }))
      }
      if (!writable && operation === 'listBundles') {
        z.object({}).strict().parse(args)
        return (await manager.listBundles()).map(row => ({ ...row, removable: false,
          readOnlyReason: row.readOnlyReason ?? 'permission-required' }))
      }
      return ctx.typertGateway.invoke({ namespace: 'pluginManager', method: operation,
        args: z.record(z.string(), z.unknown()).parse(args) })
    }
    switch (method) {
      case 'pluginInventory/list': {
        z.object({}).strict().parse(args)
        if (ctx.powerEvolveRuntime.config.runtimeUserId !== '') return { ...await readPluginInventory(ctx), managementWritable: true }
        const identity = z.object({ userId: z.uuid() }).parse(await call('/identity/me', token, {}))
        const capability = profileAdministrators.includes(identity.userId)
          ? z.object({ userId: z.uuid(), role: z.string(), canManage: z.boolean() }).parse(await call('/account/capabilities', token, {}))
          : undefined
        return { ...await readPluginInventory(ctx), managementWritable: capability?.userId === identity.userId
          && capability.role === 'ADMIN' && capability.canManage }
      }
      case 'session/modelCatalog': {
        z.object({}).strict().parse(args)
        const [identity, catalog] = await Promise.all([
          call('/identity/me', token, {}), call('/identity/models', token, {}),
        ])
        const selected = z.object({ settings: z.object({ model: z.string() }) }).parse(identity).settings
        const models = z.object({ models: z.array(z.object({ id: z.string(), label: z.string() })) }).parse(catalog).models
        return { default: { provider: 'power-evolve', model: selected.model, reasoningEffort: 'off' },
          routableProviders: models.length ? ['power-evolve'] : [],
          groups: models.length ? [{ id: 'power-evolve', name: 'PowerEvolve',
            models: models.map(model => ({ id: model.id, name: model.label,
              reasoning: { defaultEffort: 'off', efforts: [{ id: 'off', name: 'off' }] } })) }] : [],
          failures: [] }
      }
      case 'session/selectModel': {
        const input = withRequest(nativeModelSelect).parse(args)
        return call('/native/models/select', token, input.request)
      }
      case 'session/rename': return call('/native/sessions/rename', token, withRequest(nativeSessionRename).parse(args).request)
      case 'session/search': {
        const input = withRequest(nativeSessionSearch).safeParse(args)
        if (!input.success) throw new PlatformError(400, 'native_search_invalid')
        return call('/native/sessions/search', token, input.data.request, signal)
      }
      case 'session/fork': {
        const { request } = withRequest(nativeSessionFork).parse(args)
        return call('/native/sessions/fork', token, { ...request, requestId: requestId.parse(rpcId) })
      }
      case 'session/canOpenWorkspacePath': z.object({}).strict().parse(args); return false
      case 'session/workspacePathApplications': {
        withRequest(z.object({ path: z.string() }).strict()).parse(args)
        return []
      }
      case 'credentials/describe': {
        const { refs } = z.object({ refs: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(64) }).strict().parse(args)
        return Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: false }]))
      }
      case 'agentPresets/list': {
        z.object({}).strict().parse(args)
        if (ctx.powerEvolveRuntime.config.runtimeUserId === '') return { presets: [] }
        return ctx.agentPresets.remoteExportList()
      }
      case 'agentPresets/select': {
        if (ctx.powerEvolveRuntime.config.runtimeUserId === '') throw new PlatformError(404, 'native_remote_not_enabled')
        const selection = z.object({ agent: sessionId, agentPreset: z.string().min(1).max(256) }).strict().parse(args)
        await ctx.nativeRuntimeSessions.close(selection.agent)
        const preset = await ctx.agentPresets.resolve(selection.agentPreset)
        if (preset.broken !== undefined) throw new PlatformError(409, 'native_preset_invalid')
        return call('/native/presets/select', token, { sessionId: selection.agent, agentPreset: preset.id })
      }
      case 'session/list': {
        z.object({ _request: z.object({ cursor: z.string().max(512).optional() }).strict() }).strict().parse(args)
        return { items: await list(token) }
      }
      case 'session/create': {
        const { request } = withRequest(z.object({ workspaceId: z.uuid().optional(), agentPreset: z.string().min(1).max(256).optional(),
          sessionId: sessionId.optional() }).strict()).parse(args)
        // Check Session ownership before comparing its Workspace membership. A foreign
        // Session must be indistinguishable from a missing one to this caller.
        if (request.sessionId !== undefined) {
          await call('/native/sessions/adopt', token, { sessionId: request.sessionId })
        }
        if (request.workspaceId !== undefined) {
          const baseline = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
          const target = baseline.items.find(item => item.workspaceId === request.workspaceId)
          if (target === undefined) {
            throw new PlatformError(404, 'workspace_not_found')
          }
          if (request.sessionId !== undefined && !target.sessionIds.includes(request.sessionId)) {
            throw new PlatformError(409, 'workspace_session_mismatch')
          }
        }
        const preset = ctx.powerEvolveRuntime.config.runtimeUserId === '' ? undefined : await ctx.agentPresets.resolve(request.agentPreset)
        if (preset?.broken !== undefined) throw new PlatformError(409, 'native_preset_invalid')
        return request.sessionId === undefined
          ? call('/sessions/create', token, { requestId: requestId.parse(rpcId),
            ...(preset === undefined ? {} : { agentPreset: preset.id }),
            ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }) })
          : { sessionId: request.sessionId }
      }
      case 'workspace/create': {
        const { request } = withRequest(nativeWorkspaceCreate).parse(args)
        return call('/native/workspaces/create', token, { ...request, requestId: requestId.parse(rpcId) })
      }
      case 'workspace/initializeDefault': {
        z.object({}).strict().parse(args)
        const baseline = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
        const selected = baseline.items.find(item => item.path === '/workspace')
        return selected === undefined ? undefined : { workspace: selected }
      }
      case 'directoryPicker/list': return call('/native/directories/list', token, nativeDirectoryList.parse(args))
      case 'directoryPicker/createDirectory': return call('/native/directories/create', token, nativeDirectoryCreate.parse(args))
      case 'workspace/rename': return call('/native/workspaces/rename', token, withRequest(nativeWorkspaceRename).parse(args).request)
      case 'workspace/delete': return call('/native/workspaces/delete', token, withRequest(nativeWorkspaceDelete).parse(args).request)
      case 'workspace/insertBefore': return call('/native/workspaces/insertBefore', token,
        withRequest(nativeWorkspaceOrder).parse(args).request)
      case 'workspace/insertSessionBefore': return call('/native/workspaces/insertSessionBefore', token,
        withRequest(nativeSessionOrder).parse(args).request)
      case 'workspace/archiveSession': return call('/native/workspaces/archiveSession', token,
        withRequest(nativeSessionArchive).parse(args).request)
      case 'workspace/unarchiveSession':
      case 'workspace/pinSession':
      case 'workspace/unpinSession': return call(`/native/workspaces/${method.split('/')[1]}`, token,
        withRequest(nativeSessionGrouping).parse(args).request)
      case 'session/prompt': {
        const { request: value } = withRequest(prompt).parse(args)
        if (ctx.powerEvolveRuntime.config.runtimeUserId !== '') await ctx.nativeRuntimeSessions.close(value.sessionId)
        const accepted = z.object({ accepted: z.literal(true) }).parse(await call('/sessions/prompt', token,
          { sessionId: value.sessionId, requestId: value.requestId,
            text: value.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
            nativeContent: value.content, target: { kind: 'cloud' } }))
        return { accepted: accepted.accepted }
      }
      case 'session/updateQueue': {
        const command = nativeInputQueueCommand.parse({ rpcNonce: rpcId,
          payload: withRequest(nativeInputQueueCommand.shape.payload).parse(args).request })
        const receipt = inputCommandReceipt.parse(await call('/native/input/queue', token, command))
        const kind = command.payload.action.kind === 'steer' ? 'retarget' : command.payload.action.kind
        if (receipt.sessionId !== command.payload.sessionId || receipt.rpcNonce !== rpcId || receipt.kind !== kind
          || receipt.payloadDigest !== nativeInputRecordDigest(command) || receipt.actor.kind !== 'browser') {
          throw new PlatformError(502, 'native_input_commit_receipt')
        }
        return { accepted: true }
      }
      case 'session/attachment': return call('/native/attachments/image', token,
        withRequest(nativeBrowserImageRequest).parse(args).request, signal)
      case 'fileUploads/upload': {
        const input = z.object({ agent: sessionId, request: z.object({ data: z.string().max(Math.ceil(NATIVE_FILE_MAX_BYTES / 3) * 4),
          name: z.string().max(4096).optional() }).strict() }).strict().parse(args)
        return uploadResult.parse(await call('/native/attachments/uploadEncoded', token,
          { sessionId: input.agent, ...input.request }))
      }
      case 'session/cancel': {
        const { request } = withRequest(z.object({ sessionId }).strict()).parse(args)
        return z.object({ accepted: z.literal(true) }).strict().parse(
          await call('/native/sessions/cancel', token, request),
        )
      }
      case 'session/page': return call('/native/sessions/page', token, withRequest(page).parse(args).request)
      case 'session/projections': {
        const { sessionId: id } = withRequest(projectionRequest).parse(args).request
        const snapshot = z.object({ projections: z.unknown() })
          .parse(await call('/native/sessions/snapshot', token, { address: { kind: 'session', sessionId: id }, maxMessages: 1 }))
        return projection(snapshot.projections)
      }
      case 'workspaceFiles/list': {
        const input = fileScope.parse(args)
        return call('/native/files/list', token, { sessionId: input.workspaceFileScopeId, path: input.path })
      }
      case 'workspaceFiles/stat': {
        const input = fileScope.parse(args)
        return call('/native/files/stat', token, { sessionId: input.workspaceFileScopeId, path: input.path })
      }
      case 'workspaceFiles/read': {
        const input = fileRead.parse(args)
        return call('/native/files/read', token, { sessionId: input.workspaceFileScopeId,
          path: input.path, range: input.range })
      }
      case 'workspaceFiles/readBytes': {
        const input = fileBytes.parse(args)
        return call('/native/files/readBytes', token, { sessionId: input.workspaceFileScopeId,
          path: input.path, options: input.options })
      }
      default: {
        if (ctx.powerEvolveRuntime.config.runtimeUserId === '') throw new PlatformError(404, 'native_remote_not_enabled')
        const [namespace, operation] = method.split('/')
        if (!namespace || !operation) throw new PlatformError(400, 'invalid_request')
        const arguments_ = z.record(z.string(), z.unknown()).parse(args)
        const id = sessionId.safeParse(arguments_.agent)
        if (!id.success) return new NativeWireResult(await ctx.typertGateway.wireRpc.invoke(method,
          { args: arguments_ }, undefined, signal))
        await call('/native/sessions/snapshot', token, { address: { kind: 'session', sessionId: id.data }, maxMessages: 1 })
        const agent = await ctx.nativeRuntimeSessions.ensure(id.data, token)
        return ctx.agents.withInitiator(agent, async () => {
          const value = new NativeWireResult(await ctx.typertGateway.wireRpc.invoke(method, { args: arguments_ }, undefined, signal))
          await ctx.sessions.flush(agent.session)
          await ctx.nativeRuntimeExecution.bind(agent, ctx.powerEvolveRuntime.require(agent.id))
          return value
        })
      }
    }
  }
  const stream = async function* (method: string, args: unknown, peer: PeerScope, signal: AbortSignal,
    uplink: AsyncIterable<unknown>): AsyncGenerator {
    const stopped = () => signal.aborted
    const token = tokenOf(peer)
    switch (method) {
      case '$events': {
        z.object({}).strict().parse(args)
        if (ctx.powerEvolveRuntime.config.runtimeUserId !== '') {
          yield* nativeRuntimeEvents(ctx, async () => await list(token),
            pollMs, signal)
          return
        }
        const initial = await list(token)
        let previous = new Map(initial.map(item => [item.sessionId, item]))
        yield { type: 'ready', clientId: randomUUID(), host: { home: '/workspace' } }
        for (const item of initial) {
          if (item.running) yield { type: 'emit', event: 'api-session/status', args: [item.sessionId, true] }
        }
        while (!signal.aborted) {
          try { await delay(Math.max(pollMs, 1000), undefined, { signal }) }
          catch (error) { if (stopped()) return; throw error }
          const items = await list(token)
          const current = new Map(items.map(item => [item.sessionId, item]))
          for (const item of items) {
            const before = previous.get(item.sessionId)
            if (JSON.stringify(item) !== JSON.stringify(before)) {
              yield { type: 'emit', event: 'api-session/added', args: [item] }
            }
            if (item.running !== before?.running) {
              yield { type: 'emit', event: 'api-session/status', args: [item.sessionId, item.running] }
            }
          }
          for (const id of previous.keys()) {
            if (!current.has(id)) yield { type: 'emit', event: 'api-session/removed', args: [id] }
          }
          previous = current
        }
        return
      }
      case 'session/control': {
        z.object({}).strict().parse(args)
        let previous = await list(token)
        yield { type: 'baseline', value: { projections: Object.fromEntries(previous.map(item =>
          [item.sessionId, { asOfSeq: item.projections.asOfSeq, values: item.projections.values }])) } }
        while (!signal.aborted) {
          try { await delay(pollMs, undefined, { signal }) }
          catch (error) { if (stopped()) return; throw error }
          const current = await list(token)
          if (current.some(item => item.projections.asOfSeq === -1
            && JSON.stringify(item.projections.values)
            !== JSON.stringify(previous.find(before => before.sessionId === item.sessionId)?.projections.values))) {
            yield { type: 'baseline', value: { projections: Object.fromEntries(current.map(item =>
              [item.sessionId, { asOfSeq: item.projections.asOfSeq, values: item.projections.values }])) } }
          }
          const byId = new Map(previous.map(item => [item.sessionId, item]))
          for (const item of current) {
            const prior = byId.get(item.sessionId)
            for (const [key, value] of Object.entries(item.projections.values)) {
              if (item.projections.asOfSeq >= 0
                && JSON.stringify(value) !== JSON.stringify(prior?.projections.values[key])) {
                yield { type: 'projection', sessionId: item.sessionId, key, value, seq: item.projections.asOfSeq }
              }
            }
          }
          previous = current
        }
        return
      }
      case 'workspace/follow': {
        z.object({}).strict().parse(args)
        let baseline = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
        yield { type: 'baseline', value: baseline }
        while (!signal.aborted) {
          try { await delay(Math.max(pollMs, 1000), undefined, { signal }) }
          catch (error) { if (stopped()) return; throw error }
          const current = workspaceBaseline.parse(await call('/native/workspace/baseline', token, {}))
          if (JSON.stringify(current) === JSON.stringify(baseline)) continue
          const currentIds = new Set(current.items.map(item => item.workspaceId))
          for (const item of baseline.items) if (!currentIds.has(item.workspaceId)) yield { type: 'remove', workspaceId: item.workspaceId }
          for (const item of current.items) yield { type: 'upsert', workspace: item }
          if (JSON.stringify(current.items.map(item => item.workspaceId))
            !== JSON.stringify(baseline.items.map(item => item.workspaceId))) {
            yield { type: 'order', workspaceIds: current.items.map(item => item.workspaceId) }
          }
          if (JSON.stringify(current.archivedSessionIds) !== JSON.stringify(baseline.archivedSessionIds)) {
            yield { type: 'archived', archivedSessionIds: current.archivedSessionIds }
          }
          if (JSON.stringify(current.pinnedSessionIds) !== JSON.stringify(baseline.pinnedSessionIds)) {
            yield { type: 'pinned', pinnedSessionIds: current.pinnedSessionIds }
          }
          baseline = current
        }
        return
      }
      case 'session/follow': {
        const input = withRequest(follow).parse(args).request
        yield* followNativeSession(async (path, request, readSignal) => {
          const raw = await call(path, token, request, readSignal)
          if (path === '/native/sessions/snapshot') {
            const value = z.object({ projections: z.unknown() }).loose().parse(raw)
            return { ...value, projections: projection(value.projections) }
          }
          if (path === '/native/sessions/open') {
            const value = z.object({ snapshot: z.object({ projections: z.unknown() }).loose() }).loose().parse(raw)
            return { ...value, snapshot: { ...value.snapshot, projections: projection(value.snapshot.projections) } }
          }
          return raw
        },
        input, pollMs, signal, followLimits)
        return
      }
      case 'workspaceFiles/changes': {
        const input = fileScope.parse(args)
        const request = { sessionId: input.workspaceFileScopeId, path: input.path }
        let previous = await call('/native/files/observe', token, request)
        yield { kind: 'ready' }
        while (!signal.aborted) {
          try { await delay(Math.max(pollMs, 2000), undefined, { signal }) }
          catch (error) { if (stopped()) return; throw error }
          const current = await call('/native/files/observe', token, request)
          if (JSON.stringify(current) === JSON.stringify(previous)) continue
          previous = current
          yield { kind: 'change', change: current }
        }
        return
      }
      default: {
        if (ctx.powerEvolveRuntime.config.runtimeUserId === '') throw new PlatformError(404, 'native_stream_not_enabled')
        const [namespace, operation] = method.split('/')
        if (!namespace || !operation) throw new PlatformError(400, 'invalid_request')
        const arguments_ = z.record(z.string(), z.unknown()).parse(args), id = sessionId.safeParse(arguments_.agent)
        if (!id.success) { yield* await ctx.typertGateway.wireStream.open(method, { args: arguments_ }, uplink, peer, signal); return }
        await call('/native/sessions/snapshot', token, { address: { kind: 'session', sessionId: id.data }, maxMessages: 1 })
        const agent = await ctx.nativeRuntimeSessions.ensure(id.data, token)
        const source = await ctx.agents.withInitiator(agent, () => ctx.typertGateway.wireStream.open(method,
          { args: arguments_ }, uplink, peer, signal))
        const iterator = source[Symbol.asyncIterator]()
        try {
          while (!signal.aborted) {
            const item = await ctx.agents.withInitiator(agent, () => iterator.next())
            if (item.done) return
            yield item.value
          }
        } finally { await ctx.agents.withInitiator(agent, () => iterator.return?.()) }
        return
      }
    }
  }
  let activeStreams = 0
  const mux = new RemoteStreamMuxServer((method, payload, uplink, peer, control) => Promise.resolve().then(() => {
    const value = z.object({ args: z.unknown() }).strict().parse(payload)
    if (activeStreams >= maxStreams) throw new PlatformError(429, 'native_stream_limit')
    activeStreams++
    return (async function* (): AsyncGenerator {
      try { yield* stream(method, value.args, peer, control.signal, uplink) }
      finally { activeStreams-- }
    })()
  }), failure, 2000, 262_144, streamSendTimeoutMs)
  ctx.effect(() => () => mux.close())
  if (nativeRuntimeRouting) installNativeRuntimeRoutingUpgrade(ctx, auth, origin,
    ctx.powerEvolveRuntime.config.platformUrl, ctx.powerEvolveRuntime.config.timeoutMs)
  else ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/native/api/remote.mux',
    handler: async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      try {
        const credential = await auth.authenticate(req)
        if (ctx.powerEvolveRuntime.config.runtimeUserId === '') assertHostAuthority(req, origin)
        const scope = createScope(ctx, {})
        const peer: PeerScope = { id: brandString<PeerId>(randomUUID()), ctx: scope.ctx, dispose: () => scope.dispose() }
        tokens.set(peer, credential.token)
        mux.handleUpgrade(req, socket, head, peer)
      } catch (error) {
        rejectRemoteStreamUpgrade(socket,
          error instanceof PlatformError && (error.status === 401 || error.status === 403) ? error.status : 503)
      }
    },
  }))
  const nativeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const lifetime = new AbortController()
    const disconnected = () => { if (!res.writableEnded) lifetime.abort() }
    res.on('close', disconnected)
    try {
      const credential = await auth.authenticate(req)
      if (ctx.powerEvolveRuntime.config.runtimeUserId === '') assertHostAuthority(req, origin)
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/native/api/session/uploadFileBinary') {
        if (req.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
        if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
          throw new PlatformError(415, 'invalid_content_type')
        }
        const url = new URL(req.url ?? '/', origin)
        const id = sessionId.parse(url.searchParams.get('sessionId'))
        const name = z.string().max(4096).optional().parse(url.searchParams.get('name') ?? undefined)
        const iterator = req[Symbol.asyncIterator]()
        let bytes = 0
        let sourceFailure: unknown
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const item = await iterator.next()
              if (item.done) { controller.close(); return }
              if (!Buffer.isBuffer(item.value)) throw new PlatformError(400, 'invalid_upload_chunk')
              bytes += item.value.byteLength
              if (bytes > NATIVE_FILE_MAX_BYTES) throw new PlatformError(413, 'attachment_bytes_limit')
              controller.enqueue(item.value)
            } catch (error) { sourceFailure = error; controller.error(error) }
          },
          async cancel() { await iterator.return?.() },
        })
        try {
          const value = uploadResult.parse(await ctx.powerEvolveRuntime.uploadFile(credential.token, id, name, body, lifetime.signal))
          if (!lifetime.signal.aborted) sendJson(res, { ok: true, value })
        } catch (error) {
          if (!lifetime.signal.aborted) sendJson(res, { ok: false, error: failure(sourceFailure ?? error) })
        }
        return
      }
      if (req.method !== 'POST' || path !== '/native/runtime/invoke' && !/^\/native\/api\/[A-Za-z0-9_$.-]+\/[A-Za-z0-9_$.-]+$/.test(path)) {
        throw new PlatformError(404, 'not_found')
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
        throw new PlatformError(415, 'invalid_content_type')
      }
      const message = envelope.parse(await readJson(req, maxRequestBytes))
      const method = path === '/native/runtime/invoke' ? message.method : path.slice('/native/api/'.length)
      if (message.method !== method) throw new PlatformError(400, 'method_mismatch')
      if (nativeRuntimeRouting && method !== 'workspaceFiles/readBytes' && method !== 'officeToPdf/render') {
        await sendNativeRuntimeResponse(res, message.rpcId,
          await ctx.powerEvolveRuntime.call('/native/runtime/invoke', credential.token, message, lifetime.signal),
          ctx.powerEvolveRuntime.config.maxResponseBytes)
        return
      }
      try {
        let value: unknown
        if (method === 'officeToPdf/generation' || method === 'officeToPdf/render') {
          if (office === undefined) throw new PlatformError(404, 'native_remote_not_enabled')
          if (method === 'officeToPdf/render') {
            const rendered: NativeOfficePreviewContent = await office.render(credential.token,
              message.rpcId, message.payload.args, lifetime.signal)
            const { data, ...metadata } = rendered
            if (!lifetime.signal.aborted) await sendMultipart(res, message.rpcId, metadata, data)
            return
          }
          value = await office.generation(credential.token, message.rpcId, message.payload.args, lifetime.signal)
        } else value = await unary(method, message.payload.args, credential.token, message.rpcId, lifetime.signal)
        if (lifetime.signal.aborted) return
        if (value instanceof NativeWireResult) {
          const encoded = nativeRuntimeResponse(message.rpcId, value.result)
          if (path === '/native/runtime/invoke') sendJson(res, encoded)
          else await sendNativeRuntimeResponse(res, message.rpcId, encoded, ctx.powerEvolveRuntime.config.maxResponseBytes)
        } else if (method === 'workspaceFiles/readBytes') await sendNativeBytes(res, message.rpcId, value)
        else sendJson(res, { type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
      } catch (error) {
        if (!lifetime.signal.aborted) sendJson(res, { type: 'server-response', rpcId: message.rpcId,
          result: { ok: false, error: failure(error) } })
      }
    } catch (error) { if (!lifetime.signal.aborted) sendFailure(res, error) }
    finally { res.off('close', disconnected) }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/native/api', handler: nativeHandler }))
  if (ctx.powerEvolveRuntime.config.runtimeUserId !== '') {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/native/runtime/invoke', handler: nativeHandler }))
  }
}
