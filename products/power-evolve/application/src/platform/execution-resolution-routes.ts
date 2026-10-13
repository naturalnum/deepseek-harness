/** Explicit provider dispatch preserves read-only Agent access and independent trusted confirmation. */
import {
  EXECUTION_RESOLUTION_ROUTES, EXECUTION_RESOLUTION_APPROVAL_ROUTES,
  executionResolutionsListRequest, executionResolutionInspectRequest,
  executionResolutionStatusRequest, executionResolutionRequest,
} from '@power-evolve/contracts/execution-resolution'
import { PlatformError, type Identity } from '../contracts.ts'
import type { ExecutionService } from './executions.ts'

type ResolutionService = Pick<ExecutionService, 'listResolutions' | 'inspectResolution' | 'resolutionStatus' | 'resolveUncertain'>

/**
 * Dispatch owner reads after the Platform authenticates the caller.
 * @param service Configured Cloud provider; absence disables Cloud reconciliation.
 * @param path Frozen read-only Platform route.
 * @param user Independently authenticated owner.
 * @param input Bounded JSON; no user-supplied owner or stopped-writer assertion is accepted.
 * @param devices Device provider; omitted only by Cloud-only consumers.
 * @returns Existing execution facts or a durable receipt.
 */
export async function routeExecutionResolutionRead(service: ResolutionService | null, path: string,
  user: Identity, input: unknown): Promise<unknown> {
  switch (path) {
    case EXECUTION_RESOLUTION_ROUTES.executionResolutionsList: {
      const request = executionResolutionsListRequest.parse(input)
      const cloud = service ? await service.listResolutions(user, request) : { available: false, items: [] }
      return cloud
    }
    case EXECUTION_RESOLUTION_ROUTES.executionResolutionInspect: {
      const request = executionResolutionInspectRequest.parse(input)

      if (!service) throw new PlatformError(503, 'sandbox_unavailable')
      return service.inspectResolution(user, request.executionId)
    }
    case EXECUTION_RESOLUTION_ROUTES.executionResolutionStatus: {
      const request = executionResolutionStatusRequest.parse(input)

      if (!service) throw new PlatformError(503, 'sandbox_unavailable')
      return service.resolutionStatus(user, request.requestId)
    }
    default: throw new PlatformError(404, 'not_found')
  }
}

/**
 * Require the exact trusted Origin for independently authenticated approval operations.
 * @param service Configured Cloud provider.
 * @param path Frozen approval route; it never appears in the Host RPC map.
 * @param user Approval-audience owner authenticated by the Platform.
 * @param input Bounded request JSON.
 * @param approvalToken Independent bearer, rechecked under the account lock during confirmation.
 * @param origin Actual browser Origin; missing values are refused.
 * @param platformOrigin Exact configured trusted Origin.
 * @param devices Device provider; receives only explicitly selected desktop requests.
 * @returns Read-only facts or a durably accepted stop-and-reconcile receipt.
 */
export async function routeExecutionResolutionApproval(service: ResolutionService | null, path: string,
  user: Identity, input: unknown, approvalToken: string, origin: string | undefined,
  platformOrigin: string): Promise<unknown> {
  if (origin !== platformOrigin) throw new PlatformError(403, 'invalid_origin')
  switch (path) {
    case EXECUTION_RESOLUTION_APPROVAL_ROUTES.list:
      return routeExecutionResolutionRead(service, EXECUTION_RESOLUTION_ROUTES.executionResolutionsList, user, input)
    case EXECUTION_RESOLUTION_APPROVAL_ROUTES.inspect:
      return routeExecutionResolutionRead(service, EXECUTION_RESOLUTION_ROUTES.executionResolutionInspect, user, input)
    case EXECUTION_RESOLUTION_APPROVAL_ROUTES.status:
      return routeExecutionResolutionRead(service, EXECUTION_RESOLUTION_ROUTES.executionResolutionStatus, user, input)
    case EXECUTION_RESOLUTION_APPROVAL_ROUTES.resolve: {
      const request = executionResolutionRequest.parse(input)

      if (!service) throw new PlatformError(503, 'sandbox_unavailable')
      return service.resolveUncertain(user, request, approvalToken)
    }
    default: throw new PlatformError(404, 'not_found')
  }
}
