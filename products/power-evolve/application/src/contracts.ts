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
export const promptRequest = z.object({
  sessionId, requestId, text: z.string().trim().min(1).max(16_384),
}).strict()
export const pageRequest = z.object({
  sessionId, after: z.number().int().min(-1), limit: z.number().int().min(1).max(200),
}).strict()
export const sessionRequest = z.object({ sessionId }).strict()
export const listRequest = z.object({ offset: z.number().int().min(0), limit: z.number().int().min(1).max(100) }).strict()
export const loginRequest = z.object({
  username: z.string().min(1).max(80), password: z.string().min(1).max(256),
}).strict()
export const grant = z.object({
  operationId, sessionId, userId, requestId,
  text: z.string().max(16_384),
  token: z.string().min(32).max(256),
  epoch: z.number().int().positive(),
  settings,
}).strict()
export type Grant = z.infer<typeof grant>

/** HTTP refusal safe to return without exposing database or upstream diagnostics. */
export class PlatformError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
