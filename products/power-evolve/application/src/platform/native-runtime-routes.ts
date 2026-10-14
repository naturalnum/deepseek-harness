/** Tenant process admission never accepts the shared worker credential or a caller-selected owner. */
import { cleanupExpiredNativeDerivations } from './native-derived-cleanup.ts'
import type { EventLimits } from './events.ts'
import { z } from 'zod'
import { PlatformError } from '../contracts.ts'
import type { TaskStore } from './tasks.ts'
import type { NativeRetainedIntentStore } from './native-retained-intent-store.ts'
import type { NativeRuntimeAuthority } from './native-runtime-authority.ts'

/** Route runtime identity, owned claims and owned journal maintenance.
 * @param authority Current Platform-managed process credentials.
 * @param tasks Actual lease and operation provider.
 * @param intents Actual retained native journal.
 * @param path Bounded internal runtime route.
 * @param token Opaque runtime bearer.
 * @param maintenance Optional original history budgets and bounded expired-derivation cleanup.
 * @param raw JSON body; worker identity must equal the credential's process instance.
 * @returns Owned native reply; foreign operations and journal records remain inaccessible.
 */
export async function routeNativeRuntime(authority: NativeRuntimeAuthority, tasks: TaskStore,
  intents: NativeRetainedIntentStore, path: string, token: string, raw: unknown,
  maintenance?: { limits: EventLimits; maxSessions: number }): Promise<unknown> {
  const actor = await authority.authenticate(token)
  if (path === '/runtime/user/identity') {
    z.object({}).strict().parse(raw)
    const account = await tasks.pool.query<{ settings: unknown }>('SELECT settings FROM pe_users WHERE id=$1', [actor.userId])
    return { ...actor, settings: account.rows[0]?.settings }
  }
  const input = z.object({ workerId: z.uuid() }).loose().parse(raw)
  if (input.workerId !== actor.runtimeId) throw new PlatformError(401, 'runtime_identity_mismatch')
  const owner = { userId: actor.userId, authenticate: async (client: Parameters<NativeRuntimeAuthority['authenticateInTransaction']>[0]) => {
    await authority.authenticateInTransaction(client, token, { userId: actor.userId, runtimeId: actor.runtimeId }, 'update')
  } }
  if (maintenance && path === '/runtime/user/claim') await cleanupExpiredNativeDerivations(tasks, owner,
    maintenance.limits, maintenance.maxSessions)
  switch (path) {
    case '/runtime/user/claim': z.object({ workerId: z.uuid() }).strict().parse(raw); return tasks.claim(actor.runtimeId, owner)
    case '/runtime/user/claim-archive-stop': z.object({ workerId: z.uuid() }).strict().parse(raw); return tasks.claimArchiveStop(actor.runtimeId, owner)
    case '/runtime/user/native-intents/reconcile': return intents.reconcile(raw, actor.userId)
    case '/runtime/user/native-intents/resolve': return intents.resolve(raw, actor.userId)
    default: throw new PlatformError(404, 'not_found')
  }
}
