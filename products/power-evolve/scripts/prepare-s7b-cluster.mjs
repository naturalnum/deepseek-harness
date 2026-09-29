/** Prepare an isolated two-node k3d trial from a compatible local Agent Sandbox controller. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cluster = process.env.PE_S7B_CLUSTER ?? 'pe-s7b-multinode'
const context = `k3d-${cluster}`
const volume = process.env.PE_S7B_VOLUME ?? 'pe-s7b-shared-posix'
const nodeRoot = process.env.PE_S7B_NODE_ROOT ?? '/var/lib/power-evolve-s7b'
const localVolume = process.env.PE_S7B_LOCAL_VOLUME
  ?? join(homedir(), 'OrbStack/docker/volumes', volume)
const image = process.env.PE_S7B_RUNNER_IMAGE ?? 'pe-s7b-runner:local'
const k3sImage = process.env.PE_S7B_K3S_IMAGE
  ?? 'pe-c0-worker3-k3s:v1.35.5-k3s1-gvisor-20260831'
const source = process.env.PE_S7B_CONTROLLER_SOURCE_CONTEXT
const controllerImage = 'registry.k8s.io/agent-sandbox/agent-sandbox-controller@sha256:e1787f95cda406e2d81322e8637b6dfa2d77514fbbd0536a872b8e5d409b7154'
const crdSpecDigest = '3db4760b3e5b4ce678fece5b5eb04a1b263f915b4a76bcbddfd4fe1b0dec26cc'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]))
  return value
}
function specDigest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }

function call(binary, args, input, timeout = 180_000) {
  const result = spawnSync(binary, args, { cwd: root, input, encoding: 'utf8', timeout,
    maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${binary} ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message).slice(-1000)}`)
  return result.stdout.trim()
}
const kube = (selected, ...args) => call('kubectl', ['--context', selected, ...args])
const kubeJson = (selected, ...args) => JSON.parse(kube(selected, ...args, '-o', 'json'))
function exists(selected, ...args) {
  const result = spawnSync('kubectl', ['--context', selected, ...args], { cwd: root,
    encoding: 'utf8', timeout: 15_000 })
  return result.status === 0
}
function apply(value) { call('kubectl', ['--context', context, 'apply', '-f', '-'], JSON.stringify(value)) }
function copyResource(kind, name, namespace, selected) {
  const args = [...(namespace ? ['-n', namespace] : []), 'get', kind, name]
  const value = kubeJson(source, ...args)
  return { apiVersion: value.apiVersion, kind: value.kind,
    metadata: { name: value.metadata.name, ...(namespace ? { namespace } : {}) },
    ...Object.fromEntries(selected.map(field => [field, value[field]])) }
}

const clusters = JSON.parse(call('k3d', ['cluster', 'list', '-o', 'json']))
if (!clusters.some(item => item.name === cluster)) {
  call('docker', ['volume', 'create', volume])
  const args = ['cluster', 'create', cluster, '--servers', '1', '--agents', '1', '--no-lb',
    '--image', k3sImage, '--volume', `${volume}:${nodeRoot}@all`,
    '--k3s-arg', '--disable=traefik@server:0', '--wait', '--timeout', '180s']
  if (process.env.PE_S7B_NETWORK) args.push('--network', process.env.PE_S7B_NETWORK)
  call('k3d', args, undefined, 240_000)
}
const nodes = kubeJson(context, 'get', 'nodes').items
const names = [`k3d-${cluster}-server-0`, `k3d-${cluster}-agent-0`]
assert.deepEqual(new Set(nodes.map(node => node.metadata.name)), new Set(names))
for (const node of nodes) {
  assert.equal(node.status.conditions.find(item => item.type === 'Ready')?.status, 'True')
  const mounts = JSON.parse(call('docker', ['inspect', node.metadata.name, '--format', '{{json .Mounts}}']))
  assert(mounts.some(item => item.Name === volume && item.Destination === nodeRoot))
  assert.match(call('docker', ['exec', node.metadata.name, 'runsc', '--version']), /runsc/)
}

if (!exists(context, 'get', 'crd', 'sandboxes.agents.x-k8s.io')
  || !exists(context, '-n', 'agent-sandbox-system', 'get', 'deployment', 'agent-sandbox-controller')) {
  if (!source || source === context) throw new Error('Set PE_S7B_CONTROLLER_SOURCE_CONTEXT to a compatible local controller context')
  const deployment = copyResource('deployment', 'agent-sandbox-controller', 'agent-sandbox-system', ['spec'])
  assert.equal(deployment.spec.template.spec.containers[0].image, controllerImage,
    'Controller source image differs from the pinned trial image')
  const crd = copyResource('crd', 'sandboxes.agents.x-k8s.io', null, ['spec'])
  assert.equal(specDigest(crd.spec), crdSpecDigest, 'Controller source CRD differs from the pinned trial schema')
  apply(crd)
  apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'agent-sandbox-system' } })
  apply(copyResource('serviceaccount', 'agent-sandbox-controller', 'agent-sandbox-system', []))
  apply(copyResource('clusterrole', 'agent-sandbox-controller', null, ['rules']))
  const service = copyResource('service', 'agent-sandbox-controller', 'agent-sandbox-system', ['spec'])
  service.spec = { selector: service.spec.selector, ports: service.spec.ports }
  apply(service)
  apply(copyResource('clusterrolebinding', 'agent-sandbox-controller', null, ['roleRef', 'subjects']))
  apply(deployment)
  apply({ apiVersion: 'node.k8s.io/v1', kind: 'RuntimeClass',
    metadata: { name: 'gvisor' }, handler: 'runsc' })
}
kube(context, '-n', 'agent-sandbox-system', 'rollout', 'status',
  'deployment/agent-sandbox-controller', '--timeout=120s')
assert(exists(context, 'get', 'runtimeclass', 'gvisor'))
assert.equal(specDigest(kubeJson(context, 'get', 'crd', 'sandboxes.agents.x-k8s.io').spec), crdSpecDigest)
assert.equal(kubeJson(context, '-n', 'agent-sandbox-system', 'get', 'deployment',
  'agent-sandbox-controller').spec.template.spec.containers[0].image, controllerImage)

call('docker', ['build', '-t', image, 'products/power-evolve/sandbox'])
call('k3d', ['image', 'import', image, '-c', cluster], undefined, 240_000)
await mkdir(localVolume, { recursive: true })
const marker = `.s7b-shared-${randomBytes(8).toString('hex')}`
const markerPath = join(localVolume, marker)
try {
  await writeFile(markerPath, marker)
  for (const name of names) assert.equal(call('docker', ['exec', name, 'cat', `${nodeRoot}/${marker}`]), marker)
  assert.equal(await readFile(markerPath, 'utf8'), marker)
} finally { await rm(markerPath, { force: true }) }
console.log(JSON.stringify({ cluster, nodes: names, volume, nodeRoot, image,
  controllerImage, sharedVolumeVerified: true }))
