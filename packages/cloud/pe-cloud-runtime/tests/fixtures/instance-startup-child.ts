/** Test-only real Node startup and PostgreSQL registration; no application entry or account graph. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { PgOwnerExecutor } from '../../src/owner-pg-executor.ts'
import { RuntimeInstanceControl } from '../../src/instance-control.ts'
import { PostgresOwnerStore } from '../../src/owner-store.ts'
import type { AccountId } from '../../src/types.ts'
import { instanceTestConnection } from '../instance-test-connection.ts'

const path = process.env['DSH_OWNER_PG_PRIVATE_CONFIG']
if (path === undefined) throw new Error('Assigned runtime configuration is required')
const executor = new PgOwnerExecutor(await instanceTestConnection(path), {
  maxConnections: 2, maxQueued: 2, queueTimeoutMs: 1000, connectionTimeoutMs: 1000,
  statementTimeoutMs: 5000, lockTimeoutMs: 4000, maxObservedOperations: 4, maxObservers: 4,
})
const instance = new RuntimeInstanceControl(executor, { internalAddress: 'node-startup-fixture', recipeVersion: 'm4-fixture' })
try {
  await instance.migrate()
  await instance.register()
  if (process.argv[2] === 'claim-owner') {
    const owners = new PostgresOwnerStore(executor, instance.identity, {
      maxMountedAccounts: 4, maxConcurrentMounts: 2, maxConcurrentDrains: 1,
    })
    await owners.migrate()
    await owners.claim({ accountId: brandString<AccountId>('m4-restart-owner'), expectedEpoch: null, recipeVersion: 'm4-fixture' })
  }
  await instance.close()
  process.stdout.write(JSON.stringify({ pid: process.pid, instanceId: instance.identity.instanceId }) + '\n')
} finally { await executor.close() }
