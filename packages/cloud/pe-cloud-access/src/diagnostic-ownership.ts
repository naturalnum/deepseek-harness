/** Root-private grants and immutable receipts from the actual Native Session producer. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Pool } from 'pg'
import type { AccountBinding, AccountId } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { AllocationDiagnosticsAuthority } from './allocation-diagnostics.ts'

const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const PREFIX_BYTES = 4096
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Root-owned management file. Replacing its contents atomically changes current grants. */
export interface DiagnosticGrantConfig {
  readonly grantPath: string
  readonly maxGrantBytes: number
}

interface Receipt {
  readonly path: string
  readonly identity: string
  readonly prefixBytes: number
  readonly hash: string
}

async function grants(config: DiagnosticGrantConfig, signal: AbortSignal): Promise<readonly (readonly string[])[]> {
  const uid = process.geteuid?.()
  for (let parent = posix.dirname(config.grantPath); ; parent = posix.dirname(parent)) {
    const stat = await lstat(parent)
    signal.throwIfAborted()
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return []
    if (parent === '/') break
  }
  const file = await open(config.grantPath, FILE_FLAGS)
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || (stat.uid !== 0n && (uid === undefined || stat.uid !== BigInt(uid)))
      || (stat.mode & 0o137n) !== 0n || stat.size < 2n || stat.size > BigInt(config.maxGrantBytes)) return []
    const buffer = Buffer.allocUnsafe(Number(stat.size) + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const live = await lstat(config.grantPath, { bigint: true })
    signal.throwIfAborted()
    if (bytesRead !== Number(stat.size) || live.dev !== stat.dev || live.ino !== stat.ino
      || live.ctimeNs !== stat.ctimeNs || live.size !== stat.size) return []
    const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 3
      || row.some(value => typeof value !== 'string' || !safeId.test(value)))) return []
    return rows
  } finally { await file.close() }
}

async function receipt(root: string, path: string, signal: AbortSignal, bytes?: number): Promise<Receipt | undefined> {
  const parts = path.split('/')
  if (parts.length !== 3 || parts.some(part => part === '' || part === '.' || part === '..' || /[\0\\]/.test(part))) return
  const selected = posix.join(root, path)
  if (await realpath(selected) !== selected) return
  const file = await open(selected, FILE_FLAGS)
  try {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.birthtimeNs <= 0n || stat.size < 1n) return
    const count = bytes ?? Number(stat.size < BigInt(PREFIX_BYTES) ? stat.size : BigInt(PREFIX_BYTES))
    if (!Number.isSafeInteger(count) || count < 1 || count > PREFIX_BYTES || stat.size < BigInt(count)) return
    const payload = Buffer.allocUnsafe(count)
    const { bytesRead } = await file.read(payload, 0, count, 0)
    const live = await lstat(selected, { bigint: true })
    signal.throwIfAborted()
    if (bytesRead !== count || live.dev !== stat.dev || live.ino !== stat.ino || live.birthtimeNs !== stat.birthtimeNs
      || live.nlink !== 1n || live.size < BigInt(count)) return
    return { path, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, prefixBytes: count,
      hash: createHash('sha256').update(payload).digest('hex') }
  } finally { await file.close() }
}

/** Root-private publication and cold authorization, using the original Access PG pool. */
export class DiagnosticOwnership implements AllocationDiagnosticsAuthority {
  constructor(private readonly pool: Pool, private readonly config: DiagnosticGrantConfig,
    private readonly sessionsRoot: (id: AccountId) => string) {}

  /** Verify the deployment-owned receipt schema before opening diagnostics. */
  async verifySchema(): Promise<void> {
    await this.pool.query('SELECT account_id,session_id,path,identity,prefix_bytes,hash FROM public.pe_diagnostic_session_birth LIMIT 0')
  }

  /** Persist the first durable producer identity. Replacement never issues another birth for the same pair.
   * @param binding Original admitted Native account generation.
   * @param sessionId Fresh Native Session id.
   * @param absolutePath Exact Native persistence artifact after the original flush.
   */
  async publish(binding: AccountBinding, sessionId: string, absolutePath: string): Promise<void> {
    binding.lifetime.throwIfAborted()
    const root = this.sessionsRoot(binding.accountId)
    const stored = await receipt(root, posix.relative(root, absolutePath), binding.lifetime)
    if (stored === undefined || this.sessionsRoot(binding.accountId) !== root) return
    await this.pool.query(`INSERT INTO public.pe_diagnostic_session_birth (account_id, session_id, path, identity, prefix_bytes, hash)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id, session_id) DO NOTHING`,
    [binding.accountId, sessionId, stored.path, stored.identity, stored.prefixBytes, stored.hash])
  }

  readonly allows: AllocationDiagnosticsAuthority['allows'] = async (actor, target, signal) => {
    try {
      const allowed = (await grants(this.config, signal)).some(([admin, account, session]) =>
        admin === actor.accountId && account === target.accountId && session === target.sessionId)
      if (!allowed) return false
      const { rows: [stored] } = await this.pool.query<Receipt>(`SELECT b.path,b.identity,b.prefix_bytes AS "prefixBytes",b.hash
        FROM public.pe_diagnostic_session_birth b JOIN public."user" u ON u.id=b.account_id
        WHERE b.account_id=$1 AND b.session_id=$2 AND NOT coalesce(u.banned,false)`, [target.accountId, target.sessionId])
      signal.throwIfAborted()
      if (stored === undefined) return false
      const account = target.accountId as AccountId
      const root = this.sessionsRoot(account)
      const current = await receipt(root, stored.path, signal, stored.prefixBytes)
      return current?.identity === stored.identity && current.hash === stored.hash && this.sessionsRoot(account) === root
    } catch (_unavailable) {
      return false
    }
  }
}
