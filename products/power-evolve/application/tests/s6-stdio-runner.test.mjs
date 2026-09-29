/** Dedicated Pod policy and lost-dispatch recovery for process MCP. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { StdioRunnerOrchestrator } from '../lib/platform/stdio-runner.js'
import { KubernetesError } from '../lib/platform/kubernetes.js'

class FakeKubernetes {
  resources = new Map()
  runners = new Map()
  events = []
  losePost = false
  serverDefaults = false
  failPodCreateOnce = false
  resourcePath(namespace, kind, name) {
    return `/api/v1/namespaces/${namespace}/${kind}${name ? `/${name}` : ''}`
  }
  proxyPath(namespace, service, path) {
    return `/api/v1/namespaces/${namespace}/services/http:${service}:8080/proxy${path}`
  }
  async call(method, path, body) {
    this.events.push({ method, path, body })
    const proxy = /\/services\/http:([^/]+):8080\/proxy(.*)$/u.exec(path)
    if (proxy) return this.runner(method, proxy[1], proxy[2], body)
    const parts = path.split('/')
    const named = parts.at(-1)?.startsWith('pe-mcp-')
    const kind = named ? parts.at(-2) : parts.at(-1)
    const name = named ? parts.at(-1) : body?.metadata?.name
    const key = `${kind}/${name}`
    if (method === 'GET') {
      if (!this.resources.has(key)) throw new KubernetesError(404, 'absent')
      return this.resources.get(key)
    }
    if (method === 'POST') {
      if (this.resources.has(key)) throw new KubernetesError(409, 'exists')
      if (kind === 'pods' && this.failPodCreateOnce) {
        this.failPodCreateOnce = false
        throw new KubernetesError(503, 'temporary Pod create failure')
      }
      const resource = structuredClone(body)
      if (kind === 'secrets') resource.data = { token: Buffer.from(body.stringData.token).toString('base64') }
      if (this.serverDefaults && kind === 'services') {
        Object.assign(resource.spec, { clusterIP: '10.43.0.23', clusterIPs: ['10.43.0.23'],
          ipFamilies: ['IPv4'], ipFamilyPolicy: 'SingleStack', internalTrafficPolicy: 'Cluster',
          sessionAffinity: 'None' })
        resource.spec.ports[0].protocol = 'TCP'
      }
      if (kind === 'pods') {
        if (this.serverDefaults) {
          Object.assign(resource.spec, { dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler',
            serviceAccountName: 'default', nodeName: 'worker-1', priority: 0,
            preemptionPolicy: 'PreemptLowerPriority', tolerations: [
              { key: 'node.kubernetes.io/not-ready', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
              { key: 'node.kubernetes.io/unreachable', operator: 'Exists', effect: 'NoExecute', tolerationSeconds: 300 },
            ] })
          resource.spec.containers[0].ports[0].protocol = 'TCP'
          Object.assign(resource.spec.containers[0], { terminationMessagePath: '/dev/termination-log',
            terminationMessagePolicy: 'File' })
          Object.assign(resource.spec.containers[0].readinessProbe,
            { successThreshold: 1, failureThreshold: 3, initialDelaySeconds: 0 })
        }
        resource.metadata.uid = randomUUID()
        resource.status = { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] }
        this.runners.set(name, { instanceId: randomUUID(), calls: new Map() })
      }
      this.resources.set(key, resource)
      return resource
    }
    if (method === 'DELETE') { this.resources.delete(key); return null }
    throw new Error('unexpected Kubernetes request')
  }
  runner(method, name, route, body) {
    const state = this.runners.get(name)
    if (!state) throw new KubernetesError(404, 'missing Runner')
    if (route === '/health') return { ready: true, instanceId: state.instanceId }
    if (route.startsWith('/calls/') && method === 'GET') {
      const call = state.calls.get(route.slice(7))
      if (!call) throw new KubernetesError(404, 'missing call')
      return call
    }
    if (route === '/calls' && method === 'POST') {
      if (this.losePost) throw new Error('lost POST response')
      const call = { callId: body.callId, instanceId: state.instanceId,
        digest: body.digest, state: 'running' }
      state.calls.set(body.callId, call)
      return call
    }
    throw new Error('unexpected Runner request')
  }
}

const make = (kube, proof = async () => true) => new StdioRunnerOrchestrator(kube, {
  namespace: 'pe-connector-only', image: 'connector-runner:test', runtimeClassName: 'gvisor',
  controlKey: 'x'.repeat(32), readyTimeoutMs: 1000, platformIngressCidrs: ['198.51.100.8/32'],
  forbiddenProbe: { ip: '198.51.100.44', port: 8080 }, proveForbiddenListener: proof,
})

test('policy has no egress exception and one process call is never replayed', async () => {
  const kube = new FakeKubernetes(), runner = make(kube), callId = randomUUID(), accountId = randomUUID()
  const handle = await runner.prepare(callId)
  const created = kube.events.filter(event => event.method === 'POST' && !event.path.includes('/proxy'))
  assert.match(created[0].path, /networkpolicies$/u)
  assert.deepEqual(created[0].body.spec.egress, [])
  const pod = created.find(event => event.path.endsWith('/pods')).body
  assert.equal(pod.spec.automountServiceAccountToken, false)
  assert.equal(pod.spec.containers[0].securityContext.readOnlyRootFilesystem, true)
  assert.equal(pod.spec.volumes.some(volume => volume.hostPath || volume.persistentVolumeClaim), false)
  assert.deepEqual(await runner.reconcile(handle, false), { state: 'absent' })
  const expected = runner.digestFor(handle, accountId)
  assert.equal((await runner.dispatchFirst(handle, accountId)).state, 'known')
  assert.equal((await runner.dispatchFirst(handle, accountId)).state, 'known')
  assert.deepEqual(await runner.dispatchFirst(handle, randomUUID()),
    { state: 'uncertain', reason: 'runner_status_identity_changed' })
  assert.equal(kube.events.filter(event => event.method === 'POST' && event.path.endsWith('/proxy/calls')).length, 1)
  assert.equal((await runner.reconcile(handle, true, expected)).state, 'known')
  assert.deepEqual(await runner.reconcile(handle, true, '0'.repeat(64)),
    { state: 'uncertain', reason: 'runner_status_identity_changed' })
  await runner.cleanup(callId, handle.podUid)
  assert.equal(kube.resources.size, 0)
  assert.match(kube.events.filter(event => event.method === 'DELETE').at(-1).path, /networkpolicies/u)
})

test('forbidden probe and uncertain POST response block replay', async () => {
  const kube = new FakeKubernetes(), callId = randomUUID(), accountId = randomUUID()
  await assert.rejects(make(kube, async () => false).prepare(callId),
    { code: 'mcp_runner_probe_unavailable' })
  assert.equal(kube.events.some(event => event.method === 'POST'), false)
  const runner = make(kube), handle = await runner.prepare(callId)
  kube.losePost = true
  assert.deepEqual(await runner.dispatchFirst(handle, accountId),
    { state: 'uncertain', reason: 'dispatch_result_unknown' })
  assert.deepEqual(await runner.reconcile(handle, true, runner.digestFor(handle, accountId)),
    { state: 'uncertain', reason: 'dispatched_call_missing' })
  assert.equal(kube.events.filter(event => event.path.endsWith('/proxy/calls') && event.method === 'POST').length, 1)
})

test('Kubernetes Service and Pod defaults allow recovery without accepting changed targets or identity', async () => {
  const kube = new FakeKubernetes(), runner = make(kube), callId = randomUUID()
  kube.serverDefaults = true
  kube.failPodCreateOnce = true
  await assert.rejects(runner.prepare(callId), { status: 503 })
  const handle = await runner.prepare(callId)
  assert.deepEqual(await runner.prepare(callId), handle)
  assert.equal(kube.events.filter(event => event.method === 'POST' && event.path.endsWith('/services')).length, 1)
  const name = `pe-mcp-${callId.replaceAll('-', '')}`
  const service = kube.resources.get(`services/${name}`)
  service.spec.selector['powerevolve.dev/stdio-call'] = randomUUID()
  await assert.rejects(runner.prepare(callId), { code: 'mcp_runner_resource_changed' })
  service.spec.selector['powerevolve.dev/stdio-call'] = callId
  service.spec.ports[0].targetPort = 9090
  await assert.rejects(runner.prepare(callId), { code: 'mcp_runner_resource_changed' })
  service.spec.ports[0].targetPort = 8080
  const pod = kube.resources.get(`pods/${name}`)
  pod.spec.containers[0].image = 'changed:image'
  await assert.rejects(runner.prepare(callId), { code: 'mcp_runner_resource_changed' })
  pod.spec.containers[0].image = 'connector-runner:test'
  pod.metadata.labels['powerevolve.dev/stdio-call'] = randomUUID()
  await assert.rejects(runner.prepare(callId), { code: 'mcp_runner_resource_changed' })
  pod.metadata.labels['powerevolve.dev/stdio-call'] = callId
  pod.metadata.uid = randomUUID()
  assert.deepEqual(await runner.reconcile(handle, false),
    { state: 'uncertain', reason: 'runner_identity_changed' })
})
