/** Consistency checks applied after real authentication; they never select an account. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { RequestBindingFailure, RequestExpectation, RequestExpectationValues } from './types.ts'

type BindingHttpStatus = 409

/** A stale or missing client expectation; the caller must bootstrap before new operations. */
export class RequestBindingError extends Error {
  /** Stable C-01 binding rejection. */
  readonly code: RequestBindingFailure['code'] = 'cloud/stale-generation'
  /** HTTP conflict status. */
  readonly status: BindingHttpStatus = 409
  /** Require a status check before a new operation. */
  readonly retry: RequestBindingFailure['retry'] = 'after-status-check'

  /** @param requestId - Server-generated correlation identity, without request data. */
  constructor(readonly requestId: Branded<'pe-request-id'>) {
    super('Account connection is no longer current. Bootstrap before sending a new operation.')
    this.name = 'RequestBindingError'
  }

  /**
   * Serialize a safe binding failure.
   * @returns C-01 wire failure, without the rejected account or generation.
   */
  toJSON(): RequestBindingFailure {
    return { code: this.code, message: this.message, requestId: this.requestId, retry: this.retry }
  }
}

/**
 * Require one nonempty value for each dedicated carrier field.
 * @param values - All header or query occurrences, retaining duplicates.
 * @param requestId - Server-generated correlation identity.
 * @returns client consistency expectations, never an authenticated principal.
 * @throws RequestBindingError for missing, duplicate, blank, or padded values.
 */
export function parseRequestExpectation(
  values: RequestExpectationValues,
  requestId: Branded<'pe-request-id'>,
): RequestExpectation {
  const accountId = singleValue(values.accountIds, requestId)
  const connectionGeneration = singleValue(values.connectionGenerations, requestId)
  return { accountId, connectionGeneration }
}

/**
 * Compare the expected account immediately after database-backed authentication.
 * @param expected - Client expectations from the selected carrier.
 * @param authenticatedAccountId - Account from the authentication library, never a header or body.
 * @param requestId - Server-generated correlation identity.
 * @throws RequestBindingError before owner lookup or account acquisition on mismatch.
 */
export function assertExpectedAccount(
  expected: Pick<RequestExpectation, 'accountId'>,
  authenticatedAccountId: AccountId,
  requestId: Branded<'pe-request-id'>,
): void {
  if (expected.accountId !== authenticatedAccountId) throw new RequestBindingError(requestId)
}

/**
 * Compare the server-issued generation after acquiring the current account graph.
 * @param expected - The same client expectations used for the account comparison.
 * @param currentGeneration - Access-issued opaque value bound to the current AccountBinding.
 * @param requestId - Server-generated correlation identity.
 * @throws RequestBindingError on mismatch; success still requires AccountUse.assertCurrent before dispatch.
 */
export function assertExpectedGeneration(
  expected: RequestExpectation,
  currentGeneration: Branded<'pe-connection-generation'>,
  requestId: Branded<'pe-request-id'>,
): void {
  if (expected.connectionGeneration !== currentGeneration) throw new RequestBindingError(requestId)
}

function singleValue(values: readonly string[], requestId: Branded<'pe-request-id'>): string {
  const value = values[0]
  if (values.length !== 1 || value === undefined || value === '' || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RequestBindingError(requestId)
  }
  return value
}
