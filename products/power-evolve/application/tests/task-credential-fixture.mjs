/** Explicit Agent credentials for legacy TaskStore fixtures; no production authorization fallback. */
import { IdentityService, hashPassword } from '../lib/platform/identity.js'
import { TaskStore } from '../lib/platform/tasks.js'
import { McpActionStore } from '../lib/platform/mcp-actions.js'
import { SshExecuteService } from '../lib/platform/ssh-execute.js'
import { ConnectorService } from '../lib/platform/connectors.js'
import { DeviceService } from '../lib/platform/devices.js'
import { SshCallStore } from '../lib/platform/ssh-calls.js'
import { SshAuthenticationCheck } from '../lib/platform/ssh-check.js'
import { lockAccountAuthorities } from '../lib/platform/account-authority.js'
import { revokeAccountExecutions } from '../lib/platform/account-execution-revocation.js'
import { transaction } from '../lib/platform/database.js'

const fixturePassword = 'synthetic-task-fixture-password'
const fixtureHash = hashPassword(fixturePassword)
const credentials = new WeakMap()

/** Issue through real password login; only legacy non-password placeholders are replaced. */
export async function taskCredential(pool, user, audience = 'agent') {
  let byUser = credentials.get(pool)
  if (!byUser) { byUser = new Map(); credentials.set(pool, byUser) }
  const cacheKey = `${user.userId}:${audience}`
  if (!byUser.has(cacheKey)) byUser.set(cacheKey, (async () => {
    const username = await transaction(pool, async client => {
      await lockAccountAuthorities(client, [user.userId], 'update')
      const row = (await client.query('SELECT password_hash,username FROM pe_users WHERE id=$1',
        [user.userId])).rows[0]
      if (!row) throw new Error('Task fixture user is missing')
      if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/u.test(row.password_hash)) {
        await client.query('UPDATE pe_users SET password_hash=$2 WHERE id=$1', [user.userId, await fixtureHash])
      }
      return row.username
    })
    return (await new IdentityService(pool, 3600000).login(username, fixturePassword, audience)).token
  })())
  return byUser.get(cacheKey)
}

/** Keep existing fixture arguments while always forwarding a real, explicit bearer to production methods. */
export class TaskFixtureStore extends TaskStore {
  fixtureCredentials = new Map()
  setCredential(user, token) { this.fixtureCredentials.set(user.userId, token) }
  credential(user) { return this.fixtureCredentials.get(user.userId) ?? taskCredential(this.pool, user) }
  async create(user, requestId, workspaceId) {
    return super.create(user, requestId, await this.credential(user), workspaceId)
  }
  async accept(user, sessionId, requestId, text, target) {
    return super.accept(user, sessionId, requestId, text, await this.credential(user), target)
  }
  async cancel(user, sessionId) {
    return super.cancel(user, sessionId, await this.credential(user))
  }
}

/** Forget synthetic credentials after explicit account rotation in a regression. */
export function clearTaskCredential(pool, user) {
  const byUser = credentials.get(pool)
  for (const audience of ['agent', 'approval']) byUser?.delete(`${user.userId}:${audience}`)
}

/** Forward real approval credentials while keeping existing fixture calls concise. */
export class McpActionFixtureStore extends McpActionStore {
  async decide(owner, id, fingerprint, decision, credentialToken) {
    return super.decide(owner, id, fingerprint, decision, credentialToken === undefined ? await taskCredential(this.pool, owner, 'approval') : credentialToken)
  }
}
/** Forward the independently issued approval audience. */
export class SshExecuteFixtureService extends SshExecuteService {
  async decide(user, id, fingerprint, approve, credentialToken) {
    return super.decide(user, id, fingerprint, approve, credentialToken === undefined ? await taskCredential(this.tasks.pool, user, 'approval') : credentialToken)
  }
}
/** Forward the independently issued approval audience. */
export class ConnectorFixtureService extends ConnectorService {
  async decide(user, id, fingerprint, approve, credentialToken) {
    return super.decide(user, id, fingerprint, approve, credentialToken === undefined ? await taskCredential(this.pool, user, 'approval') : credentialToken)
  }
}
/** Pair with a current browser credential. */
export class DeviceFixtureService extends DeviceService {
  async pair(user, credentialToken) { return super.pair(user, credentialToken === undefined ? await taskCredential(this.pool, user) : credentialToken) }
}
/** Admit with a current browser credential. */
export class SshCallFixtureStore extends SshCallStore {
  async admit(user, input, credentialToken) { return super.admit(user, input, credentialToken === undefined ? await taskCredential(this.pool, user) : credentialToken) }
}
/** Submit with a current browser credential. */
export class SshAuthenticationFixtureCheck extends SshAuthenticationCheck {
  async submit(user, input, credentialToken) { return super.submit(user, input, credentialToken === undefined ? await taskCredential(this.calls.pool, user) : credentialToken) }
}

/** Disable a fixture account and revoke all previous browser and execution authority atomically. */
export async function disableFixtureAccount(pool, user) {
  const result = await transaction(pool, async client => {
    await lockAccountAuthorities(client, [user.userId], 'update')
    await client.query('UPDATE pe_users SET enabled=false,account_revision=account_revision+1,credential_version=credential_version+1 WHERE id=$1', [user.userId])
    await client.query('DELETE FROM pe_credentials WHERE user_id=$1', [user.userId])
    return revokeAccountExecutions(client, user.userId)
  })
  clearTaskCredential(pool, user)
  return result
}
/** Enable only future fixture work; the prior executions and grants remain revoked. */
export async function enableFixtureAccount(pool, user) {
  await transaction(pool, async client => {
    await lockAccountAuthorities(client, [user.userId], 'update')
    await client.query('UPDATE pe_users SET enabled=true,account_revision=account_revision+1 WHERE id=$1', [user.userId])
  })
  clearTaskCredential(pool, user)
}
