/** Native Session commands shared by the authenticated Host and trusted Platform. */
import { z } from 'zod'
import { sessionId } from './contracts.ts'

/** Native title mutation; normalization and byte limits belong to the configured service. */
export const nativeSessionRename = z.object({ sessionId, title: z.string().min(1).max(4096) }).strict()
/** Native exact-prefix fork; omission selects the last completed-turn prefix. */
export const nativeSessionFork = z.object({
  sessionId,
  atSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()
/** Native content-search request; visible text is limited to 500 UTF-16 code units and excludes NUL. */
export const nativeSessionSearch = z.object({ query: z.string().trim().min(1).max(500)
  .refine(query => !query.includes('\0')) }).strict()
/** Native route and effort identities are checked against this owner's adapter catalog at admission. */
export const nativeModelSelect = z.object({ sessionId, provider: z.string().min(1).max(128),
  model: z.string().min(1).max(1024), reasoningEffort: z.string().min(1).max(128).optional() }).strict()
