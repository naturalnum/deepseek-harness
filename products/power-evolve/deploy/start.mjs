/** Launch the existing DSH Host or Platform bundle from deployment-owned configuration. */
import { spawn } from 'node:child_process'
import { readFile, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const self = fileURLToPath(import.meta.url)

function origin(value, label, https = true) {
  const parsed = new URL(value)
  if (parsed.origin !== value || parsed.username || parsed.password
    || (https && parsed.protocol !== 'https:')) throw new Error(`Invalid ${label}`)
  return value
}
function endpoint(value, label, https = true) {
  const parsed = new URL(value)
  if (parsed.username || parsed.password || parsed.hash || (https && parsed.protocol !== 'https:')) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}
function required(env, key) {
  const value = env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}
function row(source, id, replacements) {
  const lines = source.split('\n')
  const start = lines.indexOf(`    - id: ${id}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('    - id: '))
  if (start < 0) throw new Error(`Bundle row missing: ${id}`)
  const selected = lines.slice(start, end < 0 ? undefined : end)
  if (!selected.includes('      config:')) throw new Error(`Bundle config missing: ${id}`)
  const found = new Set()
  const config = selected.filter(line => line.startsWith('        ')).map(line => {
    const match = /^        ([A-Za-z]+): /.exec(line)
    if (match && Object.hasOwn(replacements, match[1])) {
      found.add(match[1])
      return `    ${match[1]}: ${JSON.stringify(replacements[match[1]])}`
    }
    return line.slice(4)
  }).join('\n')
  for (const key of Object.keys(replacements)) if (!found.has(key)) {
    throw new Error(`Bundle field missing: ${id}.${key}`)
  }
  return `- id: ${id}\n  config:\n${config}\n`
}

/** Keep the bundle as the source of plugin selection and every unchanged config field. */
export async function renderProfile(role, env, dshHome) {
  if (!['host', 'platform'].includes(role)) throw new Error('Choose host or platform')
  const hostOrigin = origin(required(env, 'PE_HOST_PUBLIC_ORIGIN'), 'Host public Origin')
  const platformOrigin = origin(required(env, 'PE_PLATFORM_PUBLIC_ORIGIN'), 'Platform public Origin')
  if (hostOrigin === platformOrigin) throw new Error('Host and Platform public Origins must differ')
  const bundleName = role
  const bundle = await readFile(join(root, 'products/power-evolve', bundleName, 'cordis.patch.yml'), 'utf8')
  const web = row(bundle, 'web-server', { host: '0.0.0.0', port: role === 'host' ? 18880 : 18881 })
  const selected = role === 'host' ? [web,
    row(bundle, 'power-evolve-runtime', { platformUrl: endpoint(
      required(env, 'PE_PLATFORM_INTERNAL_URL'), 'internal Platform URL', false) }),
    row(bundle, 'power-evolve-host', { origin: hostOrigin, platformOrigin }),
  ] : [web,
    row(bundle, 'power-evolve-platform', {
      workspaceRoot: '/data/workspaces', artifactRoot: '/data/artifacts',
      sandboxKubeconfigFile: 'in-cluster', sandboxNamespace: required(env, 'PE_SANDBOX_NAMESPACE'),
      sandboxImage: required(env, 'PE_SANDBOX_IMAGE'), sandboxLocalRoot: '/data',
      skillLibraryRoot: '/data',
      sandboxNodeRoot: '', sandboxVolumeClaimName: required(env, 'PE_SANDBOX_VOLUME_CLAIM'),
      modelUrl: endpoint(required(env, 'PE_MODEL_URL'), 'model URL'),
      connectorUrl: endpoint(required(env, 'PE_CONNECTOR_URL'), 'connector URL'),
      hostOrigin, platformOrigin,
    }),
  ]
  const name = `power-evolve-${role}`
  const profile = join(dshHome, 'profiles', name)
  const modules = join(profile, 'node_modules/@power-evolve')
  await mkdir(modules, { recursive: true, mode: 0o700 })
  const manifest = { name: `power-evolve-deploy-${role}`, private: true, type: 'module',
    dependencies: { [`@power-evolve/${bundleName}`]: '0.1.0' },
    dsh: { profile: { bundles: [`@power-evolve/${bundleName}`] } } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(profile, 'cordis.patch.yml'), selected.join(''), { mode: 0o600 })
  try { await symlink(join(root, 'products/power-evolve', bundleName), join(modules, bundleName), 'dir') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return { name, profile }
}

async function main() {
  const role = process.argv[2]
  const dshHome = required(process.env, 'DSH_HOME')
  const privateDir = required(process.env, 'PE_PRIVATE_DIR')
  const names = role === 'host' ? ['worker-token']
    : role === 'platform' ? ['database-url', 'worker-token', 'model-key', 'connector-key',
      'runner-key', 'users.json'] : []
  if (!names.length) throw new Error('Choose host or platform')
  for (const name of names) if (!(await readFile(join(privateDir, name))).length) {
    throw new Error(`Empty deployment credential: ${name}`)
  }
  const { name } = await renderProfile(role, process.env, dshHome)
  const child = spawn(process.execPath, [join(root, 'apps/cli/lib/bin.js'), '--profile', name],
    { cwd: root, env: process.env, stdio: 'inherit' })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal))
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}

if (process.argv[1] === self) await main()
