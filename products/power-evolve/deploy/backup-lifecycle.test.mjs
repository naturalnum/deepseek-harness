import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { captureDeploymentBackupFence, stopDeploymentBackupWriters,
  requireDeploymentBackupStopped, restoreDeploymentBackupWriters } from './backup-lifecycle.mjs'

const appLabel = 'app.kubernetes.io/name'
const scope = { context: 'local-fixture', namespace: 'pe-app', runnerNamespace: 'pe-runners',
  connectorNamespace: 'pe-connectors', appImage: 'registry/app@sha256:' + 'a'.repeat(64) }
const yaml = createRequire(new URL('../application/package.json', import.meta.url))('js-yaml')
const denialSpec = yaml.loadAll(readFileSync(new URL('../connector-runner/deploy/forbidden-listener.yaml', import.meta.url),
  'utf8'))[0].spec.template.spec
function fixture() {
  const deployments = Object.fromEntries(['host', 'platform'].map(role => {
    const name = `power-evolve-${role}`
    return [name, { kind: 'Deployment', metadata: { name, namespace: scope.namespace, uid: role + '-uid',
      resourceVersion: '1', generation: 1 }, spec: { replicas: 2, selector: { matchLabels: { [appLabel]: name } },
      template: { spec: { containers: [{ name: 'dsh', image: scope.appImage }] } } },
    status: { observedGeneration: 1, replicas: 2 } }]
  }))
  const pods = { [scope.namespace]: [], [scope.runnerNamespace]: [], [scope.connectorNamespace]: [] }
  const patches = [], saves = [], sandboxes = [], autoscalers = []
  let beforePatch, afterPatch, afterSave, onDelay
  const io = {
    async getDeployment(namespace, name) {
      assert.equal(namespace, scope.namespace); return structuredClone(deployments[name])
    },
    async getPods(namespace) { return structuredClone(pods[namespace]) },
    async getSandboxes(namespace) { assert.equal(namespace, scope.runnerNamespace); return structuredClone(sandboxes) },
    async getAutoscalers(namespace) { assert.equal(namespace, scope.namespace); return structuredClone(autoscalers) },
    async saveFence(record) { saves.push(structuredClone(record)); await afterSave?.(record) },
    async patchDeployment(namespace, name, patch) {
      assert.equal(namespace, scope.namespace)
      const pending = saves.at(-1).deployments.find(entry => entry.name === name)
      assert.equal(pending.intent.state, 'pending', 'durable intent must precede mutation')
      patches.push({ name, patch: structuredClone(patch) })
      await beforePatch?.(name, patch)
      const actual = deployments[name]
      assert.deepEqual(patch.slice(0, 3), [{ op: 'test', path: '/metadata/uid', value: actual.metadata.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: actual.metadata.resourceVersion },
        { op: 'test', path: '/spec', value: actual.spec }])
      actual.spec.replicas = patch[3].value
      actual.metadata.generation++; actual.metadata.resourceVersion = String(Number(actual.metadata.resourceVersion) + 1)
      actual.status = { observedGeneration: actual.metadata.generation, replicas: actual.spec.replicas }
      await afterPatch?.(name, patch)
    },
    async delay() { await onDelay?.() },
  }
  return { io, deployments, pods, sandboxes, autoscalers, patches, saves,
    beforePatch: callback => { beforePatch = callback }, afterPatch: callback => { afterPatch = callback },
    afterSave: callback => { afterSave = callback }, onDelay: callback => { onDelay = callback } }
}

test('lost scale response is read back once; stop and resume preserve original specs and role order', async () => {
  const f = fixture(), originals = structuredClone(f.deployments)
  const fence = await captureDeploymentBackupFence(scope, f.io)
  assert.equal(f.patches.length, 0)
  f.afterPatch(() => { throw new Error('response lost after commit') })
  await stopDeploymentBackupWriters(fence, f.io)
  assert.equal(fence.phase, 'stopped')
  assert.deepEqual(f.patches.map(item => item.name), ['power-evolve-host', 'power-evolve-platform'])
  await requireDeploymentBackupStopped(fence, f.io)
  await restoreDeploymentBackupWriters(fence, f.io)
  assert.equal(fence.phase, 'restored')
  assert.deepEqual(f.patches.map(item => item.name), ['power-evolve-host', 'power-evolve-platform',
    'power-evolve-platform', 'power-evolve-host'])
  for (const name of Object.keys(originals)) assert.deepEqual(f.deployments[name].spec, originals[name].spec)
})

test('an uncommitted timeout leaves intent durable and makes no automatic retry or writer resume', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  f.beforePatch(() => { throw new Error('timeout before commit') })
  await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /unconfirmed; reconcile/)
  assert.equal(f.patches.length, 1)
  assert.equal(f.saves.at(-1).phase, 'stopping')
  assert.equal(f.saves.at(-1).deployments[0].intent.state, 'pending')
  await assert.rejects(restoreDeploymentBackupWriters(fence, f.io), /not confirmed stopped/)
  f.beforePatch(undefined)
  await stopDeploymentBackupWriters(structuredClone(f.saves.at(-1)), f.io)
  assert.equal(f.patches.length, 3, 'an explicit reconciliation can submit a fresh fenced request')
})

test('failure to persist an intent prevents the first replica mutation', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  f.afterSave(record => {
    if (record.deployments.some(entry => entry.intent?.state === 'pending')) throw new Error('durable storage unavailable')
  })
  await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /durable storage unavailable/)
  assert.equal(f.patches.length, 0)
})

test('terminating application Pods block Platform stop until the Host is absent', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  f.pods[scope.namespace].push({ metadata: { name: 'host-old', labels: { [appLabel]: 'power-evolve-host' },
    deletionTimestamp: '2026-10-03T00:00:00Z' } })
  let waits = 0
  f.onDelay(() => {
    waits++
    assert.deepEqual(f.patches.map(item => item.name), ['power-evolve-host'])
    f.pods[scope.namespace] = []
  })
  await stopDeploymentBackupWriters(fence, f.io, { timeoutMs: 1000, intervalMs: 1 })
  assert.equal(waits, 1)
})

test('a controller that has not observed zero replicas cannot authorize a snapshot', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  f.afterPatch(name => { f.deployments[name].status.observedGeneration-- })
  let waits = 0
  f.onDelay(() => {
    waits++
    const actual = f.deployments['power-evolve-host']
    actual.status.observedGeneration = actual.metadata.generation
    f.deployments['power-evolve-platform'].status.observedGeneration = f.deployments['power-evolve-platform'].metadata.generation
  })
  await stopDeploymentBackupWriters(fence, f.io, { timeoutMs: 1000, intervalMs: 1 })
  assert.equal(waits, 2)
})

for (const writer of ['sandbox', 'cloud Pod', 'connector Pod', 'terminating connector', 'mounted denial probe']) {
  test(`a remaining ${writer} rejects backup without resuming application writers`, async () => {
    const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
    const pod = { metadata: { name: 'remaining', labels: {} }, spec: {} }
    if (writer === 'sandbox') f.sandboxes.push({ metadata: { name: 'remaining' } })
    else if (writer === 'cloud Pod') f.pods[scope.runnerNamespace].push(pod)
    else {
      if (writer === 'terminating connector') pod.metadata.deletionTimestamp = '2026-10-03T00:00:00Z'
      if (writer === 'mounted denial probe') {
        pod.metadata.labels[appLabel] = 'power-evolve-forbidden-listener'
        pod.spec.volumes = [{ name: 'data', persistentVolumeClaim: { claimName: 'data' } }]
      }
      f.pods[scope.connectorNamespace].push(pod)
    }
    await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /execution (resources|Pods) remain/)
    assert.equal(fence.phase, 'stopping')
    assert.equal(f.patches.length, 2)
    assert.equal(f.deployments['power-evolve-host'].spec.replicas, 0)
    assert.equal(f.deployments['power-evolve-platform'].spec.replicas, 0)
  })
}

for (const phase of ['stop', 'restore']) {
  for (const mutation of ['uid', 'template', 'replicas']) {
    test(`${phase} refuses ${mutation} drift rather than patching an unrelated Deployment`, async () => {
      const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
      if (phase === 'restore') await stopDeploymentBackupWriters(fence, f.io)
      const actual = f.deployments['power-evolve-host']
      if (mutation === 'uid') actual.metadata.uid = 'replacement-host'
      if (mutation === 'template') actual.spec.template.spec.containers[0].args = ['changed']
      if (mutation === 'replicas') actual.spec.replicas = 3
      const count = f.patches.length
      await assert.rejects(phase === 'stop' ? stopDeploymentBackupWriters(fence, f.io)
        : restoreDeploymentBackupWriters(fence, f.io), /identity or spec changed|replica count changed/)
      assert.equal(f.patches.length, count)
    })
  }
}

test('application autoscaling refuses capture and an autoscaler introduced later refuses stop', async () => {
  const f = fixture()
  f.autoscalers.push({ spec: { scaleTargetRef: { kind: 'Deployment', name: 'power-evolve-host' } } })
  await assert.rejects(captureDeploymentBackupFence(scope, f.io), /Disable application autoscaling/)
  assert.equal(f.saves.length, 0)
  f.autoscalers.length = 0
  const fence = await captureDeploymentBackupFence(scope, f.io)
  f.autoscalers.push({ spec: { scaleTargetRef: { kind: 'Deployment', name: 'power-evolve-platform' } } })
  await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /Disable application autoscaling/)
  assert.equal(f.patches.length, 0)
})

test('external scaling to zero without backup intent is not claimed or later undone', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  f.deployments['power-evolve-host'].spec.replicas = 0
  await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /without its saved intent/)
  assert.equal(f.patches.length, 0)
})

test('a completed resume does not restart a service stopped later by an administrator', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  await stopDeploymentBackupWriters(fence, f.io)
  await restoreDeploymentBackupWriters(fence, f.io)
  const count = f.patches.length
  f.deployments['power-evolve-host'].spec.replicas = 0
  await assert.rejects(restoreDeploymentBackupWriters(fence, f.io), /changed after restoration/)
  assert.equal(f.patches.length, count)
})

test('explicit abort after both roles stopped resumes source despite a remaining execution resource', async () => {
  const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
  f.sandboxes.push({ metadata: { name: 'remaining' } })
  await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /Cloud execution resources remain/)
  await restoreDeploymentBackupWriters(fence, f.io)
  assert.equal(fence.phase, 'restored')
  assert.deepEqual(f.patches.slice(-2).map(item => item.name), ['power-evolve-platform', 'power-evolve-host'])
})

for (const mutation of ['none', 'mislabeled Runner', 'direct NFS', 'environment injection']) {
  test(`the denial probe exception ${mutation === 'none' ? 'permits its fixed unmounted process' : 'rejects ' + mutation}`, async () => {
    const f = fixture(), fence = await captureDeploymentBackupFence(scope, f.io)
    const pod = { metadata: { name: 'power-evolve-forbidden-listener-hash-pod',
      labels: { [appLabel]: 'power-evolve-forbidden-listener' } }, spec: structuredClone(denialSpec) }
    pod.spec.containers[0].image = 'registry/connector@sha256:' + 'b'.repeat(64)
    if (mutation === 'mislabeled Runner') pod.metadata.name = 'pe-cr-running'
    if (mutation === 'direct NFS') pod.spec.volumes = [{ name: 'direct', nfs: { server: '10.0.0.1', path: '/data' } }]
    if (mutation === 'environment injection') pod.spec.containers[0].env = [{ name: 'NODE_OPTIONS', value: '--import /custom.js' }]
    f.pods[scope.connectorNamespace].push(pod)
    if (mutation === 'none') await stopDeploymentBackupWriters(fence, f.io)
    else await assert.rejects(stopDeploymentBackupWriters(fence, f.io), /Connector execution Pods remain/)
  })
}
