/** Reclaimed SSH terminal actions must not wait behind a stream of new calls. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { SshExecuteFixtureService as SshExecuteService } from './task-credential-fixture.mjs'

test('continuous SSH claims do not starve terminal continuation reconciliation', async () => {
  const calls = { claim: async () => ({ id: randomUUID() }) }
  const service = new SshExecuteService({ pool: null }, calls, {}, {},
    randomBytes(32).toString('base64url'), randomUUID(), 60_000, 100)
  let worked = 0, reconciled = 0
  service.pump = async () => { if (++worked === 4) service.stop.abort() }
  service.reconcileTerminals = async () => { reconciled++ }
  await service.poll()
  assert.equal(worked, 4)
  assert.equal(reconciled, 3)
})
