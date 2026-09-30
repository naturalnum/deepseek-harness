/** Deterministic Kubernetes and Runner checks for the credential dispatch boundary. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SshRunnerOrchestrator } from '../lib/platform/ssh-runner.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'
import { requestDigest } from '../../connector-runner/lib/protocol.js'

const target = { ip: '203.0.113.12', port: 2222, username: 'alice',
  hostKeySha256: `SHA256:${'A'.repeat(43)}` }
const password = 'only-in-runner-post-Ω'

class FakeKubernetes {
  resources = new Map()
  runners = new Map()
  events = []
  failDispatch = false
  wrongHostKey = false
  resourcePath(namespace, resource, name) {
    return `/api/v1/namespaces/${namespace}/${resource}${name ? `/${name}` : ''}`
  }
  proxyPath(namespace, service, path) {
    return `/api/v1/namespaces/${namespace}/services/http:${service}:8080/proxy${path}`
  }
  async call(method, path, body, _timeout, token) {
    this.events.push({ method, path, body })
    const proxy = /\/services\/http:([^/]+):8080\/proxy(.*)$/u.exec(path)
    if (proxy) return this.runner(method, proxy[1], proxy[2], body, token)
    const parts = path.split('/')
    const kind = parts.at(-1)?.startsWith('pe-cr-') ? parts.at(-2) : parts.at(-1)
    const name = parts.at(-1)?.startsWith('pe-cr-') ? parts.at(-1) : undefined
    const key = `${kind}/${name ?? body?.metadata?.name}`
    if (method === 'GET') {
      const resource = this.resources.get(key)
      if (!resource) throw new KubernetesError(404, 'missing')
      return resource
    }
    if (method === 'POST') {
      if (this.resources.has(key)) throw new KubernetesError(409, 'exists')
      const resource = structuredClone(body)
      if (kind === 'secrets') resource.data = { token: Buffer.from(body.stringData.token).toString('base64') }
      if (kind === 'pods') {
        resource.metadata.uid = randomUUID()
        resource.status = { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] }
        this.runners.set(resource.metadata.name, { instanceId: randomUUID(), calls: new Map() })
      }
      this.resources.set(key, resource)
      return resource
    }
    if (method === 'DELETE') { this.resources.delete(key); return null }
    throw new Error('unhandled fake request')
  }
  runner(method, name, route, body, token) {
    const runner = this.runners.get(name)
    if (!runner || token !== Buffer.from(this.resources.get(`secrets/${name}`).data.token, 'base64').toString()) {
      throw new KubernetesError(404, 'runner missing')
    }
    if (route === '/health') return { ready: true, instanceId: runner.instanceId }
    if (method === 'GET' && route.startsWith('/calls/')) {
      const record = runner.calls.get(route.slice('/calls/'.length))
      if (!record) throw new KubernetesError(404, 'call missing')
      if (name.endsWith('-check') && record.state === 'running') {
        record.state = 'succeeded'
        record.result = { kind: 'ssh.inspect', hostKeySha256: this.wrongHostKey
          ? `SHA256:${'B'.repeat(43)}` : target.hostKeySha256, serverBanner: null }
      }
      return record
    }
    if (method === 'POST' && route === '/calls') {
      if (this.failDispatch && !name.endsWith('-check')) throw new Error('reply lost after possible dispatch')
      const prior = runner.calls.get(body.callId)
      if (prior) return prior
      const record = { callId: body.callId, instanceId: runner.instanceId, digest: body.digest,
        state: 'running' }
      runner.calls.set(body.callId, record)
      return record
    }
    throw new Error('unhandled fake runner route')
  }
}

function make(kube, proof = async () => true) {
  return new SshRunnerOrchestrator(kube, { namespace: 'pe-connector-only', image: 'connector-runner:test',
    runtimeClassName: 'gvisor', controlKey: 'x'.repeat(32), readyTimeoutMs: 1200,
    platformIngressCidrs: ['198.51.100.8/32'], forbiddenProbe: { ip: '198.51.100.44', port: 443 },
    proveForbiddenListener: proof })
}

test('policy precedes Pod, canary precedes credential, and request is observed before replay', async () => {
  const kube = new FakeKubernetes(), service = make(kube), callId = randomUUID()
  const handle = await service.prepare(callId, target)
  const creates = kube.events.filter(event => event.method === 'POST')
  assert.match(creates[0].path, /networkpolicies$/u)
  const policy = creates[0].body.spec
  assert.deepEqual(policy.policyTypes, ['Ingress', 'Egress'])
  assert.deepEqual(policy.egress, [{ to: [{ ipBlock: { cidr: '203.0.113.12/32' } }],
    ports: [{ protocol: 'TCP', port: 2222 }] }])
  assert.equal(policy.ingress[0].from[0].ipBlock.cidr, '198.51.100.8/32')
  const callPod = creates.find(event => event.path.endsWith('/pods')
    && event.body.metadata.name === `pe-cr-${callId.replaceAll('-', '')}`)?.body
  assert.ok(callPod)
  assert.equal(callPod.spec.automountServiceAccountToken, false)
  assert.equal(callPod.spec.containers[0].securityContext.readOnlyRootFilesystem, true)
  assert.equal(callPod.spec.containers[0].securityContext.runAsNonRoot, true)
  assert.deepEqual(callPod.spec.containers[0].env.find(item => item.name === 'CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL'),
    { name: 'CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL', value: '1' })
  assert.equal(callPod.spec.volumes.some(volume => volume.hostPath || volume.persistentVolumeClaim), false)
  assert.equal(JSON.stringify(kube.events.filter(event => !/\/proxy\/calls$/u.test(event.path))).includes(password), false)
  assert.equal(kube.events.some(event => /-check:8080\/proxy\/calls$/u.test(event.path)), true)

  assert.deepEqual(await service.reconcile(handle, false), { state: 'absent' })
  const request = { kind: 'ssh.execute', credential: { kind: 'password', password }, command: 'id',
    timeoutMs: 3000, maxOutputBytes: 1024 }
  const expectedDigest = service.digestFor(handle, request)
  assert.equal((await service.dispatchFirst(handle, request)).state, 'known')
  const posts = () => kube.events.filter(event => event.method === 'POST'
    && event.path.endsWith(`/http:pe-cr-${callId.replaceAll('-', '')}:8080/proxy/calls`))
  assert.equal(posts().length, 1)
  assert.equal(posts()[0].body.credential.password, password)
  const { digest, ...unsigned } = posts()[0].body
  const token = Buffer.from(kube.resources.get(`secrets/pe-cr-${callId.replaceAll('-', '')}`).data.token,
    'base64').toString()
  assert.equal(digest, requestDigest(unsigned, token))
  assert.equal((await service.dispatchFirst(handle, request)).state, 'known')
  assert.equal(posts().length, 1)
  assert.equal((await service.reconcile(handle, true, expectedDigest)).state, 'known')
  assert.deepEqual(await service.reconcile(handle, true, '0'.repeat(64)),
    { state: 'uncertain', reason: 'runner_status_identity_changed' })
  assert.equal((await service.dispatchFirst(handle, { ...request, command: 'changed' })).state, 'uncertain')
  assert.equal(posts().length, 1)
  assert.equal((await service.cancel(handle, expectedDigest)).state, 'uncertain')
  await service.cleanup(callId)
  assert.equal(kube.resources.size, 0)
  const deleteEvents = kube.events.filter(event => event.method === 'DELETE')
  assert.match(deleteEvents.at(-1).path, /networkpolicies/u)
})

test('failed proof and host-key mismatch deny credential placement', async () => {
  const kube = new FakeKubernetes(), callId = randomUUID()
  await assert.rejects(make(kube, async () => false).prepare(callId, target),
    { code: 'connector_runner_probe_unavailable' })
  assert.equal(kube.events.some(event => event.method === 'POST'), false)
  kube.wrongHostKey = true
  await assert.rejects(make(kube).prepare(callId, target), { code: 'connector_runner_canary_failed' })
  assert.equal([...kube.resources.keys()].some(key => key.startsWith('pods/')), false)
  assert.equal(kube.events.some(event => JSON.stringify(event).includes(password)), false)
})

test('lost POST and changed instance remain uncertain without replay', async () => {
  const kube = new FakeKubernetes(), service = make(kube), callId = randomUUID()
  const handle = await service.prepare(callId, target)
  kube.failDispatch = true
  const request = { kind: 'ssh.authenticate', credential: { kind: 'password', password },
    timeoutMs: 3000, maxOutputBytes: 1024 }
  const expectedDigest = service.digestFor(handle, request)
  assert.deepEqual(await service.dispatchFirst(handle, request),
    { state: 'uncertain', reason: 'dispatch_outcome_unknown' })
  assert.deepEqual(await service.reconcile(handle, true, expectedDigest),
    { state: 'uncertain', reason: 'dispatched_call_missing' })
  kube.runners.get(`pe-cr-${callId.replaceAll('-', '')}`).instanceId = randomUUID()
  assert.deepEqual(await service.reconcile(handle, true, expectedDigest),
    { state: 'uncertain', reason: 'runner_identity_changed' })
  assert.equal(kube.events.filter(event => event.method === 'POST'
    && event.path.endsWith(`/http:pe-cr-${callId.replaceAll('-', '')}:8080/proxy/calls`)).length, 1)
})

test('withdrawn forbidden-listener proof blocks the credential POST', async () => {
  const kube = new FakeKubernetes(), callId = randomUUID()
  let live = true
  const service = make(kube, async () => live)
  const handle = await service.prepare(callId, target)
  live = false
  const result = await service.dispatchFirst(handle, { kind: 'ssh.authenticate',
    credential: { kind: 'password', password }, timeoutMs: 3000, maxOutputBytes: 1024 })
  assert.deepEqual(result, { state: 'uncertain', reason: 'forbidden_probe_unavailable' })
  assert.equal(kube.events.some(event => event.path.endsWith(`/http:pe-cr-${callId.replaceAll('-', '')}:8080/proxy/calls`)
    && event.method === 'POST'), false)
})

test('private keys and passphrases enter only the bounded, digest-bound Runner POST', async () => {
  const kube = new FakeKubernetes(), service = make(kube), callId = randomUUID()
  const handle = await service.prepare(callId, target)
  const credential = { kind: 'private_key', privateKey: 'fixture-private-key\n', passphrase: 'phrase-γ' }
  const request = { kind: 'ssh.execute', credential, command: 'pwd', timeoutMs: 3000, maxOutputBytes: 1024 }
  const digest = service.digestFor(handle, request)
  assert.notEqual(service.digestFor(handle, { ...request, credential: { ...credential, passphrase: 'changed' } }), digest)
  assert.equal((await service.dispatchFirst(handle, request)).state, 'known')
  const posts = kube.events.filter(event => event.method === 'POST' && event.path.endsWith(
    `/http:pe-cr-${callId.replaceAll('-', '')}:8080/proxy/calls`))
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body.credential, credential)
  assert.equal(posts[0].body.digest, digest)
  assert.equal(JSON.stringify(kube.events.filter(event => !event.path.endsWith('/proxy/calls')))
    .includes(credential.privateKey), false)
  for (const invalid of [
    { ...credential, privateKey: '密'.repeat(2390) },
    { ...credential, passphrase: '密'.repeat(342) },
    { ...credential, privateKey: 'bad\ud800' },
    { ...credential, passphrase: '' },
    { ...credential, privateKey: '\0' },
  ]) assert.throws(() => service.digestFor(handle, { ...request, credential: invalid }),
    { code: 'connector_runner_request_invalid' })
  await service.cleanup(callId)
  assert.equal(kube.resources.size, 0)
})
