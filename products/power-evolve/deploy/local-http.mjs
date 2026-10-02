/** Single physical machine local HTTP development deployment over the formal renderer.
 * nodeRoot is inside Kubernetes nodes: all Platform/Sandbox nodes must see the
 * same backing directory, or use one node. hostPath is not multi-machine NFS or
 * failover evidence. These resources intentionally cannot pass production preflight.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifests } from './render.mjs'
import { deploymentPublicOrigins } from './start.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const self = fileURLToPath(import.meta.url)

/** Build formal resources with only the declared local development overrides.
 * @param input Formal values with canonical HTTP loopback public Origins using one hostname and distinct ports.
 * @param options Canonical absolute Linux nodeRoot and optional hostReplicas/platformReplicas, each 1 or 2.
 * @returns Fresh resources with HTTP mode, shared hostPath PVs, no Ingress, and bounded local workloads.
 */
export function buildLocalHttpManifests(input, { nodeRoot, hostReplicas = 1, platformReplicas = 1 } = {}) {
  if (typeof nodeRoot !== 'string' || !posix.isAbsolute(nodeRoot) || nodeRoot === '/'
    || posix.normalize(nodeRoot) !== nodeRoot || nodeRoot.trim() !== nodeRoot
    || /[\u0000-\u001f\u007f\\]/u.test(nodeRoot)) throw new Error('Use a canonical absolute isolated nodeRoot')
  for (const replicas of [hostReplicas, platformReplicas]) {
    if (replicas !== 1 && replicas !== 2) throw new Error('Local replicas must be 1 or 2')
  }
  const { hostOrigin, platformOrigin } = deploymentPublicOrigins({ PE_LOCAL_HTTP: '1',
    PE_HOST_PUBLIC_ORIGIN: input?.hostPublicOrigin, PE_PLATFORM_PUBLIC_ORIGIN: input?.platformPublicOrigin })
  const values = structuredClone(input)
  // Preserve the HTTP Origins' effective ports, including HTTP's default 80,
  // while using HTTPS solely for the unchanged production renderer validation.
  for (const [field, origin] of [['hostPublicOrigin', hostOrigin], ['platformPublicOrigin', platformOrigin]]) {
    const url = new URL(origin)
    values[field] = new URL(`https://${url.hostname}:${url.port || '80'}`).origin
  }
  const items = buildManifests(values).filter(item => item.kind !== 'Ingress')
  for (const item of items) {
    if (item.kind === 'PersistentVolume') {
      delete item.spec.nfs
      delete item.spec.mountOptions
      item.spec.hostPath = { path: nodeRoot, type: 'DirectoryOrCreate' }
    }
    if (item.metadata.namespace !== values.namespace) continue
    if (item.kind === 'ConfigMap' && ['power-evolve-host-config', 'power-evolve-platform-config'].includes(item.metadata.name)) {
      item.data.PE_HOST_PUBLIC_ORIGIN = hostOrigin
      item.data.PE_PLATFORM_PUBLIC_ORIGIN = platformOrigin
      item.data.PE_LOCAL_HTTP = '1'
    }
    if (item.kind === 'Deployment' && ['power-evolve-host', 'power-evolve-platform'].includes(item.metadata.name)) {
      const platform = item.metadata.name === 'power-evolve-platform'
      item.spec.replicas = platform ? platformReplicas : hostReplicas
      item.spec.template.spec.containers[0].resources = {
        requests: { cpu: platform ? '250m' : '100m', memory: platform ? '512Mi' : '256Mi' },
        limits: { cpu: platform ? '1' : '750m', memory: platform ? '1536Mi' : '768Mi' },
      }
    }
  }
  return items
}

async function main() {
  const [valuesPath, outputPath, nodeRoot, host = '1', platform = '1', ...extra] = process.argv.slice(2)
  if (!valuesPath || !outputPath || !nodeRoot || extra.length || !['1', '2'].includes(host)
    || !['1', '2'].includes(platform)) {
    throw new Error('Use local-http.mjs <values.json> <new-output.json|yaml> <nodeRoot> [hostReplicas=1] [platformReplicas=1]')
  }
  const extension = extname(outputPath).toLowerCase()
  if (!['.json', '.yaml', '.yml'].includes(extension)) throw new Error('Choose a .json, .yaml, or .yml output')
  const values = JSON.parse(await readFile(valuesPath, 'utf8'))
  const items = buildLocalHttpManifests(values, { nodeRoot, hostReplicas: Number(host), platformReplicas: Number(platform) })
  const body = extension === '.json' ? JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2) + '\n'
    : items.map(item => yaml.dump(item, { noRefs: true, lineWidth: 120 })).join('---\n')
  await writeFile(outputPath, body, { mode: 0o600, flag: 'wx' })
  console.log(`Rendered ${items.length} single-machine local HTTP resources. Review before applying; this bundle cannot pass production preflight.`)
  for (const [role, origin, targetPort] of [['host', values.hostPublicOrigin, 18880], ['platform', values.platformPublicOrigin, 18881]]) {
    const url = new URL(origin), address = url.hostname === '[::1]' ? '::1' : url.hostname
    console.log(`kubectl --context <local-context> -n ${values.namespace} port-forward --address ${address} service/power-evolve-${role} ${url.port || '80'}:${targetPort}`)
  }
}

if (process.argv[1] === self) await main().catch(error => {
  console.error(error.message); process.exitCode = 1
})
