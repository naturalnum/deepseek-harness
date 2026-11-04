/**
 * Vocabulary shared by the registry, the SSH channel, the approval gate, the
 * model tools, and the management-page routes. Types only — no runtime code.
 * @module dsh-remote-server/types
 */

/**
 * Why a connection attempt failed, distinguishable enough to act on. `unknown`
 * covers a failure the SSH client reported in a form this plugin cannot classify.
 */
export type ConnectFailure = 'dns' | 'refused' | 'auth' | 'timeout' | 'unknown'

/** One actual connectivity observation. */
export interface ConnectivityResult {
  readonly reachable: boolean
  readonly checkedAt: string
  readonly failure?: ConnectFailure
}

/**
 * Basic facts about one server. Every field is independently nullable: a target
 * lacking the command or file behind one field yields null for it and keeps the rest.
 */
export interface ServerFacts {
  readonly hostname: string | null
  readonly os: string | null
  readonly kernel: string | null
  readonly arch: string | null
  readonly cpuModel: string | null
  readonly cpuCores: number | null
  readonly memTotalKb: number | null
  readonly memAvailableKb: number | null
  readonly diskTotalKb: number | null
  readonly diskAvailableKb: number | null
  readonly uptimeSeconds: number | null
  /** ISO-8601 instant this snapshot was collected. Callers use it to judge freshness. */
  readonly collectedAt: string
}

/**
 * Which path decided one execution request. `ruleset` and `classified-human`
 * both lead to an approval request; they stay distinct so the audit shows
 * whether the deterministic rules or the model raised the escalation.
 */
export type GatePath =
  | 'unregistered'
  | 'allowlist'
  | 'ruleset'
  | 'classified-auto'
  | 'classified-human'
  | 'always-ask'

/** The gate's answer for one command. */
export type GateDecision =
  /** Run it: the allowlist or classifier cleared it. */
  | { readonly kind: 'auto'; readonly path: GatePath; readonly reason: string }
  /** A human allowed this one call. */
  | { readonly kind: 'approved'; readonly path: GatePath; readonly reason: string }
  /** Refused — by a human, by a missing approval channel, or by an unknown alias. */
  | { readonly kind: 'denied'; readonly path: GatePath; readonly reason: string }

/** One captured stream, bounded. */
export interface BoundedOutput {
  /** The retained text — the tail when `truncated`. */
  readonly text: string
  /** True when bytes were dropped. */
  readonly truncated: boolean
  /** Bytes dropped; 0 when `truncated` is false. */
  readonly droppedBytes: number
}

/**
 * The result of one execution attempt. `completed` means the SSH client ran the
 * command and the remote shell exited — a nonzero `exitCode` is still `completed`.
 * `timeout` and `cancelled` state only that this side stopped waiting: the remote
 * process may still be running, which callers MUST surface rather than claim a kill.
 *
 * `ambiguous` is the honest admission `completed` used to overclaim: exit 255 with
 * nothing on stdout and stderr text this plugin does not recognize is exactly as
 * likely to be the SSH client failing for an unclassified reason (a typo in the
 * user's own `~/.ssh/config`, an algorithm-negotiation failure against a legacy
 * host — neither reachable through `classifyFailure`'s signature list, and neither
 * bounded by this plugin's own config validation) as it is a remote command's own
 * unadorned `exit 255`. Reporting it as `completed` asserts "the remote shell ran
 * and exited 255", a fact this plugin cannot verify.
 */
export type RemoteExecOutcome =
  | {
    readonly kind: 'completed'
    readonly exitCode: number
    readonly stdout: BoundedOutput
    readonly stderr: BoundedOutput
  }
  | {
    readonly kind: 'connect-failed'
    readonly failure: ConnectFailure
    readonly detail: string
  }
  | {
    readonly kind: 'timeout'
    readonly timeoutMs: number
    readonly stdout: BoundedOutput
    readonly stderr: BoundedOutput
  }
  | {
    readonly kind: 'cancelled'
    readonly stdout: BoundedOutput
    readonly stderr: BoundedOutput
  }
  | {
    readonly kind: 'ambiguous'
    /** Always 255 — the entry condition into this branch, not a measurement. */
    readonly exitCode: 255
    /** The SSH client's own message, redacted; the only informative content available. */
    readonly detail: string
  }
