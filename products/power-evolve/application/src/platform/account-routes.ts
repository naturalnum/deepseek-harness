/** Frozen account endpoint contracts; composition and trusted static assets belong to the integrator. */
import { accountChangePasswordRequest, accountCreateRequest, accountEmptyRequest, accountListRequest,
  accountLoginRequest, accountReceiptRequest, accountTargetMutationRequest, accountUpdateRequest,
  ACCOUNT_ROUTES } from '../account-contracts.ts'

export { ACCOUNT_ROUTES } from '../account-contracts.ts'
export const accountRouteRequests = {
  capabilities: accountEmptyRequest, login: accountLoginRequest, me: accountEmptyRequest, logout: accountEmptyRequest,
  models: accountEmptyRequest, list: accountListRequest, create: accountCreateRequest, update: accountUpdateRequest,
  remove: accountTargetMutationRequest, resetPassword: accountTargetMutationRequest,
  changePassword: accountChangePasswordRequest, receipt: accountReceiptRequest,
} as const
/** Only these account routes are available while the bearer is restricted to first-password change. */
export const ACCOUNT_RESTRICTED_ROUTES: ReadonlySet<string> = new Set([
  ACCOUNT_ROUTES.me, ACCOUNT_ROUTES.logout, ACCOUNT_ROUTES.changePassword, ACCOUNT_ROUTES.receipt,
])
/** Host capability lookup uses Agent authentication; every /account POST requires the exact Platform origin. */
export const ACCOUNT_ADMIN_ROUTES: ReadonlySet<string> = new Set([
  ACCOUNT_ROUTES.models, ACCOUNT_ROUTES.list, ACCOUNT_ROUTES.create, ACCOUNT_ROUTES.update,
  ACCOUNT_ROUTES.remove, ACCOUNT_ROUTES.resetPassword,
])
