/** Install and verify the fixed live listener that Connector Runner egress must deny. */
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const namespace = process.env.PE_CONNECTOR_NAMESPACE
const context = process.env.PE_KUBE_CONTEXT
const kubeconfig = process.env.PE_CONNECTOR_KUBECONFIG
const image = process.env.PE_CONNECTOR_IMAGE
if (!namespace || !/^pe-connector-[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(namespace)
  || namespace.length > 63 || !context || !kubeconfig
  || !image || !/^[a-z0-9][a-z0-9./:_-]*:[a-z0-9][a-z0-9._-]*$/u.test(image)) {
  throw new Error('Set PE_CONNECTOR_NAMESPACE, PE_KUBE_CONTEXT, PE_CONNECTOR_KUBECONFIG and PE_CONNECTOR_IMAGE')
}
function kubectl(args, input, scoped = false) {
  const result = spawnSync('kubectl', [scoped ? '--kubeconfig' : '--context',
    scoped ? kubeconfig : context, ...args], { input, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`kubectl ${args[0]} failed`)
  return result.stdout
}
const labels = JSON.parse(kubectl(['get', 'namespace', namespace, '-o', 'json'])).metadata?.labels
if (labels?.['app.kubernetes.io/part-of'] !== 'power-evolve'
  || labels?.['app.kubernetes.io/component'] !== 'connector-runner') {
  throw new Error('Namespace is not owned by the Connector Runner deployment')
}
const template = await readFile(fileURLToPath(new URL('./forbidden-listener.yaml', import.meta.url)), 'utf8')
if ((template.match(/namespace: placeholder/gu) ?? []).length !== 2
  || (template.match(/image: image-placeholder/gu) ?? []).length !== 1) {
  throw new Error('Forbidden listener template changed')
}
kubectl(['-n', namespace, 'apply', '-f', '-'], template.replaceAll('namespace: placeholder', `namespace: ${namespace}`)
  .replace('image: image-placeholder', `image: ${image}`))
kubectl(['-n', namespace, 'rollout', 'status', 'deployment/power-evolve-forbidden-listener', '--timeout=120s'])
const response = JSON.parse(kubectl(['get', '--raw',
  `/api/v1/namespaces/${namespace}/services/http:power-evolve-forbidden-listener:8080/proxy/health`], undefined, true))
if (response.healthy !== true) throw new Error('Forbidden listener did not report healthy')
const service = JSON.parse(kubectl(['-n', namespace, 'get', 'service', 'power-evolve-forbidden-listener', '-o', 'json']))
if (!service.spec?.clusterIP || service.spec.clusterIP === 'None') throw new Error('Forbidden listener has no ClusterIP')
console.log(`Forbidden listener healthy through scoped service proxy; forbiddenProbe: ${service.spec.clusterIP}:8080`)
