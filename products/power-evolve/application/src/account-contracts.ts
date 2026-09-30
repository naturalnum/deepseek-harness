/** Account wire records shared by the trusted page, Host capability adapter and Platform. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { UserId } from './contracts.ts'

export const ACCOUNT_PAGE_PATH = '/account'
export const ACCOUNT_PASSWORD_FRAGMENT = 'password'
export const ACCOUNT_PASSWORD_MIN_BYTES = 12
export const ACCOUNT_PASSWORD_MAX_BYTES = 256
export const ACCOUNT_MAX_PAGE_ITEMS = 100
export const ACCOUNT_MAX_MODELS_PER_USER = 16
/** Account URLs are shared with the trusted page; the Platform composes their handlers. */
export const ACCOUNT_ROUTES = {
  capabilities: '/identity/account-capabilities', login: '/account/login', me: '/account/me', logout: '/account/logout',
  models: '/account/models', list: '/account/users/list', create: '/account/users/create', update: '/account/users/update',
  remove: '/account/users/delete', resetPassword: '/account/users/reset-password',
  changePassword: '/account/password/change', receipt: '/account/mutations/receipt',
} as const

export const accountRole = z.enum(['ADMIN', 'USER'])
export const accountAudience = z.enum(['agent', 'approval', 'account'])
const revision = z.number().int().positive().max(2_147_483_647)
const identifier = z.uuid()
export const accountUserId = identifier.transform(value => brandString<UserId>(value))
const legacyUsername = z.string().min(1).max(80)
const label = z.string().trim().min(1).max(200).refine(value => !value.includes('\0'))
const modelId = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/u)
const tokens = z.number().int().min(1).max(8192)
const initialSettings = z.object({ model: modelId, maxTokens: tokens }).strict()

/** New names normalize like the old product; stored login names are never normalized. */
export const accountNewUsername = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,63}$/u)
/** New passwords use byte bounds; this schema is never used to reject a legacy login password. */
export const accountNewPassword = z.string().max(ACCOUNT_PASSWORD_MAX_BYTES).refine(value => {
  const bytes = new TextEncoder().encode(value).byteLength
  return bytes >= ACCOUNT_PASSWORD_MIN_BYTES && bytes <= ACCOUNT_PASSWORD_MAX_BYTES && !value.includes('\0')
})
export const accountBearerToken = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u)
export const accountLoginRequest = z.object({ username: legacyUsername, password: z.string().min(1).max(256) }).strict()
export const accountEmptyRequest = z.object({}).strict()
export const accountModelSelection = z.object({ id: modelId, maxTokens: tokens }).strict()

export const accountCreateRequest = z.object({
  requestId: identifier, username: accountNewUsername, displayName: label, role: accountRole,
  settings: initialSettings, models: z.array(accountModelSelection).min(1).max(ACCOUNT_MAX_MODELS_PER_USER),
}).strict().refine(value => new Set(value.models.map(model => model.id)).size === value.models.length
  && value.models.some(model => model.id === value.settings.model && model.maxTokens >= value.settings.maxTokens))
export const accountUpdateRequest = z.object({
  requestId: identifier, userId: accountUserId, expectedRevision: revision,
  displayName: label.optional(), role: accountRole.optional(), enabled: z.boolean().optional(),
}).strict().refine(value => value.displayName !== undefined || value.role !== undefined || value.enabled !== undefined)
export const accountTargetMutationRequest = z.object({ requestId: identifier, userId: accountUserId, expectedRevision: revision }).strict()
export const accountChangePasswordRequest = z.object({
  requestId: identifier, currentPassword: z.string().min(1).max(256), newPassword: accountNewPassword,
}).strict().refine(value => value.currentPassword !== value.newPassword)
export const accountListRequest = z.object({
  limit: z.number().int().min(1).max(ACCOUNT_MAX_PAGE_ITEMS).default(50),
  cursor: z.string().min(1).max(256).optional(), query: z.string().trim().max(200).optional(),
  role: accountRole.optional(), enabled: z.boolean().optional(),
}).strict()
export const accountReceiptRequest = z.object({ requestId: identifier }).strict()

/** Account views contain no password, token, provider credential or infrastructure metadata. */
export const accountValue = z.object({
  userId: accountUserId, username: legacyUsername, displayName: z.string().min(1).max(200), role: accountRole,
  enabled: z.boolean(), revision, passwordChangeRequired: z.boolean(), deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
export const accountCapabilitiesValue = z.object({
  userId: accountUserId, username: legacyUsername, displayName: z.string().min(1).max(200), role: accountRole,
  canManage: z.boolean(), accountUrl: z.url(),
}).strict()
/** The account bearer remains in trusted-page memory; it has no Host exchange or cookie endpoint. */
export const accountLoginValue = z.object({
  token: accountBearerToken, user: accountValue, restricted: z.boolean(), expiresAt: z.iso.datetime(),
}).strict()
export const accountMeValue = z.object({ user: accountValue, restricted: z.boolean() }).strict()
export const accountListValue = z.object({ items: z.array(accountValue).max(ACCOUNT_MAX_PAGE_ITEMS), nextCursor: z.string().max(256).nullable() }).strict()
/** Requested IDs and ceilings must also belong to this deployment-owned catalog in the transaction. */
export const accountModelCatalogValue = z.object({
  models: z.array(z.object({ id: modelId, label, maxTokens: tokens }).strict()).min(1).max(64),
  initialSettings, limits: z.object({
    maxUsers: z.number().int().positive(), maxPageItems: z.literal(ACCOUNT_MAX_PAGE_ITEMS),
    maxModelsPerUser: z.literal(ACCOUNT_MAX_MODELS_PER_USER), passwordMinBytes: z.literal(ACCOUNT_PASSWORD_MIN_BYTES),
    passwordMaxBytes: z.literal(ACCOUNT_PASSWORD_MAX_BYTES),
  }).strict(),
}).strict()
export const accountMutationKind = z.enum(['create', 'update', 'delete', 'reset-password', 'change-password'])
/** Durable receipt is metadata only; replay never reveals or regenerates a temporary password. */
export const accountMutationReceipt = z.object({
  requestId: identifier, kind: accountMutationKind, account: accountValue, completedAt: z.iso.datetime(),
}).strict()
export const accountMutationValue = z.object({ receipt: accountMutationReceipt, replay: z.boolean() }).strict()
export const accountSecretMutationValue = accountMutationValue.extend({ temporaryPassword: accountNewPassword.nullable() }).strict()
  .refine(value => !value.replay || value.temporaryPassword === null)
export const accountReceiptValue = z.object({ receipt: accountMutationReceipt.nullable() }).strict()
export const accountLogoutValue = z.object({ ok: z.literal(true) }).strict()

export const ACCOUNT_ERROR_CODES = {
  unauthorized: 'account_unauthorized', forbidden: 'account_forbidden', disabled: 'account_disabled',
  deleted: 'account_deleted', notFound: 'account_not_found', passwordChangeRequired: 'password_change_required',
  usernameConflict: 'account_username_conflict', revisionConflict: 'account_revision_conflict',
  requestConflict: 'request_id_conflict', lastAdministrator: 'account_last_administrator',
  notEmpty: 'account_not_empty', executionActive: 'account_execution_active',
  currentPasswordInvalid: 'account_current_password_invalid', passwordInvalid: 'account_password_invalid',
  bootstrapConflict: 'account_bootstrap_conflict', modelNotAuthorized: 'model_not_authorized', limit: 'account_limit',
} as const

export type AccountRole = z.infer<typeof accountRole>
export type AccountAudience = z.infer<typeof accountAudience>
export type AccountValue = z.infer<typeof accountValue>
export type AccountCapabilities = z.infer<typeof accountCapabilitiesValue>
export type AccountCreateRequest = z.infer<typeof accountCreateRequest>
export type AccountUpdateRequest = z.infer<typeof accountUpdateRequest>
export type AccountTargetMutationRequest = z.infer<typeof accountTargetMutationRequest>
export type AccountChangePasswordRequest = z.infer<typeof accountChangePasswordRequest>
export type AccountModelCatalog = z.infer<typeof accountModelCatalogValue>
export type AccountMutationReceipt = z.infer<typeof accountMutationReceipt>
export type AccountErrorCode = typeof ACCOUNT_ERROR_CODES[keyof typeof ACCOUNT_ERROR_CODES]
