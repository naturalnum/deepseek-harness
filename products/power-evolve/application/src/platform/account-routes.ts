/** Frozen account endpoint contracts; composition and trusted static assets belong to the integrator. */
import { accountChangePasswordRequest, accountCreateRequest, accountEmptyRequest, accountListRequest,
  accountLoginRequest, accountReceiptRequest, accountTargetMutationRequest, accountUpdateRequest,
  ACCOUNT_ROUTES } from '../account-contracts.ts'
import { ACCOUNT_ERROR_CODES } from '../account-contracts.ts'
import { PlatformError } from '../contracts.ts'
import type { AccountService } from './accounts.ts'

export { ACCOUNT_ROUTES } from '../account-contracts.ts'
/** JSON validators selected by each frozen account URL. */
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

/**
 * Parse account JSON and require the exact Platform origin before every trusted-page operation.
 * @param service Account lifecycle provider composed by the Platform.
 * @param path Frozen account URL, including the Agent-only capability URL.
 * @param token Raw bearer, or undefined for password login.
 * @param input Bounded parsed JSON; the Platform charges login admission before reading it.
 * @param origin Browser Origin header; account routes require it, capability lookup uses Agent authentication.
 * @returns The selected secret-free response, with first-response temporary passwords only for create/reset.
 */
export async function routeAccount(service: AccountService, path: string, token: string | undefined,
  input: unknown, origin: string | undefined): Promise<unknown> {
  if (path !== ACCOUNT_ROUTES.capabilities && origin !== service.platformOrigin) throw new PlatformError(403, 'invalid_origin')
  if (path === ACCOUNT_ROUTES.login) {
    const value = accountLoginRequest.parse(input)
    return service.login(value.username, value.password)
  }
  if (!token) throw new PlatformError(401, ACCOUNT_ERROR_CODES.unauthorized)
  switch (path) {
    case ACCOUNT_ROUTES.capabilities: accountEmptyRequest.parse(input); return service.capabilities(token)
    case ACCOUNT_ROUTES.me: accountEmptyRequest.parse(input); return service.me(token)
    case ACCOUNT_ROUTES.logout: accountEmptyRequest.parse(input); return service.logout(token)
    case ACCOUNT_ROUTES.models: accountEmptyRequest.parse(input); return service.models(token)
    case ACCOUNT_ROUTES.list: return service.list(token, accountListRequest.parse(input))
    case ACCOUNT_ROUTES.create: return service.create(token, accountCreateRequest.parse(input))
    case ACCOUNT_ROUTES.update: return service.update(token, accountUpdateRequest.parse(input))
    case ACCOUNT_ROUTES.remove: return service.remove(token, accountTargetMutationRequest.parse(input))
    case ACCOUNT_ROUTES.resetPassword: return service.resetPassword(token, accountTargetMutationRequest.parse(input))
    case ACCOUNT_ROUTES.changePassword: return service.changePassword(token, accountChangePasswordRequest.parse(input))
    case ACCOUNT_ROUTES.receipt: return service.receipt(token, accountReceiptRequest.parse(input).requestId)
    default: throw new PlatformError(404, 'not_found')
  }
}
