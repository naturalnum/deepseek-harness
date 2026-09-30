/** Validated product wire records; native Session events retain their upstream representation. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type UserId = Branded<'PowerEvolveUserId'>
export type OperationId = Branded<'PowerEvolveOperationId'>
export type RequestId = Branded<'PowerEvolveRequestId'>
export type WorkspaceId = Branded<'PowerEvolveWorkspaceId'>
export const userId = z.uuid().transform(value => brandString<UserId>(value))
export const operationId = z.uuid().transform(value => brandString<OperationId>(value))
export const requestId = z.uuid().transform(value => brandString<RequestId>(value))
export const workspaceId = z.uuid().transform(value => brandString<WorkspaceId>(value))
export const sessionId = z.uuid().transform(SessionId)

export const identity = z.object({ userId, username: z.string().min(1).max(80) }).strict()
export type Identity = z.infer<typeof identity>
export const settings = z.object({
  model: z.string().min(1).max(100),
  maxTokens: z.number().int().min(1).max(8192),
  revision: z.number().int().positive(),
}).strict()
export type Settings = z.infer<typeof settings>
export const modelsListRequest = z.object({}).strict()
export const settingsUpdateRequest = z.object({
  requestId, expectedRevision: z.number().int().positive(),
  model: z.string().min(1).max(100), maxTokens: z.number().int().min(1).max(8192),
}).strict()
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequest>
export const createRequest = z.object({ requestId, workspaceId: workspaceId.optional() }).strict()
export const workspaceCreateRequest = z.object({ requestId, title: z.string().trim().min(1).max(80) }).strict()
export const executionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cloud') }).strict(),
  z.object({ kind: z.literal('desktop'), deviceId: z.uuid(), directoryId: z.uuid() }).strict(),
])
export type ExecutionTarget = z.infer<typeof executionTarget>
export const promptRequest = z.object({
  sessionId, requestId, text: z.string().trim().min(1).max(16_384),
  target: executionTarget.default({ kind: 'cloud' }),
}).strict()
export const pageRequest = z.object({
  sessionId, after: z.number().int().min(-1), limit: z.number().int().min(1).max(200),
}).strict()
export const sessionRequest = z.object({ sessionId }).strict()
export const listRequest = z.object({ offset: z.number().int().min(0), limit: z.number().int().min(1).max(100) }).strict()
export const filesListRequest = z.object({ directory: z.string().max(512) }).strict()
export const fileReadRequest = z.object({ path: z.string().min(1).max(512) }).strict()
export const filePutRequest = z.object({
  requestId, path: z.string().min(1).max(512), baseRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  data: z.string().max(2_800_000),
}).strict()
export const sessionFilesListRequest = filesListRequest.extend({ sessionId }).strict()
export const sessionFileReadRequest = fileReadRequest.extend({ sessionId }).strict()
export const sessionFilePutRequest = filePutRequest.extend({ sessionId }).strict()
export const skillInstallRequest = z.object({
  requestId, name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(4096),
}).strict()
export const builtinSkillInstallRequest = z.object({
  requestId, catalogId: z.string().max(128).regex(/^builtin\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
  version: z.string().max(64).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
}).strict()
export const skillRequest = z.object({ skillId: z.uuid() }).strict()
export const skillResourceRequest = skillRequest.extend({ path: z.string().min(1).max(512).optional() }).strict()
export const skillResourceView = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), files: z.array(z.object({
    path: z.string().min(1).max(512), size: z.number().int().min(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).max(256) }).strict(),
  z.object({ kind: z.literal('text'), path: z.string().min(1).max(512), text: z.string().max(262144),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
])
export const skillToggleRequest = z.object({ skillId: z.uuid(), enabled: z.boolean() }).strict()
export const skillRevokeRequest = skillRequest
export const skillUploadTicketRequest = z.object({
  requestId, sizeBytes: z.number().int().min(1).max(1_048_576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const skillSnapshot = z.object({
  name: z.string(), description: z.string(), instructions: z.string(), revision: z.number().int().positive(),
  kind: z.enum(['text', 'package']).default('text'), version: z.string().nullable().default(null),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict()
export const runtimeSkillSnapshot = skillSnapshot.extend({
  runtimePath: z.string().max(512).nullable().optional(), suiteAvailable: z.boolean().optional(),
}).strict()
export const skillSelection = z.object({
  skillId: z.uuid(), name: z.string(), description: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  kind: z.enum(['text', 'package']).default('text'), version: z.string().nullable().default(null),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict()
export const mcpSelection = z.object({ connectionId: z.uuid(), revision: z.number().int().positive() }).strict()
export const stdioMcpSelection = z.object({ connectionId: z.uuid(), revision: z.number().int().positive() }).strict()
export const sshSelection = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(),
  credentialRevision: z.number().int().positive(), displayName: z.string().min(1).max(100),
  host: z.string().min(1).max(253), port: z.number().int().min(1).max(65_535),
  username: z.string().min(1).max(100) }).strict()
export const sshCreateTicketRequest = z.object({
  requestId, displayName: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(100),
  hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
  credentialKind: z.literal('password'), sizeBytes: z.number().int().min(1).max(4096), enabled: z.boolean(),
}).strict()
export const sshToggleRequest = z.object({ connectionId: z.uuid(), requestId,
  baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict()
export const sshCheckRequest = z.object({ requestId, connectionId: z.uuid(),
  connectionRevision: z.number().int().positive() }).strict()
export const sshCallRefRequest = z.object({ callId: z.uuid() }).strict()
export const sshExecuteProposeRequest = z.object({ callKey: z.string().min(1).max(100),
  connectionId: z.uuid(), connectionRevision: z.number().int().positive(),
  credentialRevision: z.number().int().positive(), command: z.string().min(1).max(16_384) }).strict()
export const sshExecuteRefRequest = z.object({ actionId: z.uuid() }).strict()
export const sshExecuteView = z.object({ actionId: z.uuid(),
  state: z.enum(['pending', 'rejected', 'approved', 'succeeded', 'failed', 'uncertain', 'cancelled']),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), callId: z.uuid().optional(),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u).optional(),
  result: z.object({ kind: z.literal('ssh.execute'), exitCode: z.number().int().nullable(),
    signal: z.string().max(100).nullable(), stdout: z.string(), stderr: z.string() }).strict().optional(),
}).strict()
export const sshCheckView = z.object({ callId: z.uuid(),
  state: z.enum(['accepted', 'preparing', 'ready', 'dispatch-intent', 'running',
    'succeeded', 'failed', 'uncertain', 'cancelled']),
  result: z.object({ kind: z.literal('ssh.authenticate'), serverBanner: z.string().max(512).nullable() }).strict().optional(),
  errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u).optional(),
}).strict()
export const loginRequest = z.object({
  username: z.string().min(1).max(80), password: z.string().min(1).max(256),
}).strict()
export const grant = z.object({
  operationId, sessionId, userId, requestId,
  text: z.string().max(16_384),
  token: z.string().min(32).max(256),
  epoch: z.number().int().positive(),
  settings,
  source: z.enum(['user', 'platform_action', 'sandbox_result', 'desktop_result', 'stdio_mcp_result',
    'ssh_execute_result']).default('user'),
  sourceActionId: z.uuid().nullable().default(null),
  sourceExecutionId: z.uuid().nullable().default(null),
  sourceDesktopExecutionId: z.uuid().nullable().default(null),
  sourceStdioMcpCallId: z.uuid().nullable().default(null),
  sourceSshExecuteActionId: z.uuid().nullable().default(null),
  target: executionTarget.default({ kind: 'cloud' }),
  executionEnabled: z.boolean().default(false),
  skills: z.array(skillSnapshot).max(256).default([]),
  selection: z.array(skillSelection).max(256).default([]),
  mcpConnections: z.array(mcpSelection).max(1).default([]),
  stdioMcpConnections: z.array(stdioMcpSelection).max(1).default([]),
  sshConnections: z.array(sshSelection).max(8).default([]),
}).strict()
export type Grant = z.infer<typeof grant>

/** HTTP refusal safe to return without exposing database or upstream diagnostics. */
export class PlatformError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
