/** Prepare a dedicated Connector Runner namespace and write its scoped kubeconfig outside the repository. */
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const namespace = process.env.PE_CONNECTOR_NAMESPACE
const context = process.env.PE_KUBE_CONTEXT
const privateDirInput = process.env.PE_CONNECTOR_PRIVATE_DIR
if (!namespace || !/^pe-connector-[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace)
  || namespace.length > 63 || !context || !privateDirInput || !isAbsolute(privateDirInput)) {
  throw new Error('Set PE_CONNECTOR_NAMESPACE (pe-connector-*), PE_KUBE_CONTEXT and PE_CONNECTOR_PRIVATE_DIR')
}

const productRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = await realpath(resolve(productRoot, '../..'))
const requestedDir = resolve(privateDirInput)
if (requestedDir === repoRoot || requestedDir.startsWith(`${repoRoot}${sep}`)) {
  throw new Error('Connector kubeconfig directory must be outside the repository')
}
await mkdir(privateDirInput, { recursive: true, mode: 0o700 })
const privateDir = await realpath(privateDirInput)
if (privateDir === repoRoot || privateDir.startsWith(`${repoRoot}${sep}`)) {
  throw new Error('Connector kubeconfig directory must be outside the repository')
}
if ((await lstat(privateDirInput)).isSymbolicLink() || ((await stat(privateDir)).mode & 0o077) !== 0) {
  throw new Error('Connector kubeconfig directory must be a private, non-symlink directory (0700)')
}

function kubectl(args, input, allowNotFound = false) {
  const result = spawnSync('kubectl', ['--context', context, ...args], {
    input, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    if (allowNotFound && result.status === 1 && /NotFound/u.test(result.stderr)) return null
    throw new Error(`kubectl ${args[0]} failed; inspect the selected cluster without printing credentials`)
  }
  return result.stdout
}

const ownerLabels = { 'app.kubernetes.io/part-of': 'power-evolve',
  'app.kubernetes.io/component': 'connector-runner' }
const existingText = kubectl(['get', 'namespace', namespace, '-o', 'json'], undefined, true)
if (existingText) {
  const labels = JSON.parse(existingText).metadata?.labels
  if (Object.entries(ownerLabels).some(([key, value]) => labels?.[key] !== value)) {
    throw new Error('Existing namespace is not owned by the Connector Runner deployment')
  }
} else {
  kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'Namespace',
    metadata: { name: namespace, labels: ownerLabels } }))
}

const template = await readFile(fileURLToPath(new URL('../connector-runner/deploy/platform-rbac.yaml', import.meta.url)), 'utf8')
if ((template.match(/namespace: placeholder/gu) ?? []).length !== 4) throw new Error('Connector RBAC template changed')
kubectl(['-n', namespace, 'apply', '-f', '-'], template.replaceAll('namespace: placeholder', `namespace: ${namespace}`))
kubectl(['-n', namespace, 'apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'Secret',
  metadata: { name: 'power-evolve-connector-platform-access', namespace,
    annotations: { 'kubernetes.io/service-account.name': 'power-evolve-connector-platform' } },
  type: 'kubernetes.io/service-account-token' }))

let token = ''
for (let attempt = 0; attempt < 30; attempt++) {
  const value = JSON.parse(kubectl(['-n', namespace, 'get', 'secret',
    'power-evolve-connector-platform-access', '-o', 'json']))
  if (value.data?.token) { token = Buffer.from(value.data.token, 'base64').toString('utf8'); break }
  await new Promise(resolveWait => setTimeout(resolveWait, 200))
}
if (!token) throw new Error('Connector ServiceAccount token was not issued')
const source = JSON.parse(kubectl(['config', 'view', '--raw', '-o', 'json']))
const selected = source.contexts.find(item => item.name === context)?.context
const cluster = source.clusters.find(item => item.name === selected?.cluster)?.cluster
if (!cluster?.server?.startsWith('https://') || !cluster['certificate-authority-data']) {
  throw new Error('Selected Kubernetes context lacks HTTPS and an embedded CA')
}
const scoped = { apiVersion: 'v1', kind: 'Config', 'current-context': 'power-evolve-connector-platform',
  clusters: [{ name: 'connector-cluster', cluster: { server: cluster.server,
    'certificate-authority-data': cluster['certificate-authority-data'] } }],
  contexts: [{ name: 'power-evolve-connector-platform', context: { cluster: 'connector-cluster',
    user: 'power-evolve-connector-platform', namespace } }],
  users: [{ name: 'power-evolve-connector-platform', user: { token } }] }
const temporaryDir = await mkdtemp(join(privateDir, '.connector-kubeconfig-'))
try {
  const temporaryPath = join(temporaryDir, 'kubeconfig')
  await writeFile(temporaryPath, `${JSON.stringify(scoped, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporaryPath, join(privateDir, 'connector-kubeconfig'))
} finally {
  await rm(temporaryDir, { recursive: true, force: true })
}
console.log(`Prepared Connector Runner access in ${namespace}; kubeconfig: ${join(privateDir, 'connector-kubeconfig')}`)
