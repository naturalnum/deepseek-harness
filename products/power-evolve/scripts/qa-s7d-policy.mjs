/** Exercise rendered service identities and network policy in disposable namespaces. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { buildManifests } from '../deploy/render.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const context = process.env.PE_S7D_KUBE_CONTEXT ?? 'k3d-pe-s7b-multinode'
const image = process.env.PE_S7D_PROBE_IMAGE ?? 'pe-s7b-runner:local'
const name = `s7d-policy-${randomBytes(4).toString('hex')}`
const app = `${name}-app`, runner = `${name}-runner`, external = `${name}-external`
const namespaces = [app, runner, external]
const output = join(root, '.artifacts/power-evolve', name)
const created = []

function kubectl(args, input) {
  const result = spawnSync('kubectl', ['--context', context, ...args], {
    encoding: 'utf8', input, timeout: 30_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`kubectl ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout).slice(-1000)}`)
  }
  return result.stdout.trim()
}
const apply = items => kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items }))
const get = (namespace, kind, value) => JSON.parse(kubectl([
  ...(namespace ? ['-n', namespace] : []), 'get', kind, ...(value ? [value] : []), '-o', 'json',
]))
async function eventually(probe, accept, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (accept(last)) return last
    await delay(500)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`)
}
function pod(namespace, podName, nodeName, ports, labels, serviceAccountName) {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: podName, namespace, labels },
    spec: { nodeName, restartPolicy: 'Never', terminationGracePeriodSeconds: 1,
      automountServiceAccountToken: serviceAccountName === 'power-evolve-platform',
      ...(serviceAccountName ? { serviceAccountName } : {}),
      containers: [{ name: 'probe', image, imagePullPolicy: 'Never',
        command: ['node', '-e', `for (const port of ${JSON.stringify(ports)}) require('node:http').createServer((q,r)=>r.end('fixture')).listen(port,'0.0.0.0')`],
        readinessProbe: { tcpSocket: { port: ports[0] }, initialDelaySeconds: 1, periodSeconds: 1 },
        resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '96Mi' } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'], add: ['NET_BIND_SERVICE'] } },
      }],
    } }
}
function execNode(namespace, podName, code) {
  return JSON.parse(kubectl(['-n', namespace, 'exec', podName, '--', 'node', '-e', code]))
}
function connect(namespace, podName, host, port) {
  return execNode(namespace, podName, `const s=require('node:net').connect(${JSON.stringify({ host, port })});
    let done=false; const end=(ok,code)=>{if(done)return;done=true;console.log(JSON.stringify({ok,code}));s.destroy()};
    s.setTimeout(1500,()=>end(false,'TIMEOUT'));s.once('connect',()=>end(true,'CONNECTED'));s.once('error',e=>end(false,e.code))`)
}
function can(namespace, accountNamespace, account, verb, resource) {
  const result = spawnSync('kubectl', ['--context', context, '-n', namespace, 'auth', 'can-i', verb, resource,
    `--as=system:serviceaccount:${accountNamespace}:${account}`], { encoding: 'utf8', timeout: 10_000 })
  if (result.error || ![0, 1].includes(result.status)) throw new Error('RBAC probe failed')
  assert(['yes', 'no'].includes(result.stdout.trim()))
  return result.stdout.trim() === 'yes'
}

await mkdir(output, { recursive: true })
try {
  const nodes = get(null, 'nodes').items.filter(node => node.status.conditions?.some(condition =>
    condition.type === 'Ready' && condition.status === 'True'))
  assert(nodes.length >= 2, 'This probe requires two Ready Kubernetes nodes')
  const [nodeA, nodeB] = nodes.map(node => node.metadata.name)
  for (const namespace of namespaces) {
    kubectl(['create', 'namespace', namespace])
    created.push(namespace)
  }
  const values = JSON.parse(await readFile(new URL('../deploy/values.example.json', import.meta.url), 'utf8'))
  Object.assign(values, { namespace: app, runnerNamespace: runner,
    ingressNamespace: external, ingressPodLabels: { 'pe-probe': 'ingress' }, imagePullSecretName: '' })
  const authority = buildManifests(values).filter(item =>
    ['ServiceAccount', 'Role', 'RoleBinding'].includes(item.kind))
  apply(authority)
  const labels = role => ({ 'app.kubernetes.io/name': `power-evolve-${role}` })
  apply([
    pod(app, 'host', nodeA, [18880], labels('host'), 'power-evolve-host'),
    pod(app, 'platform', nodeB, [18881], labels('platform'), 'power-evolve-platform'),
    pod(runner, 'runner', nodeA, [8080], labels('sandbox'), 'power-evolve-runner'),
    pod(external, 'target', nodeB, [443, 5432, 18080], { 'pe-probe': 'target' }),
    pod(external, 'ingress', nodeB, [18080], { 'pe-probe': 'ingress' }),
    pod(external, 'bystander', nodeA, [18080], { 'pe-probe': 'bystander' }),
  ])
  const pods = {}
  for (const [namespace, podName] of [[app, 'host'], [app, 'platform'], [runner, 'runner'],
    [external, 'target'], [external, 'ingress'], [external, 'bystander']]) {
    pods[podName] = await eventually(() => get(namespace, 'pod', podName), value =>
      value.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'),
    `${podName} ready`)
  }
  const ip = podName => pods[podName].status.podIP
  const cases = [
    ['ingress-to-host', external, 'ingress', 'host', 18880, true],
    ['ingress-to-platform', external, 'ingress', 'platform', 18881, true],
    ['bystander-to-host', external, 'bystander', 'host', 18880, false],
    ['bystander-to-platform', external, 'bystander', 'platform', 18881, false],
    ['host-to-platform', app, 'host', 'platform', 18881, true],
    ['host-to-postgres', app, 'host', 'target', 5432, false],
    ['host-to-model', app, 'host', 'target', 443, false],
    ['platform-to-postgres', app, 'platform', 'target', 5432, true],
    ['platform-to-model', app, 'platform', 'target', 443, true],
    ['platform-to-unlisted-port', app, 'platform', 'target', 18080, false],
    ['runner-to-platform', runner, 'runner', 'platform', 18881, false],
    ['host-to-runner', app, 'host', 'runner', 8080, false],
    ['platform-to-runner-direct', app, 'platform', 'runner', 8080, false],
    ['configured-proxy-to-runner', external, 'ingress', 'runner', 8080, true],
    ['bystander-to-runner', external, 'bystander', 'runner', 8080, false],
    ['runner-to-model', runner, 'runner', 'target', 443, false],
  ]
  // Establish every destination first so a dead fixture cannot masquerade as policy denial.
  for (const [label, namespace, from, to, port] of cases) {
    assert.equal(connect(namespace, from, ip(to), port).ok, true, `${label} baseline`)
  }
  values.network.postgresCidrs = [`${ip('target')}/32`]
  values.network.modelCidrs = [`${ip('target')}/32`]
  values.network.connectorCidrs = [`${ip('target')}/32`]
  values.network.runnerProxySourceCidrs = [`${ip('ingress')}/32`]
  values.network.sandboxEgressCidrs = []
  const policies = buildManifests(values).filter(item => item.kind === 'NetworkPolicy')
  apply(policies)
  const flows = []
  for (const [label, namespace, from, to, port, expected] of cases) {
    const result = await eventually(() => connect(namespace, from, ip(to), port),
      value => value.ok === expected, `${label} policy`)
    flows.push({ label, allowed: result.ok, outcome: result.code })
  }
  const dns = []
  for (const [namespace, podName] of [[app, 'host'], [app, 'platform'], [runner, 'runner']]) {
    const result = execNode(namespace, podName,
      "require('node:dns').lookup('kubernetes.default.svc.cluster.local',(e,a)=>{console.log(JSON.stringify({ok:!e}));process.exitCode=e?1:0})")
    assert.equal(result.ok, true, `${podName} DNS`)
    const token = execNode(namespace, podName,
      "console.log(JSON.stringify({present:require('node:fs').existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')}))")
    assert.equal(token.present, podName === 'platform', `${podName} projected API credential`)
    dns.push({ role: podName, dns: true, serviceAccountToken: token.present })
  }
  const rbac = []
  for (const [accountNamespace, account, namespace, verb, resource, expected] of [
    [app, 'power-evolve-platform', runner, 'list', 'sandboxes.agents.x-k8s.io', true],
    [app, 'power-evolve-platform', runner, 'create', 'sandboxes.agents.x-k8s.io', true],
    [app, 'power-evolve-platform', runner, 'patch', 'pods', true],
    [app, 'power-evolve-platform', runner, 'list', 'secrets', false],
    [app, 'power-evolve-platform', runner, 'watch', 'sandboxes.agents.x-k8s.io', false],
    [app, 'power-evolve-platform', runner, 'list', 'pods', false],
    [app, 'power-evolve-platform', runner, 'create', 'pods', false],
    [app, 'power-evolve-platform', app, 'list', 'sandboxes.agents.x-k8s.io', false],
    [app, 'power-evolve-platform', external, 'list', 'sandboxes.agents.x-k8s.io', false],
    [app, 'power-evolve-platform', app, 'get', 'secrets', false],
    [app, 'power-evolve-host', runner, 'get', 'secrets', false],
    [app, 'power-evolve-host', runner, 'list', 'sandboxes.agents.x-k8s.io', false],
    [runner, 'power-evolve-runner', runner, 'get', 'pods', false],
    [runner, 'power-evolve-runner', runner, 'list', 'sandboxes.agents.x-k8s.io', false],
  ]) {
    const allowed = can(namespace, accountNamespace, account, verb, resource)
    assert.equal(allowed, expected, `${account} ${verb} ${resource}`)
    rbac.push({ accountNamespace, account, namespace, verb, resource, allowed })
  }
  values.network.sandboxEgressCidrs = [`${ip('target')}/32`]
  apply(buildManifests(values).filter(item => item.kind === 'NetworkPolicy' && item.metadata.name === 'allow-runner'))
  await eventually(() => connect(runner, 'runner', ip('target'), 443), value => value.ok,
    'configured runner HTTPS egress')
  assert.equal(connect(runner, 'runner', ip('target'), 5432).ok, false)
  for (const port of [443, 5432, 18080]) assert.equal(connect(external, 'ingress', ip('target'), port).ok, true)
  const report = { scenario: 's7d-rendered-network-and-rbac', context,
    kubernetesNodes: [nodeA, nodeB], physicalMachinesVerified: false,
    applicationPods: 'Node TCP/HTTP fixtures; not the DSH application',
    runnerProxySource: 'explicit fixture Pod IP; real API proxy source still requires target-cluster validation',
    workloadImages: Object.fromEntries(Object.entries(pods).map(([key, value]) =>
      [key, value.status.containerStatuses[0].imageID])), flows, dns, rbac,
    optionalRunnerEgress: { configured443Allowed: true, unlisted5432Denied: true },
    allDestinationsStillAlive: true }
  await writeFile(join(output, 'policy-evidence.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Rendered policies and RBAC passed ${flows.length} flow checks; report ${join(output, 'policy-evidence.json')}`)
} finally {
  for (const namespace of created.reverse()) {
    kubectl(['delete', 'namespace', namespace, '--wait=false'])
    await eventually(() => {
      const result = spawnSync('kubectl', ['--context', context, 'get', 'namespace', namespace,
        '--ignore-not-found', '-o', 'name'], { encoding: 'utf8', timeout: 10_000 })
      if (result.status !== 0) throw new Error('Could not confirm probe namespace cleanup')
      return result.stdout.trim()
    }, value => !value, `${namespace} cleanup`, 60_000)
  }
}
