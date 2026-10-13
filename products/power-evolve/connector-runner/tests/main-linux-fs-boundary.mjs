// @ts-check
/** Unit-only named read boundary; every other export remains the native implementation. */
import assert from 'node:assert/strict'
import native from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
export * from 'node:fs/promises'

/** @param {Parameters<typeof native.readFile>} args Native read arguments.
 * @returns Native result for other reads or the explicit non-Error unit rejection for the owned token.
 */
export function readFile(...args) {
  if (args[0] !== process.env.CONNECTOR_RUNNER_TOKEN_FILE) return native.readFile(...args)
  const receipt = process.env.PE_CONNECTOR_UNIT_RECEIPT
  assert.ok(receipt)
  const rejection = { kind: 'PE_CONNECTOR_UNIT_NON_ERROR_TOKEN_READ' }
  writeFileSync(receipt, JSON.stringify({ mode: 'non-error-token-read', pid: process.pid, childLocalUnitFault: true,
    seam: 'node:fs/promises.readFile', mainEntryOnly: true, target: 'owned token input only',
    allOtherExportsRemainNative: true, rejectedType: typeof rejection,
    rejectedInstanceofError: rejection instanceof Error }), { mode: 0o600 })
  return Promise.reject(rejection)
}

export default native
