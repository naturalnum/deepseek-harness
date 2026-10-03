/** Built static validation and HTTP asset responses; no Platform authority or browser trial is exercised. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { serveUi } from '../lib/ui.js'

const asset = new URL('../../contracts/lib/browser/execution-resolution.js', import.meta.url)
const request = { requestId: '00000000-0000-4000-8000-000000000001',
  executionId: '00000000-0000-4000-8000-000000000002', target: 'cloud',
  fingerprint: 'a'.repeat(64), note: 'A recorded command' }

test('the built approval validation module loads without a package resolver and rejects an injected result', async () => {
  const bytes = await readFile(asset)
  const moduleUrl = `data:text/javascript;base64,${bytes.toString('base64')}`
  const validation = await import(moduleUrl)
  assert.deepEqual(validation.executionResolutionRequest.parse(request), request)
  assert.equal(validation.executionResolutionRequest.safeParse({ ...request, finalState: 'succeeded' }).success, false)
  assert.equal(validation.executionResolutionRequest.safeParse({ ...request, fingerprint: '../alice' }).success, false)
  assert.equal(validation.executionResolutionReceipt.safeParse({
    requestId: request.requestId, executionId: request.executionId,
    sessionId: '00000000-0000-4000-8000-000000000003', target: 'cloud', state: 'completed',
    finalState: 'closed_unknown', stopConfirmed: false, continuationQueued: false, errorCode: null,
  }).success, false)
  const checked = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module'], {
    input: `const validation = await import(${JSON.stringify(moduleUrl)});\n`
      + `validation.executionResolutionRequest.parse(${JSON.stringify(request)});\n`,
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(checked.error, undefined)
  assert.equal(checked.status, 0, checked.stderr)
})

test('only the trusted static surface serves the exact built module under its existing CSP', async context => {
  const application = ['login', 'client', 'device']
  const server = createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://127.0.0.1')
    const surface = application[Number(url.searchParams.get('surface') ?? 0)]
    try {
      if (await serveUi(url.pathname, surface, response)) return
      response.writeHead(404).end()
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${origin}/execution-resolution-contract.js`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-security-policy'), /script-src 'self';/u)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(asset))
  for (const surface of [1, 2]) {
    assert.equal((await fetch(`${origin}/execution-resolution-contract.js?surface=${surface}`)).status, 404)
    assert.equal((await fetch(`${origin}/execution-resolution.js?surface=${surface}`)).status, 404)
  }
  assert.equal((await fetch(`${origin}/execution-resolution-contract.js.map`)).status, 404)
  assert.equal((await fetch(`${origin}/contracts/src/execution-resolution.ts`)).status, 404)
})
