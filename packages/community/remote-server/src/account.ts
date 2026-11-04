/** Account-bound remote-server data; persistence and actual execution stay with their original cloud owners. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { decide, type ApprovalAsker } from './gate.ts'
import type { RemoteApprovalPolicy } from './policy.ts'
import { parseProbe } from './probe.ts'
import type { GateDecision, RemoteExecOutcome, ConnectivityResult, ServerFacts } from './types.ts'

/** Account-local persistent identifier, distinct from a mention capability. */
export type ServerId = Branded<'CloudRemoteServerId'>
/** Opaque reference valid only in one live account generation. */
export type ServerReference = Branded<'CloudRemoteServerReference'>

const field = z.string().min(1).max(255)
const serverInput = z.strictObject({
  alias: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
  host: field.regex(/^[a-zA-Z0-9:[\]][a-zA-Z0-9_.:\-[\]]*$/),
  user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/),
  port: z.number().int().min(1).max(65535),
  description: z.string().max(1024),
  tags: z.array(z.string().max(64)).max(16),
  alwaysAsk: z.boolean(),
})
/** Strict native domain record parser; excludes credentials and local identity paths. */
export const remoteServerRecord = serverInput.extend({ id: z.uuid() }).strict()

/** Browser-safe server configuration. Secret addresses and host paths are excluded. */
export interface RemoteServer extends z.infer<typeof serverInput> { readonly id: ServerId }
/** A fresh generation reference is disclosed only after current account admission. */
export interface RemoteTarget { readonly entry: RemoteServer; readonly reference: ServerReference }

/** Original owners supply these in process; never deserialize them from client JSON. */
export interface AccountRemotePorts {
  readonly maxServers: number
  readonly maxCommandBytes: number
  readonly policy: RemoteApprovalPolicy
  /** Original graph business admission, separate from immutable binding checks. */
  assertCurrent(): void
  /** Fixed account-private record; no account or path selector. */
  read(): readonly RemoteServer[]
  /** Original storage operation must retain actual write responsibility after observer cancellation. */
  write(rows: readonly RemoteServer[]): Promise<void>
  /** Original credential deletion and its actual settlement; no secret is returned to this owner. */
  deleteCredential(id: ServerId): Promise<void>
}

function denied(): never { throw new Error('cloud/remote-server-forbidden') }

/** A per-generation collection. It owns neither execution processes nor credential material. */
export class AccountRemoteServers {
  private readonly references = new Map<ServerReference, RemoteServer>()
  private readonly observations = new Map<ServerId, { connectivity: ConnectivityResult; facts?: ServerFacts }>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context, private readonly binding: AccountBinding, private readonly ports: AccountRemotePorts) {
    for (const n of [ports.maxServers, ports.maxCommandBytes]) if (!Number.isSafeInteger(n)
      || n < 1) throw new RangeError('Invalid remote-server bounds')
    this.installed()
    ctx.effect(() => () => { this.references.clear() }, 'remote-server: revoke account generation references')
  }

  /** Read only this current graph's fixed private server list.
   * @returns Detached server data and generation references. */
  list(): RemoteTarget[] {
    this.current()
    const rows = this.rows()
    const current = new Set(rows.map(entry => entry.id))
    for (const [ref, entry] of this.references) if (!current.has(entry.id)) this.references.delete(ref)
    return rows.map((entry) => {
      let reference = [...this.references].find(([, captured]) => JSON.stringify(captured) === JSON.stringify(entry))?.[0]
      if (reference === undefined) {
        this.revoke(entry.id)
        reference = brandString<ServerReference>(randomUUID())
        this.references.set(reference, structuredClone(entry))
      }
      return { entry: structuredClone(entry), reference }
    })
  }

  /** Read actual observed facts only, preserving unknown and collection timestamps.
   * @returns Current account records and any still-applicable SSH observations. */
  states(): Array<RemoteTarget & { connectivity?: ConnectivityResult; facts?: ServerFacts }> {
    return this.list().map(row => ({ ...row, ...this.observations.get(row.entry.id) }))
  }

  /** Publish one current reference's real SSH probe outcome.
   * @param reference Exact executed reference.
 * @param outcome Actual original SSH outcome. */
  observe(reference: string, outcome: RemoteExecOutcome): void {
    this.current()
    const target = this.references.get(brandString<ServerReference>(reference))
    if (target === undefined) denied()
    const checkedAt = new Date().toISOString()
    if (outcome.kind === 'completed' && outcome.exitCode === 0) {
      this.observations.set(target.id, { connectivity: { reachable: true, checkedAt }, facts: parseProbe(outcome.stdout.text, checkedAt) })
    } else this.observations.set(target.id, { connectivity: { reachable: false, checkedAt,
      failure: outcome.kind === 'connect-failed' ? outcome.failure : outcome.kind === 'timeout' ? 'timeout' : 'unknown' } })
  }

  /** Add validated account data.
   * @param input Untrusted form JSON.
   * @returns Persisted browser-safe configuration. */
  add(input: unknown): Promise<RemoteServer> {
    const value = serverInput.parse(input)
    return this.mutate(async () => {
      const rows = this.rows()
      if (rows.length >= this.ports.maxServers || rows.some(entry => entry.alias === value.alias)) denied()
      const entry: RemoteServer = { ...value, id: brandString<ServerId>(randomUUID()) }
      await this.ports.write([...rows, entry]); this.current()
      return structuredClone(entry)
    })
  }

  /** Import a validated batch in one durable write; no partial import on ordinary invalid input.
   * @param inputs Untrusted normalized uploaded host forms.
 * @returns Number actually added. */
  addMany(inputs: readonly unknown[]): Promise<number> {
    const values = z.array(serverInput).max(this.ports.maxServers).parse(inputs)
    return this.mutate(async () => {
      const rows = this.rows(), known = new Set(rows.map(row => row.alias))
      const additions = values.filter(value => !known.has(value.alias))
      if (rows.length + additions.length > this.ports.maxServers
        || new Set(additions.map(row => row.alias)).size !== additions.length) denied()
      if (additions.length) await this.ports.write([...rows, ...additions.map(value => ({ ...value,
        id: brandString<ServerId>(randomUUID()) }))])
      this.current(); return additions.length
    })
  }

  /** Edit only an existing account record.
   * @param id Untrusted id.
   * @param input Untrusted form JSON.
   * @returns Committed configuration. */
  update(id: string, input: unknown): Promise<RemoteServer> {
    const value = serverInput.parse(input)
    return this.mutate(async () => {
      const rows = this.rows(), before = rows.find(entry => entry.id === id)
      if (before === undefined || rows.some(entry => entry.id !== id && entry.alias === value.alias)) denied()
      const entry: RemoteServer = { ...value, id: before.id }
      // Revoke before submission: a failed/unknown write cannot preserve an approval for the previous target.
      this.revoke(before.id)
      await this.ports.write(rows.map(row => row.id === id ? entry : row)); this.current()
      return structuredClone(entry)
    })
  }

  /** Delete credentials before removing their only visible owner.
   * @param id Untrusted id from this account's list. */
  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      const rows = this.rows(), entry = rows.find(row => row.id === id)
      if (entry === undefined) denied()
      this.revoke(entry.id)
      await this.ports.deleteCredential(entry.id); this.current()
      await this.ports.write(rows.filter(row => row.id !== id)); this.current()
    })
  }

  /** Reorder exactly this account's complete list.
   * @param ids Untrusted unique account-local identifiers. */
  reorder(ids: readonly string[]): Promise<void> {
    return this.mutate(async () => {
      const rows = this.rows()
      if (ids.length !== rows.length || new Set(ids).size !== rows.length) denied()
      const ordered = ids.map((id) => { const entry = rows.find(row => row.id === id); if (entry === undefined) denied(); return entry })
      await this.ports.write(ordered); this.current()
    })
  }

  /** Gate one original tool call; no permission preset grants remote execution by itself.
   *
   * @param reference Opaque current account-generation reference selected by the user.
   *
   * @param command Untrusted model command.
   *
   * @param approval Original native request adapter for this exact tool call.
   *
   * @param signal Original tool lifetime.
   *
   * @param run Original execution owner callback, called only after the final current-target check.
   *
   * @returns Decision and actual execution result, absent for refusal.
   */
  async execute(reference: string, command: string, approval: ApprovalAsker | undefined, signal: AbortSignal,
    run: (entry: RemoteServer, signal: AbortSignal, assertCurrent: () => void) => Promise<RemoteExecOutcome>,
  ): Promise<{ decision: GateDecision; outcome?: RemoteExecOutcome }> {
    this.current(); signal.throwIfAborted()
    if (typeof command !== 'string' || command.length === 0 || command.includes('\0')
      || Buffer.byteLength(command) > this.ports.maxCommandBytes) denied()
    const captured = this.references.get(brandString<ServerReference>(reference))
    const assertTarget = (): RemoteServer => {
      this.current(); signal.throwIfAborted()
      if (captured === undefined || this.references.get(brandString<ServerReference>(reference)) !== captured) denied()
      const actual = this.rows().find(row => row.id === captured.id)
      if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(captured)) denied()
      return structuredClone(actual)
    }
    const target = assertTarget()
    const decision = await decide({ alias: target.alias, command, isRegistered: true, signal,
      config: { ...this.ports.policy, alwaysAsk: this.ports.policy.alwaysAsk || target.alwaysAsk },
      ...(approval === undefined ? {} : { approval }) })
    const actual = assertTarget()
    if (decision.kind === 'denied') return { decision }
    const outcome = await run(actual, signal, () => { assertTarget() })
    this.current()
    return { decision, outcome }
  }

  /** Revoke pending references before an account credential update.
   * @param id Original selected account-local id. */
  revokeCredential(id: ServerId): void { this.current(); this.revoke(id) }

  private installed(): void {
    this.ctx.fiber.assertActive()
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding
      || this.ctx.root.get('peAccount') !== this.binding) denied()
  }
  private current(): void { this.installed(); this.ports.assertCurrent() }
  private rows(): RemoteServer[] {
    this.current()
    const data = z.array(remoteServerRecord).max(this.ports.maxServers).parse(this.ports.read())
    if (new Set(data.map(entry => entry.id)).size !== data.length || new Set(data.map(entry => entry.alias)).size !== data.length) denied()
    return data.map(entry => ({ ...entry, id: brandString<ServerId>(entry.id) }))
  }
  private revoke(id: ServerId): void { this.observations.delete(id); for (const [ref,
    entry] of this.references) if (entry.id === id) this.references.delete(ref) }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    this.current()
    const operation = this.tail.then(() => { this.current(); return work() })
    this.tail = operation.then(() => {}, (_error: unknown) => { /* Original storage owner retains any unresolved write. */ })
    return operation
  }
}
