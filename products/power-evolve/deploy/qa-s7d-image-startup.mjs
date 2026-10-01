/** Disposable image startup drill. It never targets a configured trial or Kubernetes cluster. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/**
 * Create disposable seed logins and the required account-management policy for the same model catalog.
 * @returns Seed users and serialized private account files; generated passwords must never be logged.
 */
export function createStartupAccountFiles() {
  const models = [{ id: 'deepseek-flash', label: 'Flash', maxTokens: 4096 }]
  const users = ['alice', 'bob'].map((username, index) => ({ username,
    password: randomBytes(24).toString('base64url'),
    settings: { model: 'deepseek-flash', maxTokens: index ? 1536 : 2048, revision: 1 }, models }))
  const accountManagement = { maxUsers: users.length, models,
    initialSettings: { model: 'deepseek-flash', maxTokens: 2048 } }
  return { users, files: { 'users.json': JSON.stringify(users),
    'account-management.json': JSON.stringify(accountManagement) } }
}

/**
 * Bound every disposable container's CPU, memory, and total memory plus swap.
 * @param role Python probe, PostgreSQL, Platform, or Host container role.
 * @returns Docker run arguments; unknown roles throw before a container can be started.
 */
export function disposableContainerLimits(role) {
  const limits = { probe: ['0.5', '128m'], pg: ['0.5', '512m'],
    platform: ['1', '1g'], host: ['1', '1g'] }
  if (!Object.hasOwn(limits, role)) throw new Error(`Unknown disposable container role: ${role}`)
  const [cpus, memory] = limits[role]
  return ['--cpus', cpus, '--memory', memory, '--memory-swap', memory]
}

async function main() {
  const imageIndex = process.argv.indexOf('--image')
  const image = imageIndex >= 0 ? process.argv[imageIndex + 1] : ''
  const expectMissingPython = process.argv.includes('--expect-missing-python')
  if (!image || image.startsWith('-')) throw new Error('Use --image IMAGE [--expect-missing-python]')
  const suffix = randomBytes(5).toString('hex')
  const prefix = `pe-s7d-image-qa-${suffix}`
  const names = { network: prefix, pg: `${prefix}-pg`, platform: `${prefix}-platform`,
    host: `${prefix}-host`, data: `${prefix}-data` }
  const temporary = await mkdtemp(join(tmpdir(), 'pe-s7d-image-qa-'))
  const privatePlatform = join(temporary, 'platform'), privateHost = join(temporary, 'host')
  const serviceAccount = join(temporary, 'service-account')
  const password = randomBytes(24).toString('base64url')
  const workerToken = randomBytes(32).toString('base64url')
  const { users, files: accountFiles } = createStartupAccountFiles()
  const hostOrigin = 'https://host.qa.invalid', platformOrigin = 'https://platform.qa.invalid'
  const checked = []

  function docker(args, timeout = 120_000, allowFailure = false) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })
    if (!allowFailure && result.status !== 0) {
      throw new Error(`docker ${args[0]} failed (${result.status ?? result.signal}): ${(result.stderr || result.stdout).slice(-500)}`)
    }
    return result
  }
  const secret = () => randomBytes(32).toString('base64url')
  async function waitFor(check, label, timeout = 45_000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const result = await check()
      if (result) return result
      await delay(400)
    }
    throw new Error(`${label} did not become available`)
  }
  function port(name, containerPort) {
    const value = docker(['port', name, `${containerPort}/tcp`]).stdout.trim().split('\n')[0]
    const number = Number(value?.slice(value.lastIndexOf(':') + 1))
    if (!Number.isInteger(number) || number < 1) throw new Error(`Unmapped ${name} port`)
    return number
  }
  async function response(url, options) {
    try { return await fetch(url, { ...options, signal: AbortSignal.timeout(1200) }) }
    catch (_unavailable) { return null }
  }
  async function post(url, body, token) {
    const result = await response(url, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    if (!result) throw new Error(`POST ${new URL(url).pathname} unavailable`)
    const data = await result.json()
    assert.equal(result.status, 200, `${new URL(url).pathname}: ${JSON.stringify(data).slice(0, 200)}`)
    return data
  }
  function env(args) { return Object.entries(args).flatMap(([key, value]) => ['-e', `${key}=${value}`]) }
  function common(role, secretDir) {
    const uid = role === 'host' ? 10001 : 0
    return [...disposableContainerLimits(role), '--network', names.network, '--read-only', '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges',
      '--tmpfs', `/var/lib/dsh:rw,nosuid,size=64m,uid=${uid},gid=${uid},mode=0700`,
      // DSH's native addon loader stages its .node file under /tmp before dlopen.
      // Kubernetes emptyDir permits execution; Docker tmpfs defaults to noexec.
      '--tmpfs', `/tmp:rw,exec,nosuid,size=256m,uid=${uid},gid=${uid},mode=1777`,
      '--mount', `type=bind,src=${secretDir},dst=/run/power-evolve/private,readonly`,
      ...env({ DSH_HOME: '/var/lib/dsh', PE_PRIVATE_DIR: '/run/power-evolve/private',
        PE_HOST_PUBLIC_ORIGIN: hostOrigin, PE_PLATFORM_PUBLIC_ORIGIN: platformOrigin })]
  }
  function mounts(name) { return JSON.parse(docker(['inspect', name, '--format', '{{json .Mounts}}']).stdout) }
  function createIsolatedNetwork() {
    for (let attempt = 0; attempt < 32; attempt++) {
      const subnet = `10.249.${randomBytes(1)[0]}.0/24`
      const result = docker(['network', 'create', '--subnet', subnet, names.network], 30_000, true)
      if (result.status === 0) return
      if (!/overlap|already allocated|already exists/u.test(result.stderr)) {
        throw new Error(`Cannot create disposable network: ${result.stderr.trim().slice(-300)}`)
      }
    }
    throw new Error('No isolated Docker subnet is available')
  }

  try {
    const python = docker(['run', '--rm', ...disposableContainerLimits('probe'),
      '--entrypoint', 'sh', image, '-c', 'command -v python3'], 30_000, true)
    if (expectMissingPython) assert.notEqual(python.status, 0, 'Baseline unexpectedly includes python3')
    else assert.equal(python.status, 0, 'Runtime image has no python3')
    checked.push(expectMissingPython ? 'baseline runtime lacks python3' : 'runtime includes python3')

    await mkdir(privatePlatform, { mode: 0o700 })
    await mkdir(privateHost, { mode: 0o755 })
    await mkdir(serviceAccount, { mode: 0o755 })
    const credentials = { 'database-url': `postgres://postgres:${password}@${names.pg}:5432/power_evolve_qa`,
      'worker-token': workerToken, 'model-key': secret(), 'connector-key': secret(),
      'runner-key': secret(), ...accountFiles }
    for (const [name, value] of Object.entries(credentials)) {
      await writeFile(join(privatePlatform, name), value, { mode: 0o600 })
    }
    await writeFile(join(privateHost, 'worker-token'), workerToken, { mode: 0o444 })
    await chmod(join(privateHost, 'worker-token'), 0o444)
    await writeFile(join(serviceAccount, 'ca.crt'), 'local-startup-probe-ca\n', { mode: 0o444 })
    await writeFile(join(serviceAccount, 'token'), 'local-startup-probe-token\n', { mode: 0o444 })

    createIsolatedNetwork()
    docker(['volume', 'create', names.data])
    docker(['run', '-d', '--name', names.pg, ...disposableContainerLimits('pg'), '--network', names.network,
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=power_evolve_qa',
      'postgres:17-bookworm'])
    await waitFor(() => docker(['exec', names.pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'power_evolve_qa'],
      10_000, true).status === 0, 'isolated PostgreSQL')
    checked.push('isolated real PostgreSQL ready')

    docker(['run', '-d', '--name', names.platform, ...common('platform', privatePlatform),
      '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER',
      '--mount', `type=volume,src=${names.data},dst=/data`,
      '--mount', `type=bind,src=${serviceAccount},dst=/var/run/secrets/kubernetes.io/serviceaccount,readonly`,
      '-p', '127.0.0.1::18881', ...env({ PE_SANDBOX_NAMESPACE: `${prefix}-runners`,
        PE_SANDBOX_IMAGE: `runner@sha256:${'a'.repeat(64)}`,
        PE_SANDBOX_VOLUME_CLAIM: `${prefix}-runner-pvc`,
        PE_MODEL_URL: 'https://model.qa.invalid/v1/messages',
        PE_CONNECTOR_URL: 'https://connector.qa.invalid/v1',
        KUBERNETES_SERVICE_HOST: '127.0.0.1', KUBERNETES_SERVICE_PORT: '443' }),
      image, 'node', 'products/power-evolve/deploy/start.mjs', 'platform'])
    const platformUrl = `http://127.0.0.1:${port(names.platform, 18881)}`
    if (expectMissingPython) {
      await waitFor(() => /workspace_unavailable|python3|PlatformError/u.test(
        docker(['logs', names.platform], 10_000, true).stderr), 'baseline SafePosix failure')
      const health = await response(`${platformUrl}/health`)
      assert.notEqual(health?.status, 200)
      checked.push('baseline Platform startup fails in SafePosix')
      console.log(JSON.stringify({ image, expectedFailure: true, checks: checked }, null, 2))
      process.exitCode = 0
    } else {
      await waitFor(async () => {
        const result = await response(`${platformUrl}/health`)
        return result?.ok && (await result.json()).ready === true
      }, 'Platform /health', 60_000)
      const live = await response(`${platformUrl}/live`)
      assert.equal(live?.status, 200)
      checked.push('Platform /health and /live with real PostgreSQL')

      docker(['run', '-d', '--name', names.host, ...common('host', privateHost),
        '--user', '10001:10001', '-p', '127.0.0.1::18880',
        ...env({ PE_PLATFORM_INTERNAL_URL: `http://${names.platform}:18881`,
          PE_NATIVE_WEB_DIST: '/opt/power-evolve/products/power-evolve/cloud-web/dist' }),
        image, 'node', 'products/power-evolve/deploy/start.mjs', 'host'])
      const hostUrl = `http://127.0.0.1:${port(names.host, 18880)}`
      await waitFor(async () => {
        const result = await response(`${hostUrl}/health`)
        return result?.ok && (await result.json()).ready === true
      }, 'Host /health', 60_000)
      assert.equal(docker(['exec', names.host, 'id', '-u']).stdout.trim(), '10001')
      assert.equal(docker(['exec', names.host, 'test', '-e', '/run/power-evolve/private/database-url'],
        10_000, true).status, 1)
      assert.equal(docker(['exec', names.host, 'test', '-e', '/data'], 10_000, true).status, 1)
      assert.equal(docker(['exec', names.host, 'test', '-e',
        '/var/run/secrets/kubernetes.io/serviceaccount/token'], 10_000, true).status, 1)
      assert.equal(mounts(names.host).some(item => item.Destination === '/data'), false)
      for (const name of [names.host, names.platform]) {
        const inspect = JSON.parse(docker(['inspect', name]).stdout)[0]
        assert.equal(inspect.HostConfig.ReadonlyRootfs, true)
        assert.equal(inspect.HostConfig.SecurityOpt.includes('no-new-privileges'), true)
      }
      checked.push('Host UID10001, read-only roots, restricted mounts')

      const login = await post(`${platformUrl}/identity/login`,
        { username: users[0].username, password: users[0].password })
      const token = login.token
      assert.equal(typeof token, 'string')
      const me = await post(`${hostUrl}/api/powerEvolve/me`, { request: {} }, token)
      assert.equal(me.settings.maxTokens, 2048)
      checked.push('Host authenticated RPC reaches internal Platform address')
      const body = Buffer.from('safe-posix image startup proof\n')
      const created = await post(`${platformUrl}/files/put`, { requestId: randomUUID(), path: 'qa/proof.txt',
        baseRevision: null, data: body.toString('base64') }, token)
      assert.match(created.revision, /^[a-f0-9]{64}$/u)
      const read = await post(`${platformUrl}/files/read`, { path: 'qa/proof.txt' }, token)
      assert.deepEqual(Buffer.from(read.data, 'base64'), body)
      const escape = await response(`${platformUrl}/files/read`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ path: '../outside' }) })
      assert.equal(escape?.status, 400)
      checked.push('authenticated SafePosix write/read and path denial')

      const native = await response(`${hostUrl}/native/`)
      assert.equal(native?.status, 200)
      assert.match(native.headers.get('content-security-policy') ?? '', /https:\/\/platform\.qa\.invalid/u)
      const html = await native.text()
      assert.match(html, /<html/u)
      const loginPage = await response(`${platformUrl}/login`)
      assert.equal(loginPage?.status, 200)
      checked.push('native Web and Platform login page loaded')
      console.log(JSON.stringify({ image, expectedFailure: false, checks: checked,
        platformHealth: true, hostHealth: true, nativeWeb: true }, null, 2))
    }
  } finally {
    for (const name of [names.host, names.platform, names.pg]) {
      docker(['rm', '-f', name], 30_000, true)
    }
    docker(['volume', 'rm', names.data], 30_000, true)
    docker(['network', 'rm', names.network], 30_000, true)
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
