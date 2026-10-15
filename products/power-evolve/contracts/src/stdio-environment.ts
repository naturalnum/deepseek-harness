/** Metadata-only STDIO environment management and direct Platform upload envelopes. */
import { z } from 'zod'
import { stdioEnvironmentRef } from './mcp-metadata.ts'

const uuid = z.uuid()
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)

/** Operator limits for private credential intake; old deployments use these validated defaults. */
export const stdioEnvironmentOptions = z.object({
  ticketLifetimeMs: z.number().int().positive().max(2_147_483_647).default(60_000),
  maxPendingTickets: z.number().int().positive().default(16),
  maxVersionsPerUser: z.number().int().positive().default(2048),
  maxUploadBytes: z.number().int().positive().default(65_536),
}).strict()

/** A retained value must come from this user's exact saved connection revision. */
export const stdioEnvironmentSource = z.object({ connectionId: uuid, expectedRevision: z.number().int().positive(),
  credentialVersion: uuid }).strict()

/** Keys and replacement intent may pass through Host; replacement values may not. */
export const stdioEnvironmentTicketRequest = z.object({ requestId: uuid,
  sizeBytes: z.number().int().positive(), source: stdioEnvironmentSource.optional(),
  keys: z.array(z.object({ name, action: z.enum(['retain', 'replace']) }).strict()).min(1).max(64),
}).strict().refine(value => new Set(value.keys.map(item => item.name)).size === value.keys.length
  && (value.source !== undefined || value.keys.every(item => item.action === 'replace')))

/** Only the one-use direct Platform capability accepts environment values. */
export const stdioEnvironmentUpload = z.object({ formatVersion: z.literal(1),
  values: z.array(z.object({ name, value: z.string().refine(value => !value.includes('\0')
    && new TextEncoder().encode(value).byteLength <= 8192) }).strict()).max(64),
}).strict().refine(value => new Set(value.values.map(item => item.name)).size === value.values.length)

/** Receipt reads contain only an immutable masked version reference. */
export const stdioEnvironmentReceiptRequest = z.object({ requestId: uuid }).strict()
/** A lost upload is reconciled by its original request identity, without sending values through Host. */
export const stdioEnvironmentReceipt = z.object({ environment: stdioEnvironmentRef.nullable() }).strict()
/** One-use direct upload; its bearer is not an Agent, Runtime, or executor credential. */
export const stdioEnvironmentTicket = z.object({ requestId: uuid, ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  uploadUrl: z.url(), expiresAt: z.iso.datetime() }).strict()

/** Public intake budgets contain no encryption or worker authority. */
export type StdioEnvironmentOptions = z.infer<typeof stdioEnvironmentOptions>
/** Owner-scoped metadata request for the current saved source and complete key plan. */
export type StdioEnvironmentTicketRequest = z.infer<typeof stdioEnvironmentTicketRequest>

/** Explicit process overrides accepted only through authenticated Platform-to-Runner control traffic. */
export const stdioEnvironmentValues = z.record(name, z.string().refine(value => !value.includes('\0')
  && new TextEncoder().encode(value).byteLength <= 8192)).refine(value => Object.keys(value).length <= 64)
