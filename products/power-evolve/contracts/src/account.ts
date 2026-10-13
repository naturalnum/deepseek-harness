/** Account wire records shared by the trusted page, Host capability adapter and Platform. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Stable product identity shared by browser and Platform wire records. */
export type UserId = Branded<'PowerEvolveUserId'>

/** Trusted Platform page containing account login and management. */
export const ACCOUNT_PAGE_PATH = '/account'
/** Account-page view used when product login requires a password change. */
export const ACCOUNT_PASSWORD_FRAGMENT = 'password'
/** Minimum UTF-8 length for newly assigned passwords. */
export const ACCOUNT_PASSWORD_MIN_BYTES = 12
/** Maximum UTF-8 length accepted for newly assigned passwords. */
export const ACCOUNT_PASSWORD_MAX_BYTES = 256
/** Wire ceiling for one account-list response. */
export const ACCOUNT_MAX_PAGE_ITEMS = 100
/** Wire ceiling for models assigned during account creation. */
export const ACCOUNT_MAX_MODELS_PER_USER = 16
/** Account URLs are shared with the trusted page; the Platform composes their handlers. */
export const ACCOUNT_ROUTES = {
  capabilities: '/identity/account-capabilities', login: '/account/login', me: '/account/me', logout: '/account/logout',
  models: '/account/models', list: '/account/users/list', create: '/account/users/create', update: '/account/users/update',
  remove: '/account/users/delete', resetPassword: '/account/users/reset-password',
  changePassword: '/account/password/change', receipt: '/account/mutations/receipt',
} as const

/** Roles whose authority is rechecked by the Platform. */
export const accountRole = z.enum(['ADMIN', 'USER'])
/** Credential purposes that remain mutually exclusive. */
export const accountAudience = z.enum(['agent', 'approval', 'account'])
const revision = z.number().int().positive().max(2_147_483_647)
const identifier = z.uuid()
/** UUID parser preserving the shared branded account identity. */
export const accountUserId = identifier.transform(value => brandString<UserId>(value))
const legacyUsername = z.string().min(1).max(80)
const label = z.string().trim().min(1).max(200).refine(value => !value.includes('\0'))
const modelId = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/u)
const tokens = z.number().int().min(1).max(8192)
const initialSettings = z.object({ model: modelId, maxTokens: tokens }).strict()

/** New names normalize like the old product; stored login names are never normalized. */
export const accountNewUsername = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._-]{2,63}$/u)
/** New passwords use byte bounds; this schema is never used to reject a legacy login password. */
export const accountNewPassword = z.string().max(ACCOUNT_PASSWORD_MAX_BYTES).refine((value) => {
  const bytes = new TextEncoder().encode(value).byteLength
  return bytes >= ACCOUNT_PASSWORD_MIN_BYTES && bytes <= ACCOUNT_PASSWORD_MAX_BYTES && !value.includes('\0')
})
/** Opaque bearer encoding; parsing never authenticates its holder. */
export const accountBearerToken = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/u)
/** Legacy-compatible exact username and password input. */
export const accountLoginRequest = z.object({ username: legacyUsername, password: z.string().min(1).max(256) }).strict()
/** Rejects unexpected fields on parameterless account operations. */
export const accountEmptyRequest = z.object({}).strict()
/** Requested catalog entry and user token ceiling. */
export const accountModelSelection = z.object({ id: modelId, maxTokens: tokens }).strict()

/** Stable creation request with unique model grants covering initial settings. */
export const accountCreateRequest = z.object({
  requestId: identifier, username: accountNewUsername, displayName: label, role: accountRole,
  settings: initialSettings, models: z.array(accountModelSelection).min(1).max(ACCOUNT_MAX_MODELS_PER_USER),
}).strict().refine(value => new Set(value.models.map(model => model.id)).size === value.models.length
  && value.models.some(model => model.id === value.settings.model && model.maxTokens >= value.settings.maxTokens))
/** Conditional account mutation requiring at least one changed field. */
export const accountUpdateRequest = z.object({
  requestId: identifier, userId: accountUserId, expectedRevision: revision,
  displayName: label.optional(), role: accountRole.optional(), enabled: z.boolean().optional(),
}).strict().refine(value => value.displayName !== undefined || value.role !== undefined || value.enabled !== undefined)
/** Conditional reset or removal addressed by immutable user identity. */
export const accountTargetMutationRequest = z.object({ requestId: identifier, userId: accountUserId, expectedRevision: revision }).strict()
/** Stable own-password change with distinct current and replacement inputs. */
export const accountChangePasswordRequest = z.object({
  requestId: identifier, currentPassword: z.string().min(1).max(256), newPassword: accountNewPassword,
}).strict().refine(value => value.currentPassword !== value.newPassword)
/** Bounded account search and opaque pagination input. */
export const accountListRequest = z.object({
  limit: z.number().int().min(1).max(ACCOUNT_MAX_PAGE_ITEMS).default(50),
  cursor: z.string().min(1).max(256).optional(), query: z.string().trim().max(200).optional(),
  role: accountRole.optional(), enabled: z.boolean().optional(),
}).strict()
/** Lookup key scoped to the authenticated mutation actor. */
export const accountReceiptRequest = z.object({ requestId: identifier }).strict()

/** Account views contain no password, token, provider credential or infrastructure metadata. */
export const accountValue = z.object({
  userId: accountUserId, username: legacyUsername, displayName: z.string().min(1).max(200), role: accountRole,
  enabled: z.boolean(), revision, passwordChangeRequired: z.boolean(), deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
/** Read-only navigation and role display; these fields grant no authority. */
export const accountCapabilitiesValue = z.object({
  userId: accountUserId, username: legacyUsername, displayName: z.string().min(1).max(200), role: accountRole,
  canManage: z.boolean(), accountUrl: z.url(),
}).strict()
/** The account bearer remains in trusted-page memory; it has no Host exchange or cookie endpoint. */
export const accountLoginValue = z.object({
  token: accountBearerToken, user: accountValue, restricted: z.boolean(), expiresAt: z.iso.datetime(),
}).strict()
/** Trusted-page account status and forced-change restriction. */
export const accountMeValue = z.object({ user: accountValue, restricted: z.boolean() }).strict()
/** Bounded management listing with an opaque continuation cursor. */
export const accountListValue = z.object({ items: z.array(accountValue).max(ACCOUNT_MAX_PAGE_ITEMS),
  nextCursor: z.string().max(256).nullable() }).strict()
/** Requested IDs and ceilings must also belong to this deployment-owned catalog in the transaction. */
export const accountModelCatalogValue = z.object({
  models: z.array(z.object({ id: modelId, label, maxTokens: tokens }).strict()).min(1).max(64),
  initialSettings, limits: z.object({
    maxUsers: z.number().int().positive(), maxPageItems: z.literal(ACCOUNT_MAX_PAGE_ITEMS),
    maxModelsPerUser: z.literal(ACCOUNT_MAX_MODELS_PER_USER), passwordMinBytes: z.literal(ACCOUNT_PASSWORD_MIN_BYTES),
    passwordMaxBytes: z.literal(ACCOUNT_PASSWORD_MAX_BYTES),
  }).strict(),
}).strict()
/** Durable account mutation categories. */
export const accountMutationKind = z.enum(['create', 'update', 'delete', 'reset-password', 'change-password'])
/** Durable receipt is metadata only; replay never reveals or regenerates a temporary password. */
export const accountMutationReceipt = z.object({
  requestId: identifier, kind: accountMutationKind, account: accountValue, completedAt: z.iso.datetime(),
}).strict()
/** Metadata receipt and indication that the request was already applied. */
export const accountMutationValue = z.object({ receipt: accountMutationReceipt, replay: z.boolean() }).strict()
/** Temporary password returned once; a replay must contain null. */
export const accountSecretMutationValue = accountMutationValue.extend({ temporaryPassword: accountNewPassword.nullable() }).strict()
  .refine(value => !value.replay || value.temporaryPassword === null)
/** Metadata-only lookup result for the current actor. */
export const accountReceiptValue = z.object({ receipt: accountMutationReceipt.nullable() }).strict()
/** Acknowledgement that the presented account credential was revoked. */
export const accountLogoutValue = z.object({ ok: z.literal(true) }).strict()

/** Stable account failures consumed by trusted-page localized messages. */
export const ACCOUNT_ERROR_CODES = {
  unauthorized: 'account_unauthorized', forbidden: 'account_forbidden', disabled: 'account_disabled',
  deleted: 'account_deleted', notFound: 'account_not_found', passwordChangeRequired: 'password_change_required',
  usernameConflict: 'account_username_conflict', revisionConflict: 'account_revision_conflict',
  requestConflict: 'request_id_conflict', lastAdministrator: 'account_last_administrator',
  notEmpty: 'account_not_empty', executionActive: 'account_execution_active',
  currentPasswordInvalid: 'account_current_password_invalid', passwordInvalid: 'account_password_invalid',
  bootstrapConflict: 'account_bootstrap_conflict', modelNotAuthorized: 'model_not_authorized', limit: 'account_limit',
} as const

/** Validated account role. */
export type AccountRole = z.infer<typeof accountRole>
/** Validated credential purpose. */
export type AccountAudience = z.infer<typeof accountAudience>
/** Validated account metadata without credentials. */
export type AccountValue = z.infer<typeof accountValue>
/** Validated read-only native navigation metadata. */
export type AccountCapabilities = z.infer<typeof accountCapabilitiesValue>
/** Validated account creation input. */
export type AccountCreateRequest = z.infer<typeof accountCreateRequest>
/** Validated revision-conditional account update. */
export type AccountUpdateRequest = z.infer<typeof accountUpdateRequest>
/** Validated revision-conditional reset or deletion. */
export type AccountTargetMutationRequest = z.infer<typeof accountTargetMutationRequest>
/** Validated own-password change input. */
export type AccountChangePasswordRequest = z.infer<typeof accountChangePasswordRequest>
/** Deployment-authorized model choices and account limits. */
export type AccountModelCatalog = z.infer<typeof accountModelCatalogValue>
/** Durable account mutation result without secret material. */
export type AccountMutationReceipt = z.infer<typeof accountMutationReceipt>
/** Stable account error identifier. */
export type AccountErrorCode = typeof ACCOUNT_ERROR_CODES[keyof typeof ACCOUNT_ERROR_CODES]

/** Serialize a Host-cookie product RPC POST without choosing its route or handling its response.
 * @param request Original product request preserved in the wire envelope.
 * @param signal Optional original caller lifetime, omitted when absent.
 * @returns Fresh POST options with the original same-origin credentials and JSON envelope.
 * @throws TypeError when JSON.stringify rejects the request.
 */
export function productRpcRequestInit(request: object, signal?: AbortSignal): RequestInit {
  return { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request }), ...(signal === undefined ? {} : { signal }),
  }
}
