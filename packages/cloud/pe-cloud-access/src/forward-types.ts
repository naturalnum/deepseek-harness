/** Private transport contracts; no authentication, account or network-identity capability. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Finite target, request, carrier, buffering, and observation limits for one transport. */
export interface ForwardLimits {
  readonly maxTargets: number
  readonly maxTargetBytes: number
  /** Required with TLS identity: total copied CA/cert/key/pin/service-name input bytes across all targets. */
  readonly maxTlsIdentityBytes?: number
  readonly maxPathBytes: number
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly maxConnections: number
  /** At most 0x3fff_fffe; the incoming Server must capture maxHeaderPairs + 1 before accepting connections. */
  readonly maxHeaderPairs: number
  readonly maxHeaderBytes: number
  readonly maxHeadBytes: number
  readonly maxChunkBytes: number
  readonly maxBufferedBytes: number
  readonly maxPendingBytes: number
  /** Maximum combined HTTP request and response body bytes for one transfer. */
  readonly maxBodyBytes: number
  readonly maxTunnelBytes: number
  readonly queueTimeoutMs: number
  readonly connectTimeoutMs: number
  readonly operationTimeoutMs: number
  readonly closeTimeoutMs: number
}

declare const targetBrand: unique symbol
/** Opaque destination handle issued by one OwnerForwarder; lookup alone does not authenticate a connection. */
export interface ForwardTarget { readonly id: string; readonly [targetBrand]: true }
/** Root preloads bounded PEM bytes; the transport never reads files or environment variables. */
export interface ForwardTlsIdentity {
  readonly ca: Uint8Array
  readonly cert: Uint8Array
  readonly key: Uint8Array
  /** Exact leaf certificate SHA-256, 64 hexadecimal characters (not an SPKI hash). */
  readonly serverCertificateSha256: string
  /** Optional fixed DNS service name for SNI and hostname verification, independent of public Host. */
  readonly servername?: string
}
/** Root-fixed endpoint and optional preloaded TLS identity for a destination. */
export interface ForwardTargetConfig { readonly id: string; readonly origin: string; readonly tlsIdentity?: ForwardTlsIdentity }
/** Original caller lifetime and admission check retained for one transfer. */
export interface ForwardLifetime {
  readonly signal: AbortSignal
  readonly assertCurrent: (this: void) => void
}
/** Original HTTP or upgrade carrier bound to its approved target and caller lifetime. */
export type ForwardInput = Readonly<{
  target: ForwardTarget
  request: IncomingMessage
  lifetime: ForwardLifetime
  /** Root-created extra raw pairs, never copied from an incoming marker; no original name may be replaced. */
  trustedRequestHeaders?: readonly string[]
}> & (Readonly<{ kind: 'http'; response: ServerResponse }>
  | Readonly<{ kind: 'upgrade'; socket: Duplex; head: Buffer; onUpgradeAccepted?: (this: void) => void }>)

/** Local transport failure classifications, independent of remote business outcome. */
export type ForwardFailureCode = 'closed' | 'capacity' | 'protocol' | 'cancelled' | 'timeout' | 'io' | 'identity'
/** Categorized transport refusal or failure that does not establish whether upstream business ran. */
export class ForwardFailure extends Error {
  constructor(readonly code: ForwardFailureCode, cause?: unknown) {
    super('Owner transport did not complete.', { cause })
  }
}
/** Actual local-resource settlement with the retained warning that upstream may have received data. */
export interface ForwardTerminal {
  readonly status: 'completed' | 'failed'
  readonly failure?: ForwardFailure
  readonly upstreamMayHaveReceived: boolean
  readonly upstreamStatus?: number
}
/** First transfer observation; a close-deadline unknown retains work until actual settlement. */
export type ForwardObservation = ForwardTerminal | Readonly<{
  status: 'unknown'
  reason: 'close-deadline'
  upstreamMayHaveReceived: boolean
}>
/** Accepted transfer with separate observation and actual-settlement promises; cancellation grants no replay authority. */
export interface ForwardTransfer {
  readonly result: Promise<ForwardObservation>
  readonly settled: Promise<ForwardTerminal>
  cancel(): void
}
/** Synchronous counts of active, queued, retained work and its reserved capacity. */
export interface ForwardSnapshot {
  readonly closing: boolean
  readonly active: number
  readonly queued: number
  readonly retained: number
  readonly reservedConnections: number
  readonly reservedBytes: number
}
/** First bounded close observation; unknown does not establish actual resource closure. */
export type ForwardCloseObservation = Readonly<{ status: 'confirmed' | 'unknown' }>
