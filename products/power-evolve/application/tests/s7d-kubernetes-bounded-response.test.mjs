/** Real TLS service-proxy responses exercise both Runner adapters and resource limits. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KubernetesClient } from '../lib/platform/kubernetes.js'
import { SandboxManager } from '../lib/platform/sandbox.js'
import { SshRunnerOrchestrator } from '../lib/platform/ssh-runner.js'

const resourceLimit = 262_144, runnerLimit = 1_048_576
const paddedJson = bytes => '{"padding":"' + 'x'.repeat(bytes - 14) + '"}'

test('Runner service proxy preserves maximum output with bounded TLS responses',
  { timeout: 30_000 }, async t => {
    if (spawnSync('openssl', ['version']).status !== 0) { t.skip('OpenSSL is unavailable'); return }
    const temporary = await mkdtemp(join(tmpdir(), 'pe-s7d-response-'))
    let server
    t.after(async () => {
      if (server?.listening) {
        const closed = new Promise(resolve => server.close(resolve))
        server.closeAllConnections()
        await closed
      }
      await rm(temporary, { recursive: true, force: true })
    })
    const keyPath = join(temporary, 'key.pem'), caPath = join(temporary, 'ca.pem')
    const tokenPath = join(temporary, 'token')
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', caPath, '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr)
    const executionId = randomUUID(), instanceId = randomUUID(), podUid = randomUUID(), callId = randomUUID()
    const digest = 'a'.repeat(64), namespace = 'response-fixture'
    const suffix = '表😀 literal \\u0000'
    const output = '\u0000'.repeat(65_536 - Buffer.byteLength(suffix)) + suffix
    assert.equal(Buffer.byteLength(output), 65_536)
    const cloud = { id: executionId, state: 'succeeded', digest, exitCode: 0,
      stdout: output, stderr: output, stdoutTruncated: false, stderrTruncated: false,
      timedOut: false, instanceId }
    const ssh = { callId, instanceId, digest, state: 'succeeded', result: {
      kind: 'ssh.execute', exitCode: 0, signal: null, stdout: output, stderr: output,
    } }
    assert(Buffer.byteLength(JSON.stringify(cloud)) > resourceLimit)
    assert(Buffer.byteLength(JSON.stringify(cloud)) < runnerLimit)
    assert(Buffer.byteLength(JSON.stringify(ssh)) > resourceLimit)
    let bearer = 'first-token', sshOversize = false
    const seen = [], closedConnections = [], sshName = `pe-cr-${callId.replaceAll('-', '')}`
    server = createServer({ key: await readFile(keyPath), cert: await readFile(caPath) }, (request, response) => {
      seen.push({ path: request.url, bearer: request.headers.authorization,
        runnerToken: request.headers['x-power-evolve-runner-token'] })
      if (request.headers.authorization !== `Bearer ${bearer}`) { response.writeHead(401).end(); return }
      if (request.url === '/truncated' || request.url === '/timeout' || request.url === '/resource-oversize'
        || request.url?.endsWith('/proxy/oversize')
        || sshOversize && request.url?.endsWith(`/proxy/calls/${callId}`)) {
        closedConnections.push(new Promise(resolve => request.socket.once('close', resolve)))
      }
      const send = value => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(typeof value === 'string' ? value : JSON.stringify(value))
      }
      if (request.url === '/health') send({ ready: true })
      else if (request.url === '/timeout') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.flushHeaders()
      }
      else if (request.url === '/truncated') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': 1_000_000 })
        response.write('{"padding":"' + 'x'.repeat(32_768), () => setImmediate(() => response.destroy()))
      } else if (request.url === '/resource-limit') send(paddedJson(resourceLimit))
      else if (request.url === '/resource-oversize') send(paddedJson(resourceLimit + 1))
      else if (request.url?.endsWith('/proxy/oversize')) send(paddedJson(runnerLimit + 1))
      else if (request.url?.endsWith('/proxy/budget-limit')) send(paddedJson(runnerLimit))
      else if (request.url?.endsWith(`/proxy/executions/${executionId}`)) send(cloud)
      else if (request.url?.endsWith(`/pods/${sshName}`)) send({ metadata: { name: sshName, uid: podUid,
        labels: { 'app.kubernetes.io/name': 'power-evolve-connector-runner',
          'powerevolve.dev/connector-call': callId, 'powerevolve.dev/connector-role': 'call' } },
      status: { containerStatuses: [{ restartCount: 0 }] } })
      else if (request.url?.endsWith('/proxy/health')) send({ ready: true, instanceId })
      else if (request.url?.endsWith(`/proxy/calls/${callId}`)) send(sshOversize ? paddedJson(runnerLimit + 1) : ssh)
      else { response.writeHead(404).end(); return }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `https://127.0.0.1:${server.address().port}`
    await writeFile(tokenPath, bearer + '\n')
    const client = await KubernetesClient.fromServiceAccount(origin, caPath, tokenPath)
    // Only runner() is exercised; no file, database, or command execution dependency is invoked.
    const sandbox = new SandboxManager(client, null, null, 'fixture-key', { namespace,
      image: 'fixture', localRoot: temporary, nodeRoot: '/fixture', readyTimeoutMs: 1000 })

    await t.test('Sandbox dual-stream NUL and Unicode survive GET, POST and token rotation', async () => {
      assert.deepEqual(await sandbox.runner('sandbox', 'sandbox-token', 'GET', `/executions/${executionId}`), cloud)
      bearer = 'rotated-token'
      await writeFile(tokenPath, bearer + '\n')
      assert.deepEqual(await sandbox.runner('sandbox', 'sandbox-token', 'POST', `/executions/${executionId}`, {}), cloud)
      assert.deepEqual(seen.slice(-2).map(value => [value.bearer, value.runnerToken]),
        [['Bearer first-token', 'sandbox-token'], ['Bearer rotated-token', 'sandbox-token']])
    })
    await t.test('Runner budget accepts its exact boundary and rejects the next byte', async () => {
      const accepted = await sandbox.runner('sandbox', 'sandbox-token', 'GET', '/budget-limit')
      assert.equal(Buffer.byteLength(JSON.stringify(accepted)), runnerLimit)
      await assert.rejects(sandbox.runner('sandbox', 'sandbox-token', 'GET', '/oversize'),
        /Kubernetes response exceeds limit/)
      await Promise.all(closedConnections)
      assert.deepEqual(await client.call('GET', '/health'), { ready: true })
    })
    await t.test('ordinary resources retain 256 KiB even when a runner token is supplied', async () => {
      const accepted = await client.call('GET', '/resource-limit')
      assert.equal(Buffer.byteLength(JSON.stringify(accepted)), resourceLimit)
      await assert.rejects(client.call('GET', '/resource-oversize'), /Kubernetes response exceeds limit/)
      await assert.rejects(client.call('GET', '/resource-oversize', undefined, 10_000, 'sandbox-token'),
        /Kubernetes response exceeds limit/)
      await Promise.all(closedConnections)
    })
    await t.test('SSH aggregate protocol output uses the runner budget during recovery', async () => {
      const runner = new SshRunnerOrchestrator(client, { namespace, image: 'fixture', runtimeClassName: 'gvisor',
        controlKey: 'k'.repeat(32), readyTimeoutMs: 1000, platformIngressCidrs: ['127.0.0.1/32'],
        forbiddenProbe: { ip: '198.51.100.44', port: 443 }, proveForbiddenListener: async () => true })
      const handle = { callId, instanceId, podUid, destination: { ip: '203.0.113.12', port: 2222,
        username: 'alice', hostKeySha256: `SHA256:${'A'.repeat(43)}` } }
      const observed = await runner.reconcile(handle, true, digest)
      assert.equal(observed.state, 'known')
      assert.deepEqual(observed.status, ssh)
      sshOversize = true
      assert.deepEqual(await runner.reconcile(handle, true, digest),
        { state: 'uncertain', reason: 'runner_status_unavailable' })
      await Promise.all(closedConnections)
    })
    await t.test('truncated TLS response rejects without waiting for the request timeout', { timeout: 5000 }, async () => {
      await assert.rejects(client.call('GET', '/truncated', undefined, 10_000),
        /Kubernetes response (aborted|closed)|aborted|ECONNRESET/)
      await Promise.all(closedConnections)
      assert.deepEqual(await client.call('GET', '/health'), { ready: true })
    })
    await t.test('request timeout retains its error and closes the incomplete response', { timeout: 5000 }, async () => {
      await assert.rejects(client.call('GET', '/timeout', undefined, 200), /Kubernetes request timed out/)
      await Promise.all(closedConnections)
      assert.deepEqual(await client.call('GET', '/health'), { ready: true })
    })
    await t.test('resource status errors and untrusted TLS still fail', async () => {
      await assert.rejects(client.call('GET', '/not-found'), { status: 404 })
      const wrongCa = join(temporary, 'wrong-ca.pem'), wrongKey = join(temporary, 'wrong-key.pem')
      const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', wrongKey, '-out', wrongCa, '-days', '1', '-subj', '/CN=untrusted'], { encoding: 'utf8' })
      assert.equal(generated.status, 0, generated.stderr)
      const untrusted = await KubernetesClient.fromServiceAccount(origin, wrongCa, tokenPath)
      const requests = seen.length
      await assert.rejects(untrusted.call('GET', '/resource-limit'), /certificate|self.signed/iu)
      assert.equal(seen.length, requests)
    })
  })
