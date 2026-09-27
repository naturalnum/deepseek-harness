/** Install namespace-scoped Sandbox RBAC and keep its token only in the trial private directory. */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const namespace = process.env.PE_SANDBOX_NAMESPACE
const context = process.env.PE_KUBE_CONTEXT
const privateDir = process.env.PE_PRIVATE_DIR
if (!namespace || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)
  || !context || !privateDir) throw new Error('Set PE_SANDBOX_NAMESPACE, PE_KUBE_CONTEXT and PE_PRIVATE_DIR')

function kubectl(args, input) {
  const result = spawnSync('kubectl', ['--context', context, ...args], {
    input, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`kubectl ${args.at(-1)} failed; inspect the cluster without printing credentials`)
  return result.stdout
}

kubectl(['get', 'namespace', namespace, '-o', 'name'])
const template = await readFile(fileURLToPath(new URL('../k8s/platform-rbac.yaml', import.meta.url)), 'utf8')
if (!template.includes('namespace: placeholder')) throw new Error('RoleBinding template changed')
kubectl(['-n', namespace, 'apply', '-f', '-'], template.replace('namespace: placeholder', `namespace: ${namespace}`))
const secret = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: power-evolve-platform-access\n  namespace: ${namespace}\n  annotations:\n    kubernetes.io/service-account.name: power-evolve-platform\ntype: kubernetes.io/service-account-token\n`
kubectl(['-n', namespace, 'apply', '-f', '-'], secret)
let token = ''
for (let attempt = 0; attempt < 30; attempt++) {
  const value = JSON.parse(kubectl(['-n', namespace, 'get', 'secret', 'power-evolve-platform-access', '-o', 'json']))
  if (value.data?.token) { token = Buffer.from(value.data.token, 'base64').toString('utf8'); break }
  await new Promise(resolve => setTimeout(resolve, 200))
}
if (!token) throw new Error('ServiceAccount token was not issued')
const source = JSON.parse(kubectl(['config', 'view', '--raw', '-o', 'json']))
const selected = source.contexts.find(item => item.name === context)?.context
const cluster = source.clusters.find(item => item.name === selected?.cluster)?.cluster
if (!cluster?.server || !cluster['certificate-authority-data']) throw new Error('Selected context lacks an embedded Kubernetes CA')
const kubeconfigPath = join(privateDir, 'sandbox-kubeconfig')
const scoped = { apiVersion: 'v1', kind: 'Config', 'current-context': 'power-evolve-platform',
  clusters: [{ name: 'sandbox-cluster', cluster: { server: cluster.server,
    'certificate-authority-data': cluster['certificate-authority-data'] } }],
  contexts: [{ name: 'power-evolve-platform', context: { cluster: 'sandbox-cluster', user: 'power-evolve-platform', namespace } }],
  users: [{ name: 'power-evolve-platform', user: { token } }] }
await writeFile(kubeconfigPath, JSON.stringify(scoped, null, 2) + '\n', { mode: 0o600 })
await chmod(kubeconfigPath, 0o600)
const sandboxPath = join(privateDir, 'sandbox.json')
const sandbox = JSON.parse(await readFile(sandboxPath, 'utf8'))
sandbox.kubeconfigFile = kubeconfigPath
await writeFile(sandboxPath, JSON.stringify(sandbox, null, 2) + '\n', { mode: 0o600 })
await chmod(sandboxPath, 0o600)
console.log('Installed namespace-scoped Sandbox access and updated the private trial configuration.')
