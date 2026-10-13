/** Artifact plane: POWER_EVOLVE_FACTORY_FILE must name bytes emitted from this checkout. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const file = process.env.POWER_EVOLVE_FACTORY_FILE
assert(file && isAbsolute(file), 'Set POWER_EVOLVE_FACTORY_FILE to an absolute emitted client.js path')
const platform = new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'])

test('current emitted factory admits only native dependencies under a CSP forbidding dynamic code', async (t) => {
  const source = await readFile(file, 'utf8')
  let registration
  const context = { TextEncoder, TextDecoder, URL, AbortController,
    window: { __ModuleLoader__: { load(entry) { assert.equal(registration, undefined); registration = entry } } } }
  runInNewContext(source, context, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } })
  assert.equal(registration?.id, '@power-evolve/client-account')
  assert.equal(typeof registration.factory, 'function')
  const required = new Set()
  const exported = registration.factory((id) => {
    assert(platform.has(id), `Unexpected native module-table dependency: ${id}`)
    required.add(id)
    return {}
  })
  assert.equal(typeof exported.apply, 'function')
  assert(Array.isArray(exported.inject))
  assert.equal(context.__zod_globalConfig.jitless, true)
  const entries = [], requests = []
  const ctx = {
    get: () => ({ state: { getSnapshot: () => undefined, subscribe: () => () => {} }, stop: () => {} }),
    effect: () => {},
    locale: { bind: () => key => key },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} } },
    slots: { inject: (_name, effect) => effect(), register: (entry) => { entries.push(entry); return () => {} } },
  }
  context.fetch = async (url, init) => {
    requests.push({ url, init })
    return Response.json(url === '/config' ? { loginUrl: 'https://platform.test/login' } : {
      userId: '00000000-0000-4000-8000-000000000001', username: 'alice', displayName: 'Alice',
      role: 'ADMIN', canManage: true, accountUrl: 'https://platform.test/account',
    })
  }
  exported.apply(ctx)
  const props = entries.find(entry => entry.name === 'settings.launcher').inject()
  const grant = await props.loadNavigation(new AbortController().signal)
  assert.equal(grant.role, 'ADMIN')
  assert.equal(grant.accountUrl, 'https://platform.test/account')
  assert.deepEqual(JSON.parse(requests.find(item => item.init.method === 'POST').init.body), { request: {} })
  t.diagnostic(JSON.stringify({ file, sha256: createHash('sha256').update(source).digest('hex'),
    required: [...required].sort(), inject: [...exported.inject] }))
})
