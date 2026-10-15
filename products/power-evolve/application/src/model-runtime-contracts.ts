/** Provider-neutral native model transport; adapters alone own provider conversion and replay metadata. */
import { z } from 'zod'
import type { GenerateOptions, LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { modelMessageJson } from './mcp-model-tools.ts'
import { nativeFileAttachment } from './native-attachment-contracts.ts'
import { legacyMigrationImage } from './platform/legacy-migration-v2-media-contracts.ts'

const identity = z.string().min(1)
/** A private prepared native configuration, carrying no execution authority. */
export type NativeModelPreparationId = Branded<'PowerEvolveModelPreparationId'>
/** Validated opaque identity of one prepared native call. */
export const nativeModelPreparationId = z.uuid().transform(brandString<NativeModelPreparationId>)
/** Public catalog facts consumed by the original synchronous native image pricing helper. */
export type NativeModelImagePricing = { kind: 'none' } | { kind: 'deepseek'; model?: DeepSeekCatalogModel }
/** Native prepared-call metadata; the identity binds private configuration without granting execution. */
export interface NativePreparedModel {
  readonly preparationId: NativeModelPreparationId
  readonly model: LlmResolvedModelInfo
  readonly imagePricing: NativeModelImagePricing
}
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning'), text: z.string() }).strict(),
  z.object({ type: z.literal('tool-call'), id: identity, name: identity, arguments: z.string() }).strict(),
  z.object({ type: z.literal('tool-addition'), toolName: identity }).strict(),
  z.object({ type: z.literal('tool-removal'), toolName: identity }).strict(),
  z.object({ type: z.literal('image'), attachment: legacyMigrationImage, offloaded: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('file'), attachment: nativeFileAttachment }).strict(),
])
const source = z.object({ kind: identity }).catchall(modelMessageJson)
const content = z.array(block)
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content, id: identity.optional(), source: source.optional() }).strict()
    .refine(value => (value.id === undefined) === (value.source === undefined)),
  z.object({ role: z.literal('developer'), content, id: identity, source }).strict(),
  z.object({ role: z.literal('system'), content, id: identity, source: z.object({ kind: z.literal('system-prompt') }).strict() }).strict(),
  z.object({ role: z.literal('assistant'), content, id: identity, source: z.object({ kind: z.literal('model'),
    provider: identity, model: identity, replayState: modelMessageJson.optional() }).strict() }).strict(),
  z.object({ role: z.literal('tool'), content, id: identity, source: z.object({ kind: z.literal('tool'), callId: identity }).strict(),
    toolCallId: identity, isError: z.boolean().optional() }).strict(),
])
const nativeMessage = z.custom<RequestMessage>(value => message.safeParse(value).success)
const tool = z.object({ name: identity, description: z.string(), parameters: z.record(z.string(), modelMessageJson),
  deferLoading: z.literal(true).optional() }).strict()
const request = z.object({ provider: identity, model: identity, reasoningEffort: identity.optional(),
  messages: z.array(nativeMessage), tools: z.array(tool).optional(), system: z.string().optional(),
  toolHistory: z.object({ tools: z.array(tool),
    updates: z.array(z.object({ messageId: identity, additions: z.array(tool) }).strict()) }).strict().optional(),
  temperature: z.number().optional(), maxTokens: z.number().int().positive().optional(), stop: z.array(z.string()).optional(),
  sessionId: z.uuid(), purpose: z.enum(['compaction', 'session-title']).optional(),
  preparationId: nativeModelPreparationId,
}).strict()

type NativeModelRequest = Omit<GenerateOptions, 'signal'> & {
  sessionId: NonNullable<GenerateOptions['sessionId']>
  preparationId: NativeModelPreparationId
}
/** Complete JSON request accepted only with its original operation bearer; AbortSignal stays in the HTTP lifetime. */
export const nativeModelRequest = z.custom<NativeModelRequest>(
  value => request.safeParse(value).success,
)
const failure = z.object({ message: z.string(), code: identity, status: z.number().optional(),
  providerRetryAfterMs: z.number().optional(), requestId: z.string().optional(),
  offloadImages: z.number().int().positive().optional() }).strict()
const reason = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stop') }).strict(), z.object({ kind: z.literal('tool-calls') }).strict(),
  z.object({ kind: z.literal('max-tokens') }).strict(),
  z.object({ kind: z.literal('aborted'), failure }).strict(), z.object({ kind: z.literal('error'), failure }).strict(),
])
const chunk = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block-start'), index: z.number().int().nonnegative(),
    blockType: z.enum(['text', 'reasoning', 'tool-call', 'tool-addition', 'tool-removal', 'image', 'file']) }).strict(),
  z.object({ type: z.literal('text-delta'), index: z.number().int().nonnegative(), text: z.string() }).strict(),
  z.object({ type: z.literal('reasoning-delta'), index: z.number().int().nonnegative(), text: z.string() }).strict(),
  z.object({ type: z.literal('tool-call-delta'), index: z.number().int().nonnegative(), id: identity,
    name: z.string().optional(), argumentsDelta: z.string() }).strict(),
  z.object({ type: z.literal('block-end'), index: z.number().int().nonnegative(), block }).strict(),
  z.object({ type: z.literal('usage'), usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative().optional(), cacheReadTokens: z.number().nonnegative().optional(),
    cacheWriteTokens: z.number().nonnegative().optional(), reasoningTokens: z.number().nonnegative().optional() }).strict() }).strict(),
  z.object({ type: z.literal('finish'), reason, replayState: z.object({ response: modelMessageJson,
    blocks: z.array(modelMessageJson).optional() }).strict().optional() }).strict(),
])
/** Lossless JSON native StreamChunk on each NDJSON line; provider replay envelopes stay opaque. */
export const nativeModelStreamChunk = z.custom<StreamChunk>(value => chunk.safeParse(value).success)
/** Model resolution uses a public route identity and requires either a browser or tenant-runtime credential. */
export const nativeModelResolve = z.object({ provider: identity, model: identity }).strict()
