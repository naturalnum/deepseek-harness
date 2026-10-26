/** Root-only lifecycle inputs; neither durable JSON nor a path grants mount or backend authority. */
import type { AllocationCreateIntent } from './allocation-types.ts'
import type { PreparedSandbox } from './allocation-owner.ts'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SkillProjectGrant } from './skill-files-types.ts'

/** Original grant plus Root-verified daemon exports, retained under the original files/share reservation. */
export interface VerifiedExecutionMount {
  readonly grant: ExecutionMountGrant
  readonly exports: Readonly<{ project: string; protectedProject: string; environment: string; skills?: string }>
  /** Original retained files parent; absent allocations keep the entire metadata tree read-only. */
  readonly skills?: Readonly<{ grant: SkillProjectGrant; maxCopies: number }>
  /** Recheck original grant identity, native membership, exact exports, quotas and their retained share. */
  assertCurrent(): void
}

/** Deployment inputs resolved once by Root; no defaults, user environment, arbitrary extensions or URL selection. */
export interface SdkLifecycleConfig {
  readonly lifecycleBaseUrl: string
  readonly apiKey: string
  readonly deploymentIdentity: string
  readonly environmentVersion: string
  readonly provider: string
  readonly imageDigest: string
  readonly payloadSha256: string
  readonly entrypoint: readonly string[]
  readonly platform: 'amd64' | 'arm64'
  readonly cpuCores: number
  readonly memoryMiB: number
  readonly ttlSeconds: number
  readonly requestTimeoutMs: number
  readonly stopBudgetMs: number
  readonly readyPollIntervalMs: number
  readonly maxReadyPolls: number
  readonly pageSize: number
  readonly maxPages: number
  readonly maxItems: number
  readonly maxRecords: number
  readonly maxInflightOperations: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxOperationBytes: number
  readonly maxFieldBytes: number
}

/** Root's authenticated client must bind the exact sandbox, original mount and fixed expected payload. */
export interface AgentSelection {
  readonly intent: AllocationCreateIntent
  readonly sandboxId: string
  readonly mount: VerifiedExecutionMount
  readonly payloadSha256: string
  readonly imageDigest: string
  readonly deploymentIdentity: string
}

/** Identity proof validated by Root's authenticated agent client, never by an account JSON claim. */
export interface AgentHandshake extends PreparedSandbox {
  readonly payloadSha256: string
  readonly imageDigest: string
  readonly deploymentIdentity: string
}

/** Root-held synchronous admission fence and separately owned actual local settlement; never JSON. */
export interface FencedAgentRequests {
  readonly sandboxId: string
  readonly deploymentIdentity: string
  /** Actual fixed Root bootstrap/upload/publisher and all possible late privileged sends, after their admission closes. */
  readonly whenPrivilegedStartsJoined: Promise<void>
  readonly whenJoined: Promise<void>
  /** Root-held fixed selected-server lease/policy assertion, never a deserialized agent or account JSON claim. */
  assertDeploymentCurrent(): void
}

/** Root injects its private client; promises retain real work even when the supplied control signal aborts. */
export interface TrustedAgentLifecycle {
  /** Signal bounds actual work; rejection retains late local requests for the original fence capability. */
  handshake(this: void, selection: AgentSelection, signal: AbortSignal): Promise<AgentHandshake>
  /** Synchronously fence every new user/bootstrap submission and return without awaiting local release.
   * Already admitted requests must be confined to this original physical and unable to create/replace resources.
   * whenJoined owns actual local callbacks/transport settlement; pending/failure never means clean or returned budget.
   * An absent handshake stays absent; this capability neither waits for remote range empty nor invents runtime.
   */
  fenceRequests(this: void, selection: AgentSelection, prepared: AgentHandshake | undefined, signal: AbortSignal): FencedAgentRequests
  /** Only backend calls this after the original selected authenticated204 fully settles and the lease remains current.
   * Synchronously resolve the original range latches with physical-stop evidence; never fake direct-child exit/status.
   * Must be finite, nonthrowing and return no promise. An absent handshake stays absent; no new range is fabricated.
   */
  acknowledgePhysicalStop(this: void, selection: AgentSelection, prepared: AgentHandshake | undefined): undefined
}

/** Actual finite HTTP transport; close fulfills only after its owned dispatcher and all transport work close. */
export interface OwnedSdkTransport {
  readonly fetch: typeof globalThis.fetch
  close(): Promise<void>
}

/** Discovery is an observation, including a complete empty scan; it never authorizes create, stop or release. */
export interface OriginalResourceObservation {
  readonly kind: 'unknown'
  readonly pages: number
  readonly candidates: readonly Readonly<{ sandboxId: string; state: string }>[]
  readonly scanComplete: boolean
}

/** Failure keeps Root's original allocation and any remote effects retained; caller must not replay mutations. */
export class SdkLifecycleFailure extends Error {
  /** @param code Stable handling classification. @param cause Original private failure; never expose recursively to accounts. */
  constructor(readonly code: 'sdk/closed' | 'sdk/bounds' | 'sdk/capacity' | 'sdk/selection'
    | 'sdk/create-unknown' | 'sdk/ready-unconfirmed' | 'sdk/stop-unknown' | 'sdk/close-unconfirmed', cause?: unknown) {
    super(`OpenSandbox lifecycle ${code}; Root retains the original responsibility.`, { cause })
    this.name = 'SdkLifecycleFailure'
  }
}
