/** Execution capabilities and registered service identities; declarations grant no authority. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AllocationScope } from './allocation-types.ts'

/** Identifier of a development service retained by the original execution owner. */
export type DevelopmentServiceId = Branded<'pe-development-service-id'>

/** Serialized identity projection; access requires the original registered execution capability. */
export interface ServicePreviewIdentity extends Pick<AllocationScope, 'accountId' | 'epoch' | 'sessionId' | 'allocationId'> {
  readonly serviceId: DevelopmentServiceId
}

/** Task selection within the already admitted account; the original service row supplies its allocation identity. */
export type ApplicationServiceSelection = Pick<ServicePreviewIdentity, 'sessionId' | 'serviceId'>

/** Application request without platform credentials, destination URLs or caller-selected ports. */
export interface ApplicationReadRequest {
  readonly method: 'GET' | 'HEAD'
  readonly resourcePath: string
  readonly headers: readonly (readonly [string, string])[]
}

/** Finite response budgets reserved by the original request and registered-service owners. */
export interface ApplicationReadLimits {
  readonly maxBodyBytes: number
  readonly maxChunkBytes: number
  readonly maxChunks: number
  readonly maxHeaderCount: number
  readonly maxHeaderBytes: number
}

/** Original transport retains response reads, cancellation and actual release. */
export interface ApplicationReadResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  /**
   * Transport prefetch and allocation remain inside the approved owner budget; encoding is not decompressed.
   * @param maximum Maximum entity bytes returned after HTTP framing for this pull.
   * @returns A bounded nonempty chunk, or null at EOF.
   */
  read(maximum: number): Promise<Uint8Array | null>
  /**
   * Join actual pending reads, cancellation and transport release; failure retains original unknown responsibility.
   * @param reason Request cancellation when present; omission releases normally after consumption.
   * @returns The same idempotent actual close, independently of any caller observation deadline.
   */
  close(reason?: unknown): Promise<void>
}

/** Original registered-service capability; serialized identity alone cannot create or borrow it. */
export interface RegisteredApplicationService {
  readonly scope: ServicePreviewIdentity
  readonly port: number
  readonly lifetime: AbortSignal
  /** @returns After the original execution owner checks registration, binding, allocation and permanent admission. */
  assertCurrent(): void
  /**
   * Keep the original service/request reservation through actual consumption; no retry or redirect is allowed.
   * Late acquisition after cancellation still closes its actual response. Platform credentials never reach the application.
   * @param request Sanitized read for this capability's fixed application target.
   * @param limits Approved budgets reserved before transport allocation.
   * @param signal Original request and service cancellation observer.
   * @param consume Consumer that joins actual response close before returning.
   * @returns Actual acquisition, consumer and transport settlement; rejected cleanup remains owned and unknown.
   */
  withResponse(request: ApplicationReadRequest, limits: ApplicationReadLimits, signal: AbortSignal,
    consume: (response: ApplicationReadResponse) => Promise<void>): Promise<void>
}

/** Execution modes reviewed separately under C-08; declarations do not authorize execution. */
export type ExecutionCapability = 'argv-collect' | 'pipes' | 'control' | 'inherit' | 'terminal'

/** Requested deployment capabilities; an empty list alone cannot establish readiness. */
export interface ExecutionRequirements {
  /** Fixed provider selection; a declaration never replaces the original Root-issued capability. */
  readonly mode?: 'closed' | 'session-collect'
  readonly requiredCapabilities: readonly ExecutionCapability[]
}

/** Static evidence gaps which prevent enabling unverified execution. */
export type ExecutionPrerequisite =
  | 'runtime-participant-registration'
  | 'allocation-store-and-reconciliation'
  | 'account-execution-port'
  | 'session-project-authorization'
  | 'verified-execution-channel'
  | 'managed-range-stop-proof'
  | 'resource-isolation'

/** Local assessment only; no declared mode is accepted without target evidence. */
export interface ExecutionAvailability {
  readonly availableCapabilities: readonly ExecutionCapability[]
  readonly missingCapabilities: readonly ExecutionCapability[]
  readonly missingPrerequisites: readonly ExecutionPrerequisite[]
}
