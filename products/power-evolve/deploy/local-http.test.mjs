import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildLocalHttpManifests } from './local-http.mjs'
import { buildManifests, validateValues } from './render.mjs'
import { validateBundle } from './preflight.mjs'
import { renderProfile } from './start.mjs'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const yaml = require('js-yaml')
const profileSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => value,
}))
const example = JSON.parse(await readFile(new URL('./values.example.json', import.meta.url), 'utf8'))
const nodeRoot = '/var/local/power-evolve-local'
const localValues = () => ({ ...structuredClone(example),
  hostPublicOrigin: 'http://127.0.0.1:19804', platformPublicOrigin: 'http://127.0.0.1:19806' })
const resource = (items, kind, name, namespace) => {
  const found = items.filter(item => item.kind === kind && item.metadata.name === name
    && item.metadata.namespace === namespace)
  assert.equal(found.length, 1)
  return found[0]
}
const originsEnv = values => ({ PE_LOCAL_HTTP: '1', PE_HOST_PUBLIC_ORIGIN: values.hostPublicOrigin,
  PE_PLATFORM_PUBLIC_ORIGIN: values.platformPublicOrigin })

for (const field of ['hostPublicOrigin', 'platformPublicOrigin']) {
  test('local HTTP refuses noncanonical or nonloopback ' + field, () => {
    for (const origin of [
      undefined, null, '', 'https://127.0.0.1:19804', 'http://192.168.1.2:19804',
      'http://0.0.0.0:19804', 'http://example.invalid:19804', 'http://127.0.0.2:19804',
      'http://localhost.:19804', 'http://LOCALHOST:19804', 'http://127.1:19804',
      'http://2130706433:19804', 'http://[0:0:0:0:0:0:0:1]:19804',
      'http://127.0.0.1:80', 'http://127.0.0.1:19804/', 'http://127.0.0.1:19804/path',
      'http://127.0.0.1:19804?x=1', 'http://127.0.0.1:19804#x',
      'http://user:password@127.0.0.1:19804', 'http://127.0.0.1:19804\n',
      'ftp://127.0.0.1:19804', 'ws://localhost:19804',
    ]) {
      const values = localValues(); values[field] = origin
      assert.throws(() => buildLocalHttpManifests(values, { nodeRoot }), /Origin|PUBLIC_ORIGIN/)
    }
  })
}

test('local HTTP accepts all three canonical loopback hosts and preserves effective ports', () => {
  for (const [host, platform] of [
    ['http://127.0.0.1:19804', 'http://127.0.0.1:19806'],
    ['http://localhost:19804', 'http://localhost:19806'],
    ['http://[::1]:19804', 'http://[::1]:19806'],
    ['http://127.0.0.1', 'http://127.0.0.1:443'],
  ]) {
    const values = { ...localValues(), hostPublicOrigin: host, platformPublicOrigin: platform }
    const items = buildLocalHttpManifests(values, { nodeRoot })
    for (const role of ['host', 'platform']) {
      const config = resource(items, 'ConfigMap', 'power-evolve-' + role + '-config', values.namespace).data
      assert.equal(config.PE_HOST_PUBLIC_ORIGIN, host)
      assert.equal(config.PE_PLATFORM_PUBLIC_ORIGIN, platform)
      assert.equal(config.PE_LOCAL_HTTP, '1')
    }
  }
  const values = localValues(); values.platformPublicOrigin = values.hostPublicOrigin
  assert.throws(() => buildLocalHttpManifests(values, { nodeRoot }), /Origins must differ/)
  for (const origin of ['http://localhost:19806', 'http://[::1]:19806']) {
    assert.throws(() => buildLocalHttpManifests({ ...localValues(), platformPublicOrigin: origin }, { nodeRoot }),
      /same loopback hostname and different ports/)
  }
})

test('local nodeRoot and replica options reject unsafe paths and implicit replica coercion', () => {
  for (const path of [undefined, null, '', '/', 'relative/path', '/var/../data', '/var/./data',
    '//data', '/var//data', '/data\nother', '/data\r', '/data\0other', '/data\tother',
    '/data\\other', ' /data', '/data ', 'C:\\data']) {
    assert.throws(() => buildLocalHttpManifests(localValues(), { nodeRoot: path }), /nodeRoot/)
  }
  for (const key of ['hostReplicas', 'platformReplicas']) {
    for (const replicas of [0, 3, -1, 1.5, '1', '2', null, true]) {
      assert.throws(() => buildLocalHttpManifests(localValues(), { nodeRoot, [key]: replicas }), /replicas/)
    }
  }
  for (const [hostReplicas, platformReplicas] of [[1, 1], [2, 2], [1, 2], [2, 1]]) {
    const values = localValues(), items = buildLocalHttpManifests(values, { nodeRoot, hostReplicas, platformReplicas })
    assert.equal(resource(items, 'Deployment', 'power-evolve-host', values.namespace).spec.replicas, hostReplicas)
    assert.equal(resource(items, 'Deployment', 'power-evolve-platform', values.namespace).spec.replicas, platformReplicas)
  }
})

test('local resource conversion preserves every formal field outside the declared overrides', () => {
  const values = localValues(), unchanged = structuredClone(values)
  values.connectorRunner = { namespace: 'pe-local-connectors',
    image: 'registry.internal/connector@sha256:' + 'abc01234'.repeat(8),
    proxySourceCidrs: ['10.42.0.1/32'], sshDestinations: [{ ip: '10.70.0.11', port: 22 }] }
  values.remoteMcp = { secretName: 'pe-local-mcp', caConfigMapName: 'pe-local-ca',
    destinations: [{ origin: 'https://mcp.internal:8443', addresses: ['10.70.0.12'], caKey: 'mcp.pem' }] }
  const before = structuredClone(values)
  const formal = buildManifests({ ...structuredClone(values),
    hostPublicOrigin: 'https://127.0.0.1:19804', platformPublicOrigin: 'https://127.0.0.1:19806' })
  const items = buildLocalHttpManifests(values, { nodeRoot })
  assert.deepEqual(values, before)
  assert.equal(items.length, formal.length - 1)
  assert.equal(items.some(item => item.kind === 'Ingress' || item.kind === 'Secret'), false)
  for (const original of formal) {
    if (original.kind === 'Ingress') continue
    const actual = resource(items, original.kind, original.metadata.name, original.metadata.namespace)
    const expected = structuredClone(original)
    if (expected.kind === 'PersistentVolume') {
      delete expected.spec.nfs; delete expected.spec.mountOptions
      expected.spec.hostPath = { path: nodeRoot, type: 'DirectoryOrCreate' }
    }
    if (expected.metadata.namespace === values.namespace && expected.kind === 'ConfigMap') {
      expected.data.PE_HOST_PUBLIC_ORIGIN = values.hostPublicOrigin
      expected.data.PE_PLATFORM_PUBLIC_ORIGIN = values.platformPublicOrigin
      expected.data.PE_LOCAL_HTTP = '1'
    }
    if (expected.metadata.namespace === values.namespace && expected.kind === 'Deployment') {
      const platform = expected.metadata.name === 'power-evolve-platform'
      expected.spec.replicas = 1
      expected.spec.template.spec.containers[0].resources = platform
        ? { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1536Mi' } }
        : { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '750m', memory: '768Mi' } }
    }
    assert.deepEqual(actual, expected, original.kind + '/' + original.metadata.name)
  }
  const host = resource(items, 'Deployment', 'power-evolve-host', values.namespace).spec.template.spec
  assert.equal(host.automountServiceAccountToken, false)
  assert.equal(host.securityContext.runAsUser, 10001)
  assert.equal(host.volumes.some(item => item.persistentVolumeClaim || item.hostPath), false)
  assert.deepEqual(host.volumes.find(item => item.name === 'private').projected.sources,
    [{ secret: { name: values.secrets.shared, items: [{ key: 'worker-token', path: 'worker-token' }] } }])
  assert.equal(resource(items, 'ConfigMap', 'power-evolve-host-config', values.namespace).data.PE_MODEL_URL, undefined)
  assert.equal(resource(items, 'Service', 'power-evolve-host', values.namespace).spec.type, 'ClusterIP')
  assert.equal(resource(items, 'Service', 'power-evolve-platform', values.namespace).spec.type, 'ClusterIP')
  assert.throws(() => validateValues(unchanged), /Host public Origin/)
  assert.throws(() => validateBundle(values, items), /Host public Origin/)
  assert.throws(() => validateBundle({ ...values, hostPublicOrigin: 'https://127.0.0.1:19804',
    platformPublicOrigin: 'https://127.0.0.1:19806' }, items))
  assert.doesNotThrow(() => validateValues(example))
})

test('the local builder keeps the remaining production value restrictions', () => {
  for (const edit of [
    values => { values.appImage = 'registry/app:latest' },
    values => { values.modelUrl = 'http://127.0.0.1:8080' },
    values => { values.secrets.platform = values.secrets.shared },
    values => { values.namespace = values.runnerNamespace },
    values => { values.storage.nfsPath = '/data/../elsewhere' },
  ]) {
    const values = localValues(); edit(values)
    assert.throws(() => buildLocalHttpManifests(values, { nodeRoot }))
  }
})

test('explicit local HTTP uses the existing role bundles without widening Host authority', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-local-http-profile-'))
  try {
    const values = localValues(), items = buildLocalHttpManifests(values, { nodeRoot })
    for (const role of ['host', 'platform']) {
      const env = resource(items, 'ConfigMap', 'power-evolve-' + role + '-config', values.namespace).data
      const result = await renderProfile(role, env, join(temporary, role))
      const manifest = JSON.parse(await readFile(join(result.profile, 'package.json'), 'utf8'))
      assert.deepEqual(manifest.dependencies, { ['@power-evolve/' + role]: '0.1.0' })
      assert.deepEqual(manifest.dsh.profile.bundles, ['@power-evolve/' + role])
      const rows = yaml.load(await readFile(join(result.profile, 'cordis.patch.yml'), 'utf8'), { schema: profileSchema })
      assert.deepEqual(rows.map(row => row.id), role === 'host'
        ? ['web-server', 'power-evolve-runtime', 'power-evolve-host'] : ['web-server', 'power-evolve-platform'])
      const config = rows.at(-1).config
      assert.equal(role === 'host' ? config.origin : config.hostOrigin, values.hostPublicOrigin)
      assert.equal(config.platformOrigin, values.platformPublicOrigin)
      if (role === 'host') assert.equal(JSON.stringify(rows).includes('databaseUrlFile'), false)
      else {
        assert.equal(config.sandboxKubeconfigFile, 'in-cluster')
        assert.equal(config.sandboxNodeRoot, '')
        assert.equal(config.sandboxVolumeClaimName, values.storage.runnerClaim)
        assert.equal(config.workspaceRoot, '/data/workspaces')
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('startup defaults to HTTPS and rejects unknown local flags and invalid local Origins before creating Profiles', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-local-http-refusal-'))
  try {
    for (const role of ['host', 'platform']) {
      const home = join(temporary, 'not-created-' + role)
      const { PE_LOCAL_HTTP: _mode, ...withoutMode } = originsEnv(localValues())
      await assert.rejects(renderProfile(role, withoutMode, home), /Host public Origin/)
      for (const flag of ['', '0', 'true', 'false', '2', 1, true, null]) {
        await assert.rejects(renderProfile(role, { ...withoutMode, PE_LOCAL_HTTP: flag }, home), /PE_LOCAL_HTTP/)
      }
      for (const field of ['PE_HOST_PUBLIC_ORIGIN', 'PE_PLATFORM_PUBLIC_ORIGIN']) {
        for (const invalid of ['http://192.168.1.2:19804', 'https://127.0.0.1:19804',
          'ftp://localhost:19804', 'http://127.0.0.1:19804/path']) {
          await assert.rejects(renderProfile(role, { ...originsEnv(localValues()), [field]: invalid }, home), /Origin/)
        }
      }
      await assert.rejects(renderProfile(role, { ...originsEnv(localValues()),
        PE_PLATFORM_PUBLIC_ORIGIN: localValues().hostPublicOrigin }, home), /Origins must differ/)
      for (const origin of ['http://localhost:19806', 'http://[::1]:19806']) {
        await assert.rejects(renderProfile(role, { ...originsEnv(localValues()), PE_PLATFORM_PUBLIC_ORIGIN: origin }, home),
          /same loopback hostname and different ports/)
      }
      await assert.rejects(stat(home), { code: 'ENOENT' })
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

async function entry(name, args, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL/u.test(key) && !/^(PE_|DSH_)/u.test(key) && key !== 'NODE_OPTIONS'))
  const child = spawn(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args],
    { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false, error, killTimer
  child.stdout.on('data', bytes => { stdout += bytes.toString() })
  child.stderr.on('data', bytes => { stderr += bytes.toString() })
  child.on('error', value => { error = value })
  const timer = setTimeout(() => {
    timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  }, 15000)
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer); clearTimeout(killTimer)
  assert.equal(timedOut, false, 'CLI child deadline fired')
  assert.equal(error, undefined)
  assert.equal(result.signal, null)
  return { ...result, stdout, stderr }
}

test('CLI writes reviewable JSON/YAML and prints loopback port-forward examples without applying resources', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-local-http-cli-'))
  try {
    const input = join(temporary, 'values.json')
    for (const extension of ['json', 'yaml']) {
      const values = extension === 'json' ? localValues() : { ...localValues(),
        hostPublicOrigin: 'http://[::1]:19804', platformPublicOrigin: 'http://[::1]:19806' }
      const bytes = JSON.stringify(values)
      await writeFile(input, bytes, { mode: 0o600 })
      const output = join(temporary, 'resources.' + extension)
      const result = await entry('./local-http.mjs', [input, output, nodeRoot, '2', '2'])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /single-machine local HTTP/)
      assert.match(result.stdout, /cannot pass production preflight/)
      assert.match(result.stdout, extension === 'json' ? /--address 127\.0\.0\.1 service\/power-evolve-host 19804:18880/
        : /--address ::1 service\/power-evolve-host 19804:18880/)
      assert.match(result.stdout, extension === 'json' ? /--address 127\.0\.0\.1 service\/power-evolve-platform 19806:18881/
        : /--address ::1 service\/power-evolve-platform 19806:18881/)
      const body = await readFile(output, 'utf8')
      const items = extension === 'json' ? JSON.parse(body).items : yaml.loadAll(body)
      assert.deepEqual(items, buildLocalHttpManifests(values, { nodeRoot, hostReplicas: 2, platformReplicas: 2 }))
      if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600)
      assert.equal(await readFile(input, 'utf8'), bytes)
    }
    const existing = join(temporary, 'resources.json')
    const before = await readFile(existing)
    assert.notEqual((await entry('./local-http.mjs', [input, existing, nodeRoot])).code, 0)
    assert.deepEqual(await readFile(existing), before)
    const invalid = join(temporary, 'invalid.yaml')
    assert.notEqual((await entry('./local-http.mjs', [input, invalid, nodeRoot, '3'])).code, 0)
    await assert.rejects(stat(invalid), { code: 'ENOENT' })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('real start CLI validates HTTP mode before private-file checks or launching DSH', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-local-http-start-refusal-'))
  try {
    const env = { ...originsEnv(localValues()), DSH_HOME: join(temporary, 'not-created'),
      PE_PRIVATE_DIR: join(temporary, 'no-credentials') }
    for (const flag of ['0', undefined]) {
      const selected = { ...env }
      if (flag === undefined) delete selected.PE_LOCAL_HTTP
      else selected.PE_LOCAL_HTTP = flag
      const result = await entry('./start.mjs', ['host'], selected)
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, flag === undefined ? /Invalid Host public Origin/ : /PE_LOCAL_HTTP must be 1 or omitted/)
      assert.doesNotMatch(result.stderr, /ENOENT|Missing PE_PRIVATE_DIR|Missing DSH_HOME/)
      await assert.rejects(stat(env.DSH_HOME), { code: 'ENOENT' })
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
