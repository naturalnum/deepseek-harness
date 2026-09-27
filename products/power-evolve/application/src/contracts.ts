/** Validated product wire records; native Session events retain their upstream representation. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

export type UserId = Branded<'PowerEvolveUserId'>
export type OperationId = Branded<'PowerEvolveOperationId'>
export type RequestId = Branded<'PowerEvolveRequestId'>
export const userId = z.uuid().transform(value => brandString<UserId>(value))
export const operationId = z.uuid().transform(value => brandString<OperationId>(value))
export const requestId = z.uuid().transform(value => brandString<RequestId>(value))
export const sessionId = z.uuid().transform(SessionId)

export const identity = z.object({ userId, username: z.string().min(1).max(80) }).strict()
export type Identity = z.infer<typeof identity>
export const settings = z.object({
  model: z.string().min(1).max(100),
  maxTokens: z.number().int().min(1).max(8192),
  revision: z.number().int().positive(),
}).strict()
export type Settings = z.infer<typeof settings>
export const createRequest = z.object({ requestId }).strict()
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
export const skillInstallRequest = z.object({
  requestId, name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(4096),
}).strict()
export const skillRequest = z.object({ skillId: z.uuid() }).strict()
export const skillToggleRequest = z.object({ skillId: z.uuid(), enabled: z.boolean() }).strict()
export const skillSnapshot = z.object({
  name: z.string(), description: z.string(), instructions: z.string(), revision: z.number().int().positive(),
}).strict()
export const skillSelection = z.object({
  skillId: z.uuid(), name: z.string(), description: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
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
  source: z.enum(['user', 'platform_action', 'sandbox_result', 'desktop_result']).default('user'),
  sourceActionId: z.uuid().nullable().default(null),
  sourceExecutionId: z.uuid().nullable().default(null),
  sourceDesktopExecutionId: z.uuid().nullable().default(null),
  target: executionTarget.default({ kind: 'cloud' }),
  executionEnabled: z.boolean().default(false),
  skills: z.array(skillSnapshot).max(8).default([]),
  selection: z.array(skillSelection).max(8).default([]),
}).strict()
export type Grant = z.infer<typeof grant>

/** HTTP refusal safe to return without exposing database or upstream diagnostics. */
export class PlatformError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
