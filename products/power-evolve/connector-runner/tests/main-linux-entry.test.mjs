// @ts-check
/** Host-discovered controls dispatch the unchanged entry into owned Linux namespaces. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { withOwnedMainLinux } from './main-linux-fixture.ts'

test('formal Connector Linux default token file is read by the actual main entry', { timeout: 180_000 }, async (t) => {
  await withOwnedMainLinux(t, async (linux) => {
    const result = await linux.run('default-token')
    assert.equal(result.exitCode, 0)
    assert.equal(result.defaultTokenFile, true)
    assert.equal(result.healthStatus, 503)
  })
})

test('formal Connector Linux default port 8080 is bound by the actual main entry', { timeout: 180_000 }, async (t) => {
  await withOwnedMainLinux(t, async (linux) => {
    const result = await linux.run('default-port')
    assert.equal(result.exitCode, 0)
    assert.equal(result.defaultPort, true)
    assert.equal(result.healthStatus, 503)
  })
})

test('formal Connector Linux child-local non-Error token read unit fault is class-redacted', { timeout: 180_000 }, async (t) => {
  await withOwnedMainLinux(t, async (linux) => {
    const result = await linux.run('non-error-token-read')
    assert.equal(result.exitCode, 1)
    assert.equal(result.stderr, 'Connector Runner failed to start: Error\n')
    assert.equal(result.unitFault?.rejectedInstanceofError, false)
  })
})

test('formal Connector Linux child-local close callback unit fault follows actual native close', { timeout: 180_000 }, async (t) => {
  await withOwnedMainLinux(t, async (linux) => {
    const result = await linux.run('http-close-error')
    assert.equal(result.exitCode, 1)
    assert.equal(result.unitFault?.originalNativeCloseSucceeded, true)
    assert.equal(result.unitFault?.originalBoundaryRestored, true)
    assert.equal(result.unitFault?.listeningAfterNativeClose, false)
  })
})
