/** Scoped preload for two explicitly labelled child-local unit fault controls. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import { registerHooks } from 'node:module'

const mode = process.env.PE_CONNECTOR_UNIT_FAULT
const receipt = process.env.PE_CONNECTOR_UNIT_RECEIPT
assert.ok(receipt)
assert.ok(mode === 'non-error-token-read' || mode === 'http-close-error')
const save = (evidence: Record<string, unknown>): void => {
  writeFileSync(receipt, JSON.stringify({ mode, pid: process.pid, childLocalUnitFault: true, ...evidence }), { mode: 0o600 })
}

if (mode === 'non-error-token-read') {
  assert.ok(process.env.CONNECTOR_RUNNER_TOKEN_FILE)
  const main = new URL('../src/main.ts', import.meta.url)
  const boundary = new URL('./main-linux-fs-boundary.mjs', import.meta.url).href
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node:fs/promises' && context.parentURL && new URL(context.parentURL).pathname === main.pathname) {
        save({ phase: 'main import boundary', seam: 'node:fs/promises.readFile', mainEntryOnly: true })
        return { url: boundary, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
  process.once('exit', () => { hooks.deregister() })
} else {
  const descriptor = Object.getOwnPropertyDescriptor(http.Server.prototype, 'close')
  assert.ok(descriptor)
  const nativeMethod: unknown = descriptor.value
  assert.ok(typeof nativeMethod === 'function')
  const original = nativeMethod as (this: http.Server, callback?: (error?: Error) => void) => http.Server
  Object.defineProperty(http.Server.prototype, 'close', { ...descriptor,
    value: function (this: http.Server, callback?: (error?: Error) => void): http.Server {
      if (!callback) { original.call(this); return this }
      original.call(this, (error?: Error) => {
        if (error) { callback(error); return }
        assert.equal(this.listening, false)
        Object.defineProperty(http.Server.prototype, 'close', descriptor)
        save({ seam: 'node:http.Server.close callback', originalNativeCloseSucceeded: true,
          listeningAfterNativeClose: this.listening, injectedType: 'Error', originalBoundaryRestored: true })
        callback(new Error('PE_CONNECTOR_UNIT_HTTP_CLOSE_AFTER_REAL_CLOSED'))
      })
      return this
    },
  })
}
