/** Disposable real Agent Sandbox drill across two k3d node containers and one shared POSIX volume. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const context = process.env.PE_S7B_KUBE_CONTEXT ?? 'k3d-pe-s7b-multinode'
const cluster = process.env.PE_S7B_CLUSTER ?? 'pe-s7b-multinode'
const volume = process.env.PE_S7B_VOLUME ?? 'pe-s7b-shared-posix'
const image = process.env.PE_S7B_RUNNER_IMAGE ?? 'pe-s7b-runner:local'
const nodeRootBase = process.env.PE_S7B_NODE_ROOT ?? '/var/lib/power-evolve-s7b'
const localVolume = process.env.PE_S7B_LOCAL_VOLUME
  ?? join(homedir(), 'OrbStack/docker/volumes', volume)
const trialScript = fileURLToPath(new URL('./trial.mjs', import.meta.url))
const accessScript = fileURLToPath(new URL('./prepare-sandbox-access.mjs', import.meta.url))
const name = `s7b-${randomBytes(4).toString('hex')}`
const namespace = `pe-${name}`
const privateDir = join(homedir(), '.config/power-evolve', `shared-host-${name}`)
const outputDir = join(root, '.artifacts/power-evolve', name)
const localRoot = join(localVolume, name)
const nodeRoot = `${nodeRootBase}/${name}`
const modelRequests = []

function run(binary, args, environment = process.env, timeout = 180_000) {
  const result = spawnSync(binary, args, { cwd: root, env: environment, encoding: 'utf8', timeout,
    maxBuffer: 2 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${binary} ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message).slice(-1200)}`)
  return result.stdout.trim()
}
const kube = (...args) => run('kubectl', ['--context', context, ...args])
const kubeJson = (...args) => JSON.parse(kube(...args, '-o', 'json'))
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
async function eventually(probe, accept, label, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs
  let last
  while (Date.now() < until) {
    last = await probe()
    if (accept(last)) return last
    await delay(400)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)?.slice(0, 500)}`)
}
function sse(response, modelName, command) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const events = [
    { type: 'message_start', message: { id: `s7b-${randomUUID()}`, model: modelName,
      usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: command
      ? { type: 'tool_use', id: `call_${randomUUID()}`, name: 'cloud_exec', input: { command } }
      : { type: 'text', text: '' } },
    ...(!command ? [{ type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'Execution result received.' } }] : []),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: command ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}
const model = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const last = body.messages.at(-1)
    const prompt = last?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    const command = prompt.startsWith('EXEC:') ? prompt.slice(5) : null
    modelRequests.push(command ? 'tool' : 'result')
    sse(response, body.model, command)
  } catch { response.destroy() }
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const modelPort = model.address().port
const portNames = ['PE_DATABASE_PORT', 'PE_HOST_PORT', 'PE_PLATFORM_PORT', 'PE_TARGET_PORT']
const portValues = await Promise.all(portNames.map(freePort))
assert.equal(new Set([...portValues, modelPort]).size, portValues.length + 1)
const ports = Object.fromEntries(portNames.map((key, index) => [key, String(portValues[index])]))
const env = { ...process.env, ...ports, PE_TRIAL_NAME: name, PE_PRIVATE_DIR: privateDir,
  PE_MODEL_URL: `http://127.0.0.1:${modelPort}/v1/messages`,
  PE_COMPOSE_EXTERNAL_NETWORK: process.env.PE_COMPOSE_EXTERNAL_NETWORK,
  PE_MCP_ENABLED: '0', PE_SSH_ENABLED: '0', PE_DEVICE_ENABLED: '0' }
const hostOrigin = `http://127.0.0.1:${ports.PE_HOST_PORT}`
const platformOrigin = `http://127.0.0.1:${ports.PE_PLATFORM_PORT}`
const serverNode = `k3d-${cluster}-server-0`, agentNode = `k3d-${cluster}-agent-0`

async function post(url, token, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok) throw new Error(`${new URL(url).pathname}: ${response.status} ${value.error ?? 'failed'}`)
  return value
}
const rpc = (token, method, request) => post(`${hostOrigin}/api/powerEvolve/${method}`, token, { request })
function trial(...args) { run(process.execPath, [trialScript, ...args], env) }
function activePod(userId) {
  const name = `pe-sb-${userId.replaceAll('-', '')}`
  try { return kubeJson('-n', namespace, 'get', 'pod', name) }
  catch (error) { if (error.message.includes('NotFound') || error.message.includes('not found')) return null; throw error }
}
async function completedExecution(db, operationId) {
  return eventually(async () => (await db.query(
    'SELECT id,state,result,pod_uid,session_id FROM pe_cloud_executions WHERE operation_id=$1',
    [operationId])).rows[0], row => row?.state === 'succeeded', 'cloud execution')
}
async function publishedSkill(token) {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-s7b-skill-'))
  try {
    const skill = join(temporary, 's7b-skill')
    await mkdir(join(skill, 'scripts'), { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: s7b-skill\ndescription: Local mount probe\n---\nRun scripts/probe.sh in the cloud sandbox.\n')
    await writeFile(join(skill, 'skill-package.json'), JSON.stringify({ schemaVersion: 1, version: '1.0.0' }))
    await writeFile(join(skill, 'scripts/probe.sh'), '#!/bin/sh\nprintf "s7b-skill-mounted\\n"\n')
    await chmod(join(skill, 'scripts/probe.sh'), 0o755)
    const archive = join(temporary, 'skill.zip')
    const zipped = spawnSync('zip', ['-q', '-r', '-X', archive, 's7b-skill'], {
      cwd: temporary, encoding: 'utf8' })
    if (zipped.status !== 0) throw new Error(`Skill ZIP creation failed: ${zipped.stderr}`)
    const bytes = await readFile(archive)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const issued = await rpc(token, 'skillsUploadTicket', { requestId: randomUUID(),
      sizeBytes: bytes.length, sha256: digest })
    assert.equal(issued.state, 'pending')
    const response = await fetch(issued.uploadUrl, { method: 'POST', headers: {
      origin: hostOrigin, authorization: `Bearer ${issued.ticket}`, 'content-type': 'application/zip',
    }, body: bytes })
    if (response.status !== 201) throw new Error(`Skill upload failed: ${response.status} ${(await response.text()).slice(0, 200)}`)
    const item = await response.json()
    assert.equal(item.packageDigest, digest)
    return digest
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

let namespaceCreated = false, started = false, safeToCleanup = false, db
await mkdir(privateDir, { recursive: true, mode: 0o700 })
try {
  assert.equal(kubeJson('get', 'nodes').items.length, 2, 'S7b needs exactly two k3d nodes')
  for (const node of [serverNode, agentNode]) {
    assert.equal(kubeJson('get', 'node', node).status.conditions.find(item => item.type === 'Ready')?.status, 'True')
    const mount = JSON.parse(run('docker', ['inspect', `k3d-${cluster}-${node === serverNode ? 'server' : 'agent'}-0`,
      '--format', '{{json .Mounts}}']))
    assert(mount.some(item => item.Name === volume && item.Destination === nodeRootBase))
  }
  kube('get', 'crd', 'sandboxes.agents.x-k8s.io')
  kube('get', 'runtimeclass', 'gvisor')
  kube('-n', 'agent-sandbox-system', 'get', 'deployment', 'agent-sandbox-controller')
  kube('create', 'namespace', namespace)
  namespaceCreated = true
  await mkdir(join(localRoot, 'workspaces'), { recursive: true, mode: 0o700 })
  await mkdir(join(localRoot, 'homes'), { recursive: true, mode: 0o700 })
  await mkdir(join(localRoot, 'skill-packages'), { recursive: true, mode: 0o700 })
  await writeFile(join(privateDir, 'sandbox.json'), JSON.stringify({
    workspaceRoot: join(localRoot, 'workspaces'), kubeconfigFile: '', namespace, image,
    localRoot, nodeRoot, idleMs: 25_000,
  }, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(privateDir, 'model.env'), `DEEPSEEK_API_KEY=${randomBytes(32).toString('base64url')}\n`,
    { mode: 0o600 })
  run(process.execPath, [accessScript], { ...env, PE_KUBE_CONTEXT: context,
    PE_SANDBOX_NAMESPACE: namespace })
  await readFile(join(root, 'products/power-evolve/cloud-web/dist/asset-list.json'))
  started = true
  trial('up')
  db = new Client({ connectionString: (await readFile(join(privateDir, 'database-url'), 'utf8')).trim() })
  await db.connect()
  const users = JSON.parse(await readFile(join(privateDir, 'users.json'), 'utf8'))
  const credentials = await Promise.all(users.map(async user =>
    (await post(`${platformOrigin}/identity/login`, null,
      { username: user.username, password: user.password })).token))
  const identities = await Promise.all(credentials.map(token => rpc(token, 'me', {})))
  const [alice, bob] = identities
  assert.notEqual(alice.userId, bob.userId)
  const skillDigest = await publishedSkill(credentials[0])
  const session = await rpc(credentials[0], 'create', { requestId: randomUUID() })
  const bobSession = await rpc(credentials[1], 'create', { requestId: randomUUID() })
  session.workspaceId = (await db.query('SELECT workspace_id FROM pe_sessions WHERE id=$1',
    [session.sessionId])).rows[0].workspace_id
  bobSession.workspaceId = (await db.query('SELECT workspace_id FROM pe_sessions WHERE id=$1',
    [bobSession.sessionId])).rows[0].workspace_id

  kube('uncordon', agentNode)
  kube('cordon', serverNode)
  const firstCommand = `set -eu\ncat > calc.py <<'PY'\ndef double(value):\n    return value * 2\nPY\ncat > test_calc.py <<'PY'\nimport unittest\nfrom calc import double\nclass TestCalc(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(21), 42)\nPY\npython3 -m unittest -q\ngit init -q\ngit add calc.py test_calc.py\ngit -c user.name=S7b -c user.email=s7b@example.invalid commit -qm initial\nprintf 'home-survived\\n' > /home/agent/s7b-home.txt\nsh /opt/power-evolve/skills/sha256/${skillDigest}/skill/scripts/probe.sh\ngit rev-parse HEAD`
  const first = await rpc(credentials[0], 'prompt', { sessionId: session.sessionId,
    requestId: randomUUID(), text: `EXEC:${firstCommand}` })
  const firstExecution = await completedExecution(db, first.operationId)
  assert.equal(firstExecution.result.exitCode, 0)
  assert.match(firstExecution.result.stdout, /s7b-skill-mounted/)
  const firstPod = activePod(alice.userId)
  assert(firstPod)
  assert.equal(firstPod.spec.nodeName, agentNode)
  assert.equal(firstPod.metadata.uid, firstExecution.pod_uid)
  assert.equal(firstPod.spec.runtimeClassName, 'gvisor')
  assert(firstPod.spec.volumes.some(item => item.name === 'workspace'
    && item.hostPath.path === `${nodeRoot}/workspaces/${session.workspaceId}`))
  assert(firstPod.spec.volumes.some(item => item.name === 'home'
    && item.hostPath.path === `${nodeRoot}/homes/${alice.userId}`))
  assert(firstPod.spec.volumes.some(item => item.name === 'skill-packages'
    && item.hostPath.path === `${nodeRoot}/skill-packages/${alice.userId}`))
  assert.equal(firstPod.spec.containers[0].volumeMounts.find(item => item.name === 'skill-packages')?.readOnly,
    true)
  const source = await rpc(credentials[0], 'filesRead', { sessionId: session.sessionId, path: 'calc.py' })
  assert.match(Buffer.from(source.data, 'base64').toString('utf8'), /return value \* 2/)

  const bobCommand = `set -eu\ntest ! -e /workspace/calc.py\ntest ! -e /home/agent/s7b-home.txt\ntest ! -e /opt/power-evolve/skills/sha256/${skillDigest}\nprintf 'bob-only\\n' > bob.txt\nprintf 'bob-isolated\\n'`
  const bobPrompt = await rpc(credentials[1], 'prompt', { sessionId: bobSession.sessionId,
    requestId: randomUUID(), text: `EXEC:${bobCommand}` })
  const bobExecution = await completedExecution(db, bobPrompt.operationId)
  assert.equal(bobExecution.result.exitCode, 0)
  assert.match(bobExecution.result.stdout, /bob-isolated/)
  const bobPod = activePod(bob.userId)
  assert(bobPod)
  assert.equal(bobPod.spec.nodeName, agentNode)
  assert(bobPod.spec.volumes.some(item => item.name === 'workspace'
    && item.hostPath.path.endsWith(`/${bobSession.workspaceId}`)))
  assert(!bobPod.spec.volumes.some(item => item.hostPath?.path?.includes(alice.userId)
    || item.hostPath?.path?.includes(session.workspaceId)))
  console.log('Real Python test, Git commit, Home and published Skill ran on agent node; Bob mount isolation passed')

  const retired = await eventually(async () => (await db.query(
    'SELECT state,stop_pod_uid,stop_evidence FROM pe_sandbox_instances WHERE session_id=$1',
    [session.sessionId])).rows[0], row => row?.state === 'deleted', 'Alice Pod retirement', 150_000)
  assert.equal(retired.stop_pod_uid, firstPod.metadata.uid)
  assert.equal(retired.stop_evidence.status, 'KUBELET_STOPPED')
  assert.equal(retired.stop_evidence.podUid, firstPod.metadata.uid)
  assert.equal(activePod(alice.userId), null)
  assert.equal((await db.query('SELECT state FROM pe_mount_slots WHERE user_id=$1',
    [alice.userId])).rows[0].state, 'free')
  kube('uncordon', serverNode)
  kube('cordon', agentNode)
  const secondCommand = `set -eu\npython3 -m unittest -q\ntest "$(cat /home/agent/s7b-home.txt)" = home-survived\nsh /opt/power-evolve/skills/sha256/${skillDigest}/skill/scripts/probe.sh\ngit log -1 --format=%s\nprintf 'after-handoff\\n' >> calc.py\ngit add calc.py\ngit -c user.name=S7b -c user.email=s7b@example.invalid commit -qm handoff\ngit rev-list --count HEAD`
  const second = await rpc(credentials[0], 'prompt', { sessionId: session.sessionId,
    requestId: randomUUID(), text: `EXEC:${secondCommand}` })
  const secondExecution = await completedExecution(db, second.operationId)
  assert.equal(secondExecution.result.exitCode, 0)
  assert.match(secondExecution.result.stdout, /s7b-skill-mounted/)
  assert.match(secondExecution.result.stdout, /initial/)
  assert.match(secondExecution.result.stdout, /\n2\n?$/)
  const secondPod = activePod(alice.userId)
  assert(secondPod)
  assert.equal(secondPod.spec.nodeName, serverNode)
  assert.notEqual(secondPod.metadata.uid, firstPod.metadata.uid)
  assert.equal(secondPod.metadata.uid, secondExecution.pod_uid)
  const after = await rpc(credentials[0], 'filesRead', { sessionId: session.sessionId, path: 'calc.py' })
  assert.match(Buffer.from(after.data, 'base64').toString('utf8'), /after-handoff/)
  const denied = await fetch(`${hostOrigin}/api/powerEvolve/filesRead`, { method: 'POST',
    headers: { authorization: `Bearer ${credentials[1]}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request: { sessionId: session.sessionId, path: 'calc.py' } }) })
  assert.equal(denied.status, 404)
  await eventually(async () => (await db.query('SELECT state FROM pe_operations WHERE source_execution_id=$1',
    [secondExecution.id])).rows[0]?.state, value => value === 'completed', 'same Session continuation')
  console.log('Exact Pod UID stop proof preceded a new Sandbox on server node; Git, files, Home and Skill survived')

  const finalStops = await eventually(async () => (await db.query(
    'SELECT session_id,state,stop_pod_uid,stop_evidence FROM pe_sandbox_instances WHERE session_id=ANY($1::uuid[])',
    [[session.sessionId, bobSession.sessionId]])).rows,
  rows => rows.length === 2 && rows.every(row => row.state === 'deleted'),
  'all writable Pods retired', 150_000)
  assert.equal(finalStops.find(row => row.session_id === session.sessionId).stop_pod_uid,
    secondPod.metadata.uid)
  assert.equal(finalStops.find(row => row.session_id === bobSession.sessionId).stop_pod_uid,
    bobPod.metadata.uid)
  assert(finalStops.every(row => row.stop_evidence.status === 'KUBELET_STOPPED'))
  await eventually(() => kubeJson('-n', namespace, 'get', 'pods').items,
    pods => pods.length === 0, 'all retained Pods deleted')
  safeToCleanup = true

  const report = { scenario: 'local-s7b-two-k3d-nodes', trialName: name, cluster, volume,
    nodeRoot, runtimeClass: 'gvisor',
    physicalHostBoundary: 'two k3d node containers on one host and one Docker POSIX volume',
    sessionId: session.sessionId, workspaceId: session.workspaceId, bobWorkspaceId: bobSession.workspaceId,
    first: { node: firstPod.spec.nodeName, podUid: firstPod.metadata.uid,
      executionId: firstExecution.id, exitCode: firstExecution.result.exitCode },
    retired: { state: retired.state, stopPodUid: retired.stop_pod_uid,
      status: retired.stop_evidence.status },
    second: { node: secondPod.spec.nodeName, podUid: secondPod.metadata.uid,
      executionId: secondExecution.id, exitCode: secondExecution.result.exitCode },
    bob: { node: bobPod.spec.nodeName, podUid: bobPod.metadata.uid,
      executionId: bobExecution.id, exitCode: bobExecution.result.exitCode },
    skillDigest, modelCalls: modelRequests.length, image,
    finalStops: finalStops.map(row => ({ sessionId: row.session_id, podUid: row.stop_pod_uid,
      status: row.stop_evidence.status })) }
  await writeFile(join(outputDir, 's7b-evidence.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`S7b local two-node drill passed: ${join(outputDir, 's7b-evidence.json')}`)
} finally {
  try { kube('uncordon', serverNode) } catch {}
  try { kube('uncordon', agentNode) } catch {}
  await db?.end().catch(() => {})
  let podsRemain = true
  if (namespaceCreated) {
    try { podsRemain = kubeJson('-n', namespace, 'get', 'pods').items.length > 0 } catch {}
  } else podsRemain = false
  const cleanupAllowed = safeToCleanup || !podsRemain
  if (!cleanupAllowed) console.error(`Retained ${namespace} and ${privateDir}: a writable Pod still needs stop reconciliation`)
  if (started && cleanupAllowed && process.env.PE_S7B_KEEP_TRIAL !== '1') {
    try { trial('stop') } catch (error) { console.error(`Trial stop failed: ${error.message}`) }
    const args = ['compose', '-p', `pe-shared-host-${name}`, '-f', 'products/power-evolve/compose.yaml',
      ...(env.PE_COMPOSE_EXTERNAL_NETWORK ? ['-f', 'products/power-evolve/compose.external-network.yaml'] : []),
      'down', '-v', '--remove-orphans']
    try { run('docker', args, env) } catch (error) { console.error(`PG cleanup failed: ${error.message}`) }
  }
  let namespaceRemoved = !namespaceCreated
  if (namespaceCreated && cleanupAllowed && process.env.PE_S7B_KEEP_TRIAL !== '1') {
    try { kube('delete', 'namespace', namespace, '--wait=true', '--timeout=90s'); namespaceRemoved = true }
    catch (error) { console.error(`Namespace cleanup failed: ${error.message}`) }
  }
  if (cleanupAllowed && namespaceRemoved && process.env.PE_S7B_KEEP_TRIAL !== '1') {
    await rm(privateDir, { recursive: true, force: true })
    await rm(localRoot, { recursive: true, force: true })
  }
  await new Promise(resolve => model.close(resolve))
}
