/** The in-cluster Kubernetes client must read a rotated ServiceAccount token on every call. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KubernetesClient } from '../lib/platform/kubernetes.js'

test('Kubernetes ServiceAccount token rotation keeps TLS verification and replaces the bearer',
  { timeout: 20_000 }, async t => {
    const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' })
    if (openssl.status !== 0) { t.skip('OpenSSL is unavailable'); return }
    const temporary = await mkdtemp(join(tmpdir(), 'pe-s7d-sa-'))
    t.after(() => rm(temporary, { recursive: true, force: true }))
    const keyPath = join(temporary, 'key.pem'), caPath = join(temporary, 'ca.pem')
    const tokenPath = join(temporary, 'token')
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', caPath, '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr)
    const seen = []
    const server = createServer({ key: await readFile(keyPath), cert: await readFile(caPath) },
      (request, response) => {
        seen.push(request.headers.authorization)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ready":true}')
      })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const origin = `https://127.0.0.1:${server.address().port}`
    await writeFile(tokenPath, 'first-token\n')
    const client = await KubernetesClient.fromServiceAccount(origin, caPath, tokenPath)
    assert.deepEqual(await client.call('GET', '/health'), { ready: true })
    await writeFile(tokenPath, 'rotated-token\n')
    assert.deepEqual(await client.call('GET', '/health'), { ready: true })
    assert.deepEqual(seen, ['Bearer first-token', 'Bearer rotated-token'])
    await assert.rejects(KubernetesClient.fromServiceAccount('http://127.0.0.1:1', caPath, tokenPath),
      /Invalid Kubernetes service URL/)
  })
