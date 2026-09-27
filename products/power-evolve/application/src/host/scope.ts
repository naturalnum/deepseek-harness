/** Host access to platform APIs and operation-local execution grants. */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { grant, type Grant, PlatformError } from '../contracts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { powerEvolveRuntime: RuntimeScope }
}

/** Deployment-owned platform endpoint, worker identity, and transport bounds. */
export const Config = schema.object({
  platformUrl: schema.string().required(), workerTokenFile: schema.string().required(),
  timeoutMs: schema.number().min(1000).required(), maxResponseBytes: schema.number().min(1024).required(),
})
export type Config = ReturnType<typeof Config>

/** A shared host keeps grants by Session; it never has a mutable current user. */
export default class RuntimeScope extends Service {
  static Config = Config
  readonly workerId = randomUUID()
  readonly grants = new Map<SessionId, Grant>()
  private workerToken = ''

  constructor(ctx: Context, readonly config: Config) { super(ctx, 'powerEvolveRuntime') }

  async [Service.init](): Promise<void> { this.workerToken = (await readFile(this.config.workerTokenFile, 'utf8')).trim() }

  /** Claim at most one eligible operation selected by the trusted platform.
   * @returns a scoped grant or null when no work is available.
   */
  async claim(): Promise<Grant | null> {
    return grant.nullable().parse(await this.call('/runtime/claim', this.workerToken, { workerId: this.workerId }))
  }

  /** Require a live grant before accessing one Session's resources.
   * @param id - the native Session identity.
   * @returns its active operation grant.
   */
  require(id: SessionId): Grant {
    const value = this.grants.get(id)
    if (!value) throw new PlatformError(403, 'session_not_leased')
    return value
  }

  /** Call one configured platform endpoint with an explicit credential.
   * @param path - product-owned endpoint path.
   * @param token - user or operation bearer credential.
   * @param input - JSON request fields.
   * @returns bounded decoded JSON, validated by its consumer.
   */
  async call(path: string, token: string, input: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.platformUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    if (!response.body) throw new PlatformError(502, 'platform_empty_response')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > this.config.maxResponseBytes) throw new PlatformError(502, 'platform_response_limit')
      chunks.push(chunk)
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(data)
      throw new PlatformError(response.status, error.success ? error.data.error : 'platform_error')
    }
    return data
  }
}
