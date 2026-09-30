/** Run and remove a real SSH Connector Runner check in a fresh k3d namespace. */
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { identity } from '../../../application/src/contracts.ts'
import { initializeDatabase } from '../../../application/src/platform/database.ts'
import { KubernetesClient } from '../../../application/src/platform/kubernetes.ts'
import { SshCallStore } from '../../../application/src/platform/ssh-calls.ts'
import { SshConnectionService } from '../../../application/src/platform/ssh.ts'
import { SshExecuteService } from '../../../application/src/platform/ssh-execute.ts'
import { SshRunnerOrchestrator } from '../../../application/src/platform/ssh-runner.ts'
import { TaskStore } from '../../../application/src/platform/tasks.ts'

const { Pool } = createRequire(new URL('../../../application/package.json', import.meta.url))('pg')

const cluster = process.env.PE_K3D_CLUSTER
const context = process.env.PE_KUBE_CONTEXT
const image = process.env.PE_CONNECTOR_IMAGE
if (!cluster || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(cluster)
  || context !== `k3d-${cluster}` || !image
  || !/^[a-z0-9][a-z0-9./:_-]*:[a-z0-9][a-z0-9._-]*$/u.test(image)) {
  throw new Error('Set PE_K3D_CLUSTER, matching PE_KUBE_CONTEXT, and tagged PE_CONNECTOR_IMAGE')
}

const namespace = `pe-connector-qa-${randomBytes(4).toString('hex')}`
const retainedDir = process.env.PE_SSH_TRIAL_PRIVATE_DIR
const privateDir = retainedDir ? resolve(retainedDir) : await mkdtemp(join(tmpdir(), 'pe-connector-qa-'))
if (retainedDir) {
  const trialRoot = join(homedir(), '.config', 'power-evolve')
  if (!isAbsolute(retainedDir) || !privateDir.startsWith(`${trialRoot}${sep}`)) {
    throw new Error('PE_SSH_TRIAL_PRIVATE_DIR must be an absolute private trial directory')
  }
  await mkdir(privateDir, { mode: 0o700 })
  if ((await lstat(privateDir)).isSymbolicLink()) throw new Error('Trial directory cannot be a symlink')
}
const kubeconfig = join(privateDir, 'connector-kubeconfig')
let namespaceMayExist = false
let retainedReady = false
let orchestrator
let activeCallId

function command(executable, args, { input, env = process.env, secretOutput = false } = {}) {
  const result = spawnSync(executable, args, { input, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args[0] ?? ''} failed (status ${result.status ?? 'spawn'})`)
  }
  return secretOutput ? '' : result.stdout.trim()
}
const admin = (args, input) => command('kubectl', ['--context', context, ...args], { input })
function scopedCanI(verb, resource, namespaced = true) {
  const result = spawnSync('kubectl', ['--kubeconfig', kubeconfig,
    ...(namespaced ? ['-n', namespace] : []), 'auth', 'can-i', verb, resource],
  { encoding: 'utf8' })
  if (result.error || ![0, 1].includes(result.status) || !['yes', 'no'].includes(result.stdout.trim())) {
    throw new Error('Scoped authorization check failed')
  }
  return result.stdout.trim()
}
const apply = (resource) => admin(['-n', namespace, 'apply', '-f', '-'], `${JSON.stringify(resource)}\n`)
const labels = { 'app.kubernetes.io/name': 'power-evolve-qa-ssh' }
const tcpProbeSource = `
const net = require('node:net')
const probe = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port: Number(port) })
  let done = false
  const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value) }
  socket.setTimeout(600, () => finish('denied'))
  socket.once('connect', () => finish('connected'))
  socket.once('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'refused'
    : ['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EACCES', 'EPERM'].includes(error.code)
      ? 'denied' : 'inconclusive'))
})
Promise.all([probe(process.argv[1], process.argv[2]),
  probe(process.argv[3], process.argv[4])]).then(([allowed, forbidden]) => {
  process.stdout.write(JSON.stringify({ allowed, forbidden }))
})
`

function sshFixture(serverSource) {
  apply({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'qa-ssh-server', namespace },
    data: { 'server.mjs': serverSource } })
  apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'qa-ssh-credential', namespace },
    type: 'Opaque', stringData: { 'host-key': hostKey, password } })
  apply({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'qa-ssh', namespace },
    spec: { replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels },
      spec: { automountServiceAccountToken: false, runtimeClassName: 'gvisor',
        terminationGracePeriodSeconds: 5, securityContext: { runAsNonRoot: true, runAsUser: 10001,
          runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'ssh', image, imagePullPolicy: 'IfNotPresent',
          command: ['node', '/opt/power-evolve/connector-runner/qa/server.mjs'],
          ports: [{ name: 'ssh', containerPort: 2222 }],
          readinessProbe: { tcpSocket: { port: 'ssh' }, periodSeconds: 2 },
          resources: { requests: { cpu: '20m', memory: '48Mi' }, limits: { cpu: '250m', memory: '192Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
            runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, capabilities: { drop: ['ALL'] } },
          volumeMounts: [{ name: 'source', mountPath: '/opt/power-evolve/connector-runner/qa', readOnly: true },
            { name: 'credential', mountPath: '/run/power-evolve/qa-ssh', readOnly: true }] }],
        volumes: [{ name: 'source', configMap: { name: 'qa-ssh-server' } },
          { name: 'credential', secret: { secretName: 'qa-ssh-credential', defaultMode: 0o440 } }] } } } })
  apply({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'qa-ssh-ingress', namespace },
    spec: { podSelector: { matchLabels: labels }, policyTypes: ['Ingress'],
      ingress: [{ from: [{ podSelector: { matchLabels: {
        'app.kubernetes.io/name': 'power-evolve-connector-runner' } } }],
        ports: [{ protocol: 'TCP', port: 2222 }] }] } })
}

/** Exercise the complete approval-to-Runner path in a fresh PG database, never the stable trial. */
async function approvedExecuteForTwoUsers(targetIp, hostKeySha256) {
  const urlFile = process.env.PE_SSH_EXECUTE_DATABASE_URL_FILE
  if (!urlFile) return
  const adminUrl = (await readFile(urlFile, 'utf8')).trim()
  const database = `pe_ssh_execute_qa_${randomBytes(9).toString('hex')}`
  const adminPool = new Pool({ connectionString: adminUrl, max: 2 })
  let pool, created = false, service
  const executed = []
  try {
    await adminPool.query(`CREATE DATABASE "${database}"`)
    created = true
    const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${database}`
    pool = new Pool({ connectionString: databaseUrl.href, max: 12 })
    await initializeDatabase(pool)
    const users = [identity.parse({ userId: randomUUID(), username: 'alice' }),
      identity.parse({ userId: randomUUID(), username: 'bob' })]
    for (const user of users) {
      await pool.query('INSERT INTO pe_users(id,username,password_hash,settings) VALUES($1,$2,$3,$4)',
        [user.userId, user.username, 'test-only', { model: 'fixture', maxTokens: 64, revision: 1 }])
      await pool.query(`INSERT INTO pe_user_models(user_id,model_id,label,max_tokens,enabled)
        VALUES($1,'fixture','fixture',64,true)`, [user.userId])
    }
    const key = randomBytes(32).toString('base64url')
    const connections = new SshConnectionService(pool, key, `${targetIp}:2222`)
    const saved = []
    for (const user of users) {
      const requestId = randomUUID()
      const ticket = await connections.issueTicket(user, { requestId,
        displayName: `${user.username} QA server`, host: targetIp, port: 2222, username: 'qa',
        hostKeySha256, credentialKind: 'password', sizeBytes: Buffer.byteLength(password),
        enabled: true }, 'http://127.0.0.1:19221')
      saved.push((await connections.upload(ticket.ticket, Readable.from([Buffer.from(password)]))).item)
    }
    const tasks = new TaskStore(pool, { maxEventBytes: 524288, leaseMs: 90_000, maxPendingPerUser: 8,
      maxActivePerUser: 1, sshEnabled: true })
    const calls = new SshCallStore(pool)
    service = new SshExecuteService(tasks, calls, connections, orchestrator,
      key, randomUUID(), 90_000, 250, async () => targetIp)
    service.start()
    for (let i = 0; i < users.length; i++) {
      const user = users[i], connection = saved[i]
      const session = await tasks.create(user, randomUUID())
      await tasks.accept(user, session.sessionId, randomUUID(), 'Execute one approved SSH fixture command')
      const grant = await tasks.claim(randomUUID())
      if (grant.userId !== user.userId || grant.sshConnections.length !== 1
        || grant.sshConnections[0].connectionId !== connection.connectionId) {
        throw new Error('SSH trial task selection crossed a user boundary')
      }
      const proposed = await service.propose(grant.token, `qa-call-${i}`, connection.connectionId,
        connection.revision, connection.credentialRevision, 'qa:ping')
      await tasks.finish(grant.token, 'completed', null)
      const reviewed = (await service.approvals(user)).items.find(item => item.actionId === proposed.actionId)
      if (reviewed?.command !== 'qa:ping' || reviewed.fingerprint !== proposed.fingerprint
        || (await service.approvals(users[1 - i])).items.some(item => item.actionId === proposed.actionId)) {
        throw new Error('SSH approval did not show the exact owner-scoped command')
      }
      await service.decide(user, proposed.actionId, proposed.fingerprint, true)
      const until = Date.now() + 90_000
      let result
      while (Date.now() < until) {
        result = await service.status(user, proposed.actionId)
        if (['succeeded', 'failed'].includes(result.state)) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (result?.state !== 'succeeded' || result.result?.stdout !== 'qa:ssh-ok\n'
        || result.result?.exitCode !== 0) throw new Error('Approved SSH execution did not return fixture output')
      const call = await calls.get(user, proposed.actionId)
      if (!call.pod_uid || call.result !== null || call.kind !== 'ssh.execute') {
        throw new Error('SSH execution status or encrypted storage is invalid')
      }
      executed.push(call)
      const stored = await pool.query('SELECT command_sealed FROM pe_ssh_execute_actions WHERE id=$1',
        [proposed.actionId])
      if (stored.rows[0].command_sealed.includes(Buffer.from('qa:ping'))
        || JSON.stringify(call).includes(password)) throw new Error('SSH command or password leaked into call storage')
      const continuation = await tasks.claim(randomUUID())
      if (continuation.sessionId !== session.sessionId
        || continuation.sourceSshExecuteActionId !== proposed.actionId
        || !continuation.text.includes('qa:ssh-ok')) {
        throw new Error('SSH result did not continue its original Session')
      }
      await tasks.finish(continuation.token, 'completed', null)
      await orchestrator.cleanup(proposed.actionId)
      await calls.markCleanupComplete(proposed.actionId, call.pod_uid)
      console.log(`Approved SSH user ${i + 1}: isolated Runner, bounded output, original Session`)
    }
    if (executed[0].pod_uid === executed[1].pod_uid
      || executed[0].user_id === executed[1].user_id) throw new Error('SSH users shared a Runner identity')
    console.log('Two user SSH approval-to-execute paths: distinct Pod UIDs and owner-scoped results')
  } finally {
    await service?.close()
    for (const call of executed) {
      try { await orchestrator.cleanup(call.id) }
      catch (_alreadyDeleted) { /* The namespace cleanup below remains a final backstop. */ }
    }
    await pool?.end()
    if (created) await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`)
    await adminPool.end()
  }
}

let hostKey = ''
let password = ''
try {
  command('k3d', ['cluster', 'get', cluster])
  if (admin(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'])) {
    throw new Error('Refusing to use an existing namespace')
  }
  namespaceMayExist = true
  command('node', [fileURLToPath(new URL('../../../scripts/prepare-connector-access.mjs', import.meta.url))],
    { env: { ...process.env, PE_CONNECTOR_NAMESPACE: namespace, PE_KUBE_CONTEXT: context,
      PE_CONNECTOR_PRIVATE_DIR: privateDir } })
  if (scopedCanI('create', 'pods') !== 'yes'
    || scopedCanI('create', 'deployments.apps') !== 'no'
    || scopedCanI('get', 'namespaces', false) !== 'no') {
    throw new Error('Scoped kubeconfig authorization differs from the expected Role')
  }
  command('k3d', ['image', 'import', image, '-c', cluster])
  const keyPath = join(privateDir, 'host-key')
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { secretOutput: true })
  hostKey = await readFile(keyPath, 'utf8')
  password = randomBytes(32).toString('base64url')
  await writeFile(join(privateDir, 'password'), password, { mode: 0o600, flag: 'wx' })
  const keyLine = command('ssh-keygen', ['-lf', `${keyPath}.pub`, '-E', 'sha256'])
  const hostKeySha256 = /\b(SHA256:[A-Za-z0-9+/]{43})\b/u.exec(keyLine)?.[1]
  if (!hostKeySha256) throw new Error('Could not derive SSH host-key fingerprint')
  sshFixture(await readFile(new URL('./server.mjs', import.meta.url), 'utf8'))
  admin(['-n', namespace, 'rollout', 'status', 'deployment/qa-ssh', '--timeout=120s'])
  command('node', [fileURLToPath(new URL('../prepare-forbidden-listener.mjs', import.meta.url))],
    { env: { ...process.env, PE_CONNECTOR_NAMESPACE: namespace, PE_KUBE_CONTEXT: context,
      PE_CONNECTOR_KUBECONFIG: kubeconfig, PE_CONNECTOR_IMAGE: image } })
  const sshPods = JSON.parse(admin(['-n', namespace, 'get', 'pods', '-l',
    'app.kubernetes.io/name=power-evolve-qa-ssh', '-o', 'json'])).items
  if (sshPods.length !== 1 || sshPods[0].status?.phase !== 'Running'
    || !sshPods[0].status?.containerStatuses?.[0]?.ready) throw new Error('SSH fixture is not ready')
  const targetIp = sshPods[0].status.podIP
  const forbiddenIp = JSON.parse(admin(['-n', namespace, 'get', 'service',
    'power-evolve-forbidden-listener', '-o', 'json'])).spec.clusterIP
  const nodeIp = JSON.parse(admin(['get', 'nodes', '-o', 'json'])).items[0]?.status
    ?.addresses?.find((item) => item.type === 'InternalIP')?.address
  if (!targetIp || !forbiddenIp || !nodeIp) throw new Error('Required k3d IP was unavailable')
  const kube = await KubernetesClient.fromFile(kubeconfig)
  const probeLive = async () => {
    try {
      const status = await kube.call('GET', kube.proxyPath(namespace,
        'power-evolve-forbidden-listener', '/health'))
      return status?.healthy === true
    } catch (_probeUnavailable) { return false }
  }
  if (!await probeLive()) throw new Error('Forbidden listener is not live through the scoped proxy')
  orchestrator = new SshRunnerOrchestrator(kube, { namespace, image, runtimeClassName: 'gvisor',
    controlKey: randomBytes(32).toString('hex'), readyTimeoutMs: 90_000,
    platformIngressCidrs: [`${nodeIp}/32`], forbiddenProbe: { ip: forbiddenIp, port: 8080 },
    proveForbiddenListener: probeLive })
  const target = { ip: targetIp, port: 2222, username: 'qa', hostKeySha256 }
  const mismatchId = randomUUID()
  const mismatch = { ...target, hostKeySha256: `SHA256:${'A'.repeat(43)}` === hostKeySha256
    ? `SHA256:${'B'.repeat(43)}` : `SHA256:${'A'.repeat(43)}` }
  try {
    await orchestrator.prepare(mismatchId, mismatch)
    throw new Error('Wrong SSH host-key fingerprint was accepted')
  } catch (error) {
    if (error?.code !== 'connector_runner_canary_failed') throw error
  } finally { await orchestrator.cleanup(mismatchId) }
  console.log('Wrong host-key fingerprint: rejected before credential dispatch')

  activeCallId = randomUUID()
  const handle = await orchestrator.prepare(activeCallId, target)
  console.log('Allowed SSH target: credential-free canary accepted pinned host key')
  const podName = `pe-cr-${activeCallId.replaceAll('-', '')}`
  const probe = JSON.parse(admin(['-n', namespace, 'exec', podName, '-c', 'runner', '--',
    'node', '-e', tcpProbeSource, targetIp, '2222', forbiddenIp, '8080']))
  const listenerHealthy = await probeLive()
  if (probe.allowed !== 'connected' || !['denied', 'refused'].includes(probe.forbidden)
    || !listenerHealthy) throw new Error(`Runner TCP egress policy check failed (allowed=${probe.allowed}, forbidden=${probe.forbidden}, listenerHealthy=${listenerHealthy})`)
  console.log(`Runner TCP probe: allowed ${probe.allowed}; forbidden ${probe.forbidden} with listener healthy`)
  const request = { kind: 'ssh.execute', credential: { kind: 'password', password },
    command: 'qa:ping', timeoutMs: 10_000, maxOutputBytes: 1024 }
  const expectedDigest = orchestrator.digestFor(handle, request)
  let result = await orchestrator.dispatchFirst(handle, request)
  for (let i = 0; i < 100 && result.state === 'known' && result.status.state === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    result = await orchestrator.reconcile(handle, true, expectedDigest)
  }
  if (result.state !== 'known' || result.status.state !== 'succeeded'
    || result.status.result?.kind !== 'ssh.execute'
    || result.status.result?.stdout !== 'qa:ssh-ok\n' || result.status.result?.exitCode !== 0) {
    throw new Error(`SSH execution did not succeed: ${result.state === 'known'
      ? result.status.errorCode ?? result.status.state : result.reason}`)
  }
  console.log('Pinned SSH password authentication and fixed command: succeeded')
  console.log('Forbidden listener: independently healthy; Runner egress gate ready during dispatch')
  await approvedExecuteForTwoUsers(targetIp, hostKeySha256)
  if (retainedDir) {
    await writeFile(join(privateDir, 'ssh.json'), `${JSON.stringify({ kubeconfigFile: kubeconfig,
      namespace, image, runtimeClass: 'gvisor', ingressCidrs: `${nodeIp}/32`,
      destinationAllowlist: `${targetIp}:2222` }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    retainedReady = true
    console.log(`Retained isolated SSH trial fixture in ${namespace}; private configuration: ${privateDir}`)
  }
} finally {
  if (orchestrator && activeCallId) {
    try { await orchestrator.cleanup(activeCallId) }
    catch (_cleanupFailed) { console.error(retainedDir
      ? `Runner cleanup failed; inspect retained namespace ${namespace}`
      : 'Runner cleanup failed; namespace deletion follows') }
  }
  if (namespaceMayExist && !retainedDir) {
    try { admin(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=true', '--timeout=180s']) }
    catch (_cleanupFailed) { console.error(`Namespace cleanup failed: ${namespace}`) }
  }
  if (namespaceMayExist && retainedDir && !retainedReady) {
    console.error(`Retained incomplete SSH fixture for inspection: ${namespace}`)
  }
  if (!retainedDir) await rm(privateDir, { recursive: true, force: true })
}
