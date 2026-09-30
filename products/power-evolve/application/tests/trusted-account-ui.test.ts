/** Real HTTP checks for the Platform-owned account asset allowlist and response policy. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { serveTrustedAccountUi } from '../src/trusted-account-ui.ts'
import { sendFailure } from '../src/http.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pe-account-assets-'))
  const directory = join(root, 'trusted')
  await mkdir(directory)
  await writeFile(join(directory, 'asset-list.json'), JSON.stringify(['index.html', 'account.js']))
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Account</title>')
  await writeFile(join(directory, 'account.js'), 'export const page = "account";')
  await writeFile(join(directory, 'private.txt'), 'unlisted-private-content')
  await writeFile(join(root, 'outside.js'), 'outside-directory-content')
  const server = createServer((req, res) => {
    void serveTrustedAccountUi(req.url ?? '/', res, directory).then(handled => {
      if (!handled) { res.writeHead(404); res.end('other route') }
    }).catch(error => sendFailure(res, error))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const read = (path: string) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port: address.port, path, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    call.on('error', reject)
    call.end()
  })
  return { directory, read }
}

test('account HTML and listed scripts use a trusted-origin policy without relaxing script execution', async t => {
  const { read } = await fixture(t)
  for (const path of ['/account', '/account/']) {
    const response = await read(path)
    assert.equal(response.status, 200)
    assert.match(response.body, /<title>Account<\/title>/u)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
    const policy = response.headers['content-security-policy']
    assert(typeof policy === 'string')
    assert.match(policy, /script-src 'self';/u)
    assert.match(policy, /connect-src 'self';/u)
    assert.match(policy, /frame-ancestors 'none'; base-uri 'none';/u)
    assert(!policy.includes('unsafe-eval'))
  }
  const script = await read('/account/account.js')
  assert.equal(script.status, 200)
  assert.equal(script.headers['content-type'], 'text/javascript')
  assert.match(script.body, /export const page/u)
})

test('unlisted files, source maps and traversal do not return account or adjacent bytes', async t => {
  const { read } = await fixture(t)
  for (const path of ['/account/private.txt', '/account/account.js.map', '/account/../outside.js',
    '/account/%2e%2e/outside.js', '/account/assets/../../outside.js', '/account/missing.html']) {
    const response = await read(path)
    assert.equal(response.status, 404, path)
    assert.equal(response.body, '')
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  assert.equal((await read('/approval')).body, 'other route')
})

test('a malformed manifest cannot expose paths outside the packaged public assets', async t => {
  const { read, directory } = await fixture(t)
  for (const paths of [['index.html', '../outside.js'], ['index.html', 'account.js.map'], ['account.js'],
    ['index.html', 'index.html']]) {
    await writeFile(join(directory, 'asset-list.json'), JSON.stringify(paths))
    const response = await read('/account')
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.body), { error: 'service_unavailable' })
  }
})
