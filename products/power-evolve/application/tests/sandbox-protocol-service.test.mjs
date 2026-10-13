// @ts-check
/** Native Mac entry; the two real service cases execute in separate owned Linux PID/capture namespaces. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSandboxLinuxCase } from './sandbox-linux-fixture.ts'

test('current sandbox retains ready identity and proves the complete stop tuple before finalizer release', { timeout: 120_000 }, async (t) => {
  const completion = runSandboxLinuxCase('ready', t.signal)
  t.after(() => completion.then(() => undefined, () => undefined))
  const receipt = await completion
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.disposed.length, 5)
  assert.ok(receipt.disposed.every(resource => resource.absent))
})

test('current sandbox rejects foreign owner and revoked grant without changing its two writer tables', { timeout: 120_000 }, async (t) => {
  const completion = runSandboxLinuxCase('refusal', t.signal)
  t.after(() => completion.then(() => undefined, () => undefined))
  const receipt = await completion
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.disposed.length, 5)
  assert.ok(receipt.disposed.every(resource => resource.absent))
})

/** Register one additional owned Linux case under the same cancellation and disposal lifetime.
 * @param {import('./sandbox-protocol-flows.ts').SandboxUnitCase} job Selected core boundary.
 * @param {string} name Observed behavior in the current service.
 */
function coreCase(job, name) {
  test(`current sandbox core ${name}`, { timeout: 120_000 }, async (t) => {
    const completion = runSandboxLinuxCase(job, t.signal)
    t.after(() => completion.then(() => undefined, () => undefined))
    const receipt = await completion
    assert.equal(receipt.exitCode, 0)
    assert.equal(receipt.disposed.length, 5)
    assert.ok(receipt.disposed.every(resource => resource.absent))
  })
}

coreCase('owned_conflict', 'accepts only reobserved owned resources after competing POST conflicts')
coreCase('foreign_conflict', 'retains its reservation when a competing Service has another owner')
coreCase('interrupted_provision', 'fences revoked allocation and refuses to recreate an observed missing Service')
coreCase('missing_stop_proof', 'retains the original writer when an absent Pod has no stop proof')
