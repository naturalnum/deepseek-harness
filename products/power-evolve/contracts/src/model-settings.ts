/** Tenant model Settings and write-only credential intake shared by native browser and Platform. */
import { z } from 'zod'

/** Original native Settings namespaces served by the two maintained adapter families. */
export const modelSettingsNamespace = z.enum(['llm-deepseek', 'llm-pi-ai'])
/** Public credential reference; values never occur in a Settings descriptor. */
export const modelCredentialReference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
/** Public discovery draft; any typed one-shot key uses direct intake instead of Host RPC. */
export const modelDiscoveryDraft = z.object({ settingsNs: modelSettingsNamespace, provider: z.string().min(1).optional(),
  baseURL: z.url().optional(), api: z.string().min(1).optional() }).strict()
/** Native model-directory result preserved without provider key bytes. */
export const modelDiscovered = z.object({ id: z.string().min(1), name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(),
  inputModalities: z.array(z.enum(['text', 'image'])).optional() }).strict()
/** Revisioned native path operations; the namespace's maintained schema validates their result. */
export const modelSettingsWrite = z.object({ ns: modelSettingsNamespace,
  mode: z.enum(['update', 'replace', 'mutate']), expectedRevision: z.number().int().positive().optional(),
  value: z.union([z.record(z.string(), z.json()), z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('set'), path: z.array(z.string()).max(32), value: z.json() }).strict(),
    z.object({ op: z.literal('unset'), path: z.array(z.string()).max(32) }).strict(),
  ])).max(256)]),
}).strict()
/** Metadata-only capability request; the original submission identity survives uncertain upload outcomes. */
export const modelCredentialTicketRequest = z.object({ requestId: z.uuid(), ref: modelCredentialReference,
  sizeBytes: z.number().int().positive(), discovery: modelDiscoveryDraft.optional() }).strict()
/** Original write outcome, without key bytes or an export capability. */
export const modelCredentialReceipt = z.object({ saved: z.boolean(), models: z.array(modelDiscovered).optional() }).strict()
/** Bearer usable only for one bounded direct Platform credential upload. */
export const modelCredentialTicket = z.object({ requestId: z.uuid(), ticket: z.string().min(43).max(256),
  uploadUrl: z.url(), expiresAt: z.iso.datetime() }).strict()
/** Deployment-owned intake and state budgets. */
export const modelSettingsLimits = z.object({
  maxSettingsBytes: z.number().int().positive().default(1_048_576),
  maxCredentialBytes: z.number().int().positive().default(8192),
  maxCredentialReferences: z.number().int().positive().default(256),
  maxPendingTickets: z.number().int().positive().default(16),
  ticketLifetimeMs: z.number().int().positive().max(2_147_483_647).default(60_000),
  maxCatalogModels: z.number().int().positive().default(4096),
}).strict()
/** Validated Platform model budgets. */
export type ModelSettingsLimits = z.infer<typeof modelSettingsLimits>
/** Browser-safe native Settings write. */
export type ModelSettingsWrite = z.infer<typeof modelSettingsWrite>
