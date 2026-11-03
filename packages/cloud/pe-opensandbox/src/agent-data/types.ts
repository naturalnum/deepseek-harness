/**
 * Type-only data-carrier API;
 * runtime pins and errors live in dedicated modules.
 */
import type { SkillParent, SkillWorld } from './skill-world.ts'
import type { NativeFilePolicy } from './file-policy.ts'
import type { ROLE_PROTOCOL as PROTOCOL, ROLE_LIMITS as SLICE_LIMITS } from './role-protocol.ts'
import type { Duplex, Readable, Writable } from 'node:stream'

/**
 * Fixed HTTP routes of the frozen agent protocol;
 * callers cannot supply arbitrary endpoints.
 */
export type Route = '/handshake' | '/prepare' | '/commit' | '/cancel' | '/poll' | '/stop' | '/seal' | '/stream'
/** Routes with remote mutation intent, each locally attempted at most once per reference or client seal. */
export type Mutation = Exclude<Route, '/handshake' | '/poll' | '/stream'>
/**
 * Root-authorized uint64 quantities as canonical decimal strings;
 * only device permits zero.
 */
export interface RootGrant {
  readonly device: string
  readonly inode: string
  readonly maximumBytes: string
  readonly maximumInodes: string
}
/**
 * Original Root-selected sandbox/runtime, source/world pins and independent mount grants;
 * responses cannot rebind it.
 */
export interface ExpectedBinding {
  readonly skillParent?: SkillParent
  readonly physicalSandboxId: string
  readonly runtimeIdentity: string
  readonly projectRoot: string
  readonly roots: {
    readonly project: RootGrant
    readonly environment: RootGrant
  }
  readonly pins: {
    readonly bwrapSha256: string
    readonly agentSourceSha256: string
    readonly userWorldArgvSha256: string
  }
  /**
   * Compared as a Root declaration only;
   * never actual image attestation.
   */
  readonly declaredImageId: string
}
/**
 * Protected Root startup inputs for one fixed private endpoint;
 * the token must never enter logs or user data.
 */
export interface ClientOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  readonly expected: ExpectedBinding
}
/**
 * An earlier monotonic deadline or observer cancellation;
 * neither proves remote scope completion.
 */
export interface CallOptions {
  /** performance.now() coordinate, capped by slice/request lifetime. */
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}
/** Literal absolute argv, project-contained canonical cwd and finite stdin ignore/batch input only. */
export interface CollectOperationSpec {
  readonly executionKind?: never
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdin: { readonly mode: 'ignore' } | { readonly mode: 'batch'; readonly base64: string }
}
/** Signed pipes dispositions; fd7 is a separate duplex stream, never management authority. */
export interface PipesOperationSpec {
  readonly executionKind: 'pipes'
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdin: CollectOperationSpec['stdin'] | { readonly mode: 'pipe' }
  readonly env: Readonly<Record<string, string | null>>
  readonly stream: {
    readonly terminal?: Readonly<{ rows: number; cols: number }>
    readonly version: 'pe-execution-stream-v1'
    readonly stdout: 'pipe' | 'ignore'
    readonly stderr: 'pipe' | 'ignore'
    readonly control: 'pipe' | 'ignore'
    readonly limits: { readonly controlInputBytes: number; readonly controlOutputBytes: number }
  }
}
/** Collect wire bytes stay unchanged; only signed pipes adds environment and streaming fields. */
export type OperationSpec = CollectOperationSpec | PipesOperationSpec
/** Raw local Node streams of one irreversible original attach, not an operation or allocation owner. */
export interface AgentDataStream {
  readonly stdin?: Writable
  readonly stdout?: Readable
  readonly stderr?: Readable
  readonly control?: Duplex
  /** All requested raw output EOF frames decoded, independent of consumer reads; early disconnect rejects. */
  readonly outputEnded: Promise<void>
  /** Actual socket terminal-event join, including after error; it never means the remote range is empty. */
  readonly settled: Promise<void>
  /** Request closure once without replay; pending input becomes uncertain and the original row remains retained. */
  close(): void
}
/** Fixed protocol declaration compared before pipes attachment is admitted. */
export interface StreamLimits {
  readonly version: 'pe-execution-stream-v1'
  readonly frameBytes: 4096
  readonly windowBytes: 8192
  readonly controlInputBytes: 8388608
  readonly controlOutputBytes: 8388608
  readonly stdinBytes: 4096
}
/**
 * Original runtime and operationId/specHash pair retained across uncertainty;
 * no replacement or replay authority.
 */
export interface RangeAuthorization {
  readonly role: 'foreground' | 'service' | 'program'
  readonly registrationId: string | null
  readonly signature: string
}
/** Unissued original reference, retained before Root assigns a fixed role. */
export interface UnsignedOperationRef {
  readonly runtimeIdentity: string
  readonly operationId: string
  readonly specHash: string
}
/** Original reference and Root's exact role authorization; later calls cannot relabel it. */
export interface OperationRef extends UnsignedOperationRef {
  readonly authorization: RangeAuthorization
}
/** Canonical spec awaiting the original Root fixed-role authorizer. */
export interface UnsignedPreparedRequest {
  readonly filePolicy?: NativeFilePolicy
  readonly skillWorld?: SkillWorld
  readonly ref: UnsignedOperationRef
  readonly spec: OperationSpec
}
/** Root-registered canonical spec and its original reference, supplied before any HTTP mutation. */
export interface PreparedRequest {
  readonly filePolicy?: NativeFilePolicy
  readonly skillWorld?: SkillWorld
  readonly ref: OperationRef
  readonly spec: OperationSpec
}
/** Complete bounded raw tail requested at byte offset zero, preserving full-stream coordinates, loss and EOF. */
export interface RawTail {
  readonly requestedOffset: 0
  readonly startOffset: number
  readonly endOffset: number
  readonly observedBytes: number
  readonly base64: string
  readonly bytes: Uint8Array
  readonly lossy: boolean
  readonly eof: boolean
}
/** Bounded agent-reported failure details, independent of direct process or range completion facts. */
export interface FailureFact {
  readonly type: string
  readonly errno: number | null
  readonly phase: string
}
/**
 * Authenticated facts for the original operation;
 * submitted, direct exit and full-range/IO completion are distinct.
 */
export interface OperationSnapshot {
  readonly operationId: string
  readonly specHash: string
  readonly role: RangeAuthorization['role']
  readonly registrationId: string | null
  readonly primitiveStarted: boolean
  readonly prepared: boolean
  readonly commitAttempted: boolean
  readonly commitClosed: boolean
  readonly submitted: boolean
  readonly firstCause: string | null
  readonly direct: { readonly waitStatus: number; readonly returncode: number } | null
  readonly directNotObserved: boolean
  readonly rangeEmpty: boolean
  readonly ioClosed: boolean
  readonly physicalStopRequired: boolean
  readonly failure: FailureFact | null
  readonly cleanupFailure: FailureFact | null
  readonly providerFailure: boolean
  readonly streams: {
    readonly stdout: RawTail
    readonly stderr: RawTail
  }
  readonly executionKind?: 'pipes'
  readonly stream?: {
    readonly attached: boolean
    readonly connected: boolean
    readonly ioClosed: boolean
    readonly controlInputBytes: number
    readonly controlOutputBytes: number
  }
}
/** Actual Root-bound identities and total capacities as lossless decimal strings, with the exact Root grant. */
export interface MountFact {
  readonly device: string
  readonly inode: string
  readonly uid: 2000
  readonly gid: 2000
  readonly capacityBytes: string
  readonly capacityInodes: string
  readonly grant: {
    readonly maximumBytes: string
    readonly maximumInodes: string
  }
}
/**
 * Validated frozen protocol, runtime, payload/world pins and mount facts;
 * declared image is not image attestation.
 */
export interface Handshake {
  readonly protocolVersion: typeof PROTOCOL
  readonly runtimeIdentity: string
  readonly capabilities: readonly ['argv', 'stdin-ignore', 'stdin-batch', 'collect']
    | readonly ['argv', 'stdin-ignore', 'stdin-batch', 'collect', 'stdin-pipe', 'pipes', 'control-pipe']
  readonly streamLimits?: StreamLimits
  readonly pins: ExpectedBinding['pins']
  readonly declaredImageId: string
  readonly mounts: Readonly<Record<string, MountFact>>
  readonly limits: typeof SLICE_LIMITS
  readonly newOperationsAccepted: boolean
  readonly recordCount: number
  readonly activeRangeCount: number
  readonly rangeRoles: Readonly<{ foreground: number; service: number; program?: number }>
  readonly sealed: boolean
  readonly sealReason: string | null
  readonly physicalStopRequired: boolean
}
/** Trusted Root backend processes-gone fact for the exact original sandbox/runtime, never produced by this client. */
export interface PhysicalStopAck {
  /** Trusted Root backend fact. This module cannot produce or attest it. */
  readonly physicalSandboxId: string
  readonly runtimeIdentity: string
  readonly stopAckId: string
  readonly processesGone: true
}
/**
 * Local transport settlement and tracked remote uncertainty;
 * no allocation deletion or global empty-scope proof.
 */
export interface Responsibility {
  readonly fenced: boolean
  readonly closing: boolean
  readonly inFlight: number
  readonly dispatcherClosed: boolean
  readonly localSettled: boolean
  readonly closeMethodsPending: number
  readonly cleanupFailure: boolean
  readonly attempts: number
  readonly sentBodyBytes: number
  readonly replyBodyAllowance: number
  /** Current logical reservation for at most four in-flight 16KiB reply buffers; never cumulative traffic. */
  readonly replyBuffersReservedBytes: number
  /** Encoded request bodies owned by current in-flight calls, excluding transport/internal copies. */
  readonly inFlightRequestBodyBytes: number
  /** Current accepted reply bytes copied into in-flight buffers; decreases only on actual settlement. */
  readonly bufferedReplyBytes: number
  /** Cumulative reply bytes accepted into buffers under the lifetime reply allowance; never recycled. */
  readonly receivedReplyBodyBytes: number
  readonly remoteUnresolved: readonly OperationRef[]
  readonly physicalStopAcknowledged: boolean
  readonly physicalStopRequired: boolean
}
/** Bounded transport and fact API for Root operation broker; it owns no allocation, Session or job lifecycle. */
export interface AgentDataClient {
  /**
   * Read and verify the original Root binding before opening prepare/commit admission.
   * @param options - Earlier monotonic deadline or observer cancellation.
   * @returns Validated facts without image-attestation or physical-cleanup authority.
   */
  handshake(options?: CallOptions): Promise<Handshake>
  /**
   * Attempt the original prepare once without committing or replaying input.
   * @param request - Root-registered reference and normalized spec.
   * @param options - Earlier deadline or observer cancellation.
   * @returns Pending/prepared facts; uncertainty retains the same reference.
   */
  prepare(request: PreparedRequest, options?: CallOptions): Promise<OperationSnapshot>
  /**
   * Attach once to an actually prepared pipes operation using private headers on the fixed endpoint.
   * @param ref Original Root-issued reference and authorization; no caller-selected URL or replacement operation.
   * @param options Earlier attach deadline and lifetime observer cancellation.
   * @returns Raw Node streams after the actual upgrade; commit remains a separate original operation.
   */
  attach(ref: OperationRef, options?: CallOptions): Promise<AgentDataStream>
  /**
   * Join any original attach connection, including an upgrade whose ready promise rejected before returning its stream.
   * @param ref Exact retained original reference; no network request, new authority or remote-empty fact is created.
   * @returns Actual local stream terminal/send join, or immediate completion if this row never attached.
   */
  joinStream(ref: OperationRef): Promise<void>
  /**
   * Attempt commit once after Root has observed prepared facts.
   * @param ref - Original operation reference retained throughout its lifetime.
   * @param options - Earlier deadline or observer cancellation.
   * @returns Independent submission, direct and range facts without replay.
   */
  commit(ref: OperationRef, options?: CallOptions): Promise<OperationSnapshot>
  /**
   * Attempt permanent remote cancellation once for the original reference.
   * @param ref - Original operation reference, including one whose prepare response was lost.
   * @param options - Earlier deadline or observer cancellation.
   * @returns Remote facts; cancellation acceptance is not range-empty proof.
   */
  cancel(ref: OperationRef, options?: CallOptions): Promise<OperationSnapshot>
  /**
   * Attempt remote scope stop once without substituting it for physical backend acknowledgement.
   * @param ref - Original operation reference.
   * @param options - Earlier deadline or observer cancellation.
   * @returns Stop and completion facts; an unknown response remains owned by Root.
   */
  stop(ref: OperationRef, options?: CallOptions): Promise<OperationSnapshot>
  /**
   * Read the original operation with both raw-tail offsets fixed at zero.
   * @param ref - Original operation reference to query, never a replacement ID.
   * @param options - Earlier deadline or observer cancellation.
   * @returns Non-consuming tails with original byte coordinates and independent lifecycle facts.
   */
  poll(ref: OperationRef, options?: CallOptions): Promise<OperationSnapshot>
  /**
   * Fence local submission synchronously and attempt remote seal once.
   * @param options - Earlier deadline or observer cancellation.
   * @returns Remote admission facts; local fence is never reopened by a later reply.
   */
  seal(options?: CallOptions): Promise<Handshake>
  /**
   * Close prepare/commit synchronously while keeping read/stop transport available.
   * @returns Actual-settlement barrier for HTTP requests at this fence; live streams remain owned for stop/release.
   */
  fence(): Promise<void>
  /**
   * Fence and abort observers, join actual requests and close/destroy the exclusively owned dispatcher.
   * @param options - Earlier monotonic deadline for the bounded responsibility report.
   * @returns Current local/remote responsibility, which may remain unsettled and never gates physical deletion.
   */
  release(options?: Pick<CallOptions, 'deadlineMs'>): Promise<Responsibility>
  /**
   * Wait for actual local joins after release, refusing closure-unknown cleanup.
   * @returns Completion only when local requests and dispatcher ownership have settled; no remote-empty proof.
   */
  whenLocallySettled(): Promise<void>
  /**
   * Read this client's finite tracked responsibilities without making a network request.
   * @returns Local settlement and original-reference uncertainty, never global allocation emptiness.
   */
  responsibility(): Responsibility
  /**
   * Apply only an actual original-sandbox processes-gone fact supplied by trusted Root backend.
   * @param ack - Independently obtained backend acknowledgement; the client cannot create or attest it.
   */
  notePhysicalStop(ack: PhysicalStopAck): void
}
