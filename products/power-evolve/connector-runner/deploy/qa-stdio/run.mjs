/** Disposable real k3d proof for two isolated STDIO MCP calls. */
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KubernetesClient } from '../../../application/src/platform/kubernetes.ts'
import { StdioRunnerOrchestrator } from '../../../application/src/platform/stdio-runner.ts'

const cluster = process.env.PE_K3D_CLUSTER
const context = process.env.PE_KUBE_CONTEXT
const image = process.env.PE_CONNECTOR_IMAGE
if (!cluster || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(cluster)
  || context !== `k3d-${cluster}` || !image
  || !/^[a-z0-9][a-z0-9./:_-]*:[a-z0-9][a-z0-9._-]*$/u.test(image)) {
  throw new Error('Set PE_K3D_CLUSTER, matching PE_KUBE_CONTEXT, and tagged PE_CONNECTOR_IMAGE')
}
const namespace = `pe-connector-qa-${randomBytes(4).toString('hex')}`
const privateDir = await mkdtemp(join(tmpdir(), 'pe-stdio-qa-'))
const kubeconfig = join(privateDir, 'connector-kubeconfig')
let namespaceMayExist = false
let runner
const handles = []

function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args[0] ?? ''} failed`)
  return result.stdout.trim()
}
const admin = args => command('kubectl', ['--context', context, ...args])
const tcpProbeSource = `
const net = require('node:net')
const socket = net.connect({host:process.argv[1],port:Number(process.argv[2])})
const end = value => { process.stdout.write(value); socket.destroy() }
socket.setTimeout(600,()=>end('denied'))
socket.once('connect',()=>end('connected'))
socket.once('error',error=>end(error.code==='ECONNREFUSED'?'refused':
  ['EHOSTUNREACH','ENETUNREACH','ETIMEDOUT','EACCES','EPERM'].includes(error.code)?'denied':'inconclusive'))
`

try {
  command('k3d', ['cluster', 'get', cluster])
  if (admin(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'])) {
    throw new Error('Refusing to use an existing namespace')
  }
  namespaceMayExist = true
  command('node', [fileURLToPath(new URL('../../../scripts/prepare-connector-access.mjs', import.meta.url))],
    { ...process.env, PE_CONNECTOR_NAMESPACE: namespace, PE_KUBE_CONTEXT: context,
      PE_CONNECTOR_PRIVATE_DIR: privateDir })
  command('node', [fileURLToPath(new URL('../prepare-forbidden-listener.mjs', import.meta.url))],
    { ...process.env, PE_CONNECTOR_NAMESPACE: namespace, PE_KUBE_CONTEXT: context,
      PE_CONNECTOR_KUBECONFIG: kubeconfig, PE_CONNECTOR_IMAGE: image })
  const forbiddenIp = JSON.parse(admin(['-n', namespace, 'get', 'service',
    'power-evolve-forbidden-listener', '-o', 'json'])).spec.clusterIP
  const nodeIp = JSON.parse(admin(['get', 'nodes', '-o', 'json'])).items[0]?.status
    ?.addresses?.find(item => item.type === 'InternalIP')?.address
  if (!forbiddenIp || !nodeIp) throw new Error('k3d probe IP is unavailable')
  const kube = await KubernetesClient.fromFile(kubeconfig)
  const probeLive = async () => {
    try {
      const status = await kube.call('GET', kube.proxyPath(namespace,
        'power-evolve-forbidden-listener', '/health'))
      return status?.healthy === true
    } catch (_unavailable) { return false }
  }
  if (!await probeLive()) throw new Error('Forbidden listener is unavailable')
  runner = new StdioRunnerOrchestrator(kube, { namespace, image, runtimeClassName: 'gvisor',
    controlKey: randomBytes(32).toString('hex'), readyTimeoutMs: 90_000,
    platformIngressCidrs: [`${nodeIp}/32`], forbiddenProbe: { ip: forbiddenIp, port: 8080 },
    proveForbiddenListener: probeLive })
  const users = [randomUUID(), randomUUID()]
  for (const userId of users) {
    const handle = await runner.prepare(randomUUID())
    handles.push(handle)
    const podName = `pe-mcp-${handle.callId.replaceAll('-', '')}`
    const policy = JSON.parse(admin(['-n', namespace, 'get', 'networkpolicy', podName, '-o', 'json']))
    if (!policy.spec.policyTypes.includes('Egress') || (policy.spec.egress ?? []).length !== 0) {
      throw new Error('Process Pod has an egress exception')
    }
    const forbidden = admin(['-n', namespace, 'exec', podName, '-c', 'runner', '--',
      'node', '-e', tcpProbeSource, forbiddenIp, '8080'])
    if (!['denied', 'refused'].includes(forbidden) || !await probeLive()) {
      throw new Error('Process Pod can reach a forbidden live listener')
    }
    const digest = runner.digestFor(handle, userId)
    let observed = await runner.dispatchFirst(handle, userId)
    for (let i = 0; i < 100 && observed.state === 'known' && observed.status.state === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      observed = await runner.reconcile(handle, true, digest)
    }
    if (observed.state !== 'known' || observed.status.state !== 'succeeded'
      || observed.status.result?.text !== `user:${userId}`) {
      throw new Error('STDIO MCP process did not return its assigned account')
    }
    const duplicate = await runner.dispatchFirst(handle, userId)
    if (duplicate.state !== 'known' || duplicate.status.digest !== digest) {
      throw new Error('STDIO MCP duplicate call identity changed')
    }
    const mismatch = await runner.dispatchFirst(handle, randomUUID())
    if (mismatch.state !== 'uncertain') throw new Error('Changed account reused a call ID')
    console.log('STDIO MCP call: isolated Pod, denied live egress, correct account, stable retry')
  }
  if (handles[0].podUid === handles[1].podUid || users[0] === users[1]) {
    throw new Error('Two users shared a process Pod identity')
  }
  console.log('Two user calls: separate Pods and account-scoped results')
} finally {
  if (runner) for (const handle of handles) {
    try { await runner.cleanup(handle.callId, handle.podUid) }
    catch (_cleanupFailed) { console.error('Runner cleanup failed; namespace deletion follows') }
  }
  if (namespaceMayExist) {
    try { admin(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=180s']) }
    catch (_cleanupFailed) { console.error(`Namespace cleanup failed: ${namespace}`) }
  }
  await rm(privateDir, { recursive: true, force: true })
}
