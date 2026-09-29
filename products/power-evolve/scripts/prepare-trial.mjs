/** Prepare a separate local trial without printing or committing secrets. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const trialName = process.env.PE_TRIAL_NAME ?? 'slice1'
if (!/^[a-z0-9-]{1,32}$/.test(trialName)) throw new Error('Invalid trial name')
const port = (key, fallback) => {
  const value = Number(process.env[key] ?? fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${key}`)
  return value
}
const databasePort = port('PE_DATABASE_PORT', 18432)
const hostPort = port('PE_HOST_PORT', 18880)
const platformPort = port('PE_PLATFORM_PORT', 18881)
const targetPort = port('PE_TARGET_PORT', 18884)
const mcpEnabled = process.env.PE_MCP_ENABLED === '1'
const mcpPort = port('PE_MCP_PORT', 18943)
const deviceEnabled = process.env.PE_DEVICE_ENABLED === '1'
const devicePort = port('PE_DEVICE_PORT', 18891)
const multiHost = process.env.PE_MULTI_HOST === '1'
const hostSecondPort = port('PE_HOST_SECOND_PORT', 18897)
const loadBalancerPort = port('PE_LOAD_BALANCER_PORT', 18898)
const secondDeviceEnabled = process.env.PE_SECOND_DEVICE_ENABLED === '1'
if (secondDeviceEnabled && !deviceEnabled) throw new Error('Second device requires PE_DEVICE_ENABLED=1')
const secondDevicePort = port('PE_SECOND_DEVICE_PORT', 18896)
const ports = [databasePort, hostPort, platformPort, targetPort, ...(mcpEnabled ? [mcpPort] : []),
  ...(deviceEnabled ? [devicePort] : []),
  ...(secondDeviceEnabled ? [secondDevicePort] : []),
  ...(multiHost ? [hostSecondPort, loadBalancerPort] : [])]
if (new Set(ports).size !== ports.length) throw new Error('Trial ports must be distinct')
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve', `shared-host-${trialName}`)
const output = join(root, '.artifacts/power-evolve', trialName === 'slice1' ? '' : trialName)
await mkdir(privateDir, { recursive: true, mode: 0o700 }); await chmod(privateDir, 0o700)
let sandbox = null
try { sandbox = JSON.parse(await readFile(join(privateDir, 'sandbox.json'), 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
if (sandbox) {
  const required = ['workspaceRoot', 'kubeconfigFile', 'namespace', 'image', 'localRoot', 'nodeRoot']
  if (required.some(key => typeof sandbox[key] !== 'string' || sandbox[key].length === 0)) throw new Error('Incomplete Sandbox trial configuration')
  if (resolve(sandbox.workspaceRoot) !== join(resolve(sandbox.localRoot), 'workspaces')) throw new Error('Workspace and Sandbox roots differ')
  if (sandbox.idleMs !== undefined && (!Number.isInteger(sandbox.idleMs) || sandbox.idleMs < 1000)) throw new Error('Invalid Sandbox idle time')
}
if (deviceEnabled && !(process.env.PE_DESKTOP_IMAGE || sandbox?.image)) throw new Error('Desktop image is required')
async function provision(name, value) {
  const path = join(privateDir, name)
  try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await chmod(path, 0o600)
  return (await readFile(path, 'utf8')).trim()
}
const password = await provision('database-password', randomBytes(24).toString('base64url'))
await provision('database-url', `postgresql://powerevolve:${password}@127.0.0.1:${databasePort}/powerevolve`)
await provision('worker-token', randomBytes(32).toString('base64url'))
await provision('connector-key', randomBytes(32).toString('base64url'))
if (mcpEnabled) await provision('mcp-token', randomBytes(32).toString('base64url'))
if (sandbox) await provision('runner-key', randomBytes(32).toString('base64url'))
let modelKey = process.env.DEEPSEEK_API_KEY
if (!modelKey) {
  const env = await readFile(join(privateDir, 'model.env'), 'utf8')
  modelKey = env.split('\n').find(line => line.startsWith('DEEPSEEK_API_KEY='))?.slice('DEEPSEEK_API_KEY='.length).trim()
}
if (!modelKey) throw new Error('Provide a model.env or DEEPSEEK_API_KEY before preparing the real-model trial')
await provision('model-key', modelKey)
await provision('users.json', JSON.stringify(['alice', 'bob'].map((username, index) => ({
  username, password: randomBytes(20).toString('base64url'), settings: { model: 'deepseek-flash', maxTokens: index === 0 ? 2048 : 1536, revision: 1 },
  models: index === 0
    ? [{ id: 'deepseek-flash', label: 'DeepSeek Flash', maxTokens: 4096 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', maxTokens: 2048 }]
    : [{ id: 'deepseek-flash', label: 'DeepSeek Flash', maxTokens: 1536 }],
})), null, 2) + '\n')
for (const name of ['host', ...(multiHost ? ['host-b'] : []), 'platform', ...(deviceEnabled ? ['device'] : []),
  ...(secondDeviceEnabled ? ['device-bob'] : [])]) {
  const bundleName = name === 'device-bob' ? 'device' : name === 'host-b' ? 'host' : name
  const home = join(output, 'trial', name)
  const profile = join(home, 'profiles', `power-evolve-${name}`)
  const modules = join(profile, 'node_modules/@power-evolve')
  await mkdir(modules, { recursive: true, mode: 0o700 })
  const manifest = { name: `power-evolve-trial-${name}`, private: true, type: 'module', dependencies: { [`@power-evolve/${bundleName}`]: '0.1.0' }, dsh: { profile: { bundles: [`@power-evolve/${bundleName}`] } } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  try { await symlink(join(root, 'products/power-evolve', bundleName), join(modules, bundleName), 'dir') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  // A profile patch replaces a row's full config, so retain every bundle field.
  const bundle = (await readFile(join(root, 'products/power-evolve', bundleName, 'cordis.patch.yml'), 'utf8')).split('\n')
  const values = { port: name === 'host' ? hostPort : name === 'host-b' ? hostSecondPort
    : name === 'device' ? devicePort : name === 'device-bob' ? secondDevicePort : platformPort,
    hostOrigin: `http://127.0.0.1:${multiHost ? loadBalancerPort : hostPort}`,
    origin: `http://127.0.0.1:${multiHost ? loadBalancerPort : hostPort}`,
    platformOrigin: `http://127.0.0.1:${platformPort}`, platformUrl: `http://127.0.0.1:${platformPort}`,
    deviceOrigin: `http://127.0.0.1:${devicePort}`,
    image: process.env.PE_DESKTOP_IMAGE ?? sandbox?.image,
    connectorUrl: `http://127.0.0.1:${targetPort}`,
    ...(mcpEnabled ? { mcpUrl: JSON.stringify(`http://127.0.0.1:${mcpPort}/mcp`),
      mcpTokenFile: JSON.stringify(join(privateDir, 'mcp-token')) } : {}),
    ...(sandbox ? { workspaceRoot: sandbox.workspaceRoot, sandboxKubeconfigFile: sandbox.kubeconfigFile,
      sandboxNamespace: sandbox.namespace, sandboxImage: sandbox.image, sandboxLocalRoot: sandbox.localRoot,
      sandboxNodeRoot: sandbox.nodeRoot, ...(sandbox.idleMs ? { sandboxIdleMs: sandbox.idleMs } : {}) } : {}) }
  const selected = bundleName === 'host' ? ['web-server', 'power-evolve-host', 'power-evolve-runtime']
    : bundleName === 'device' ? ['web-server', 'power-evolve-device'] : ['web-server', 'power-evolve-platform']
  const patch = selected.map(id => {
    const start = bundle.indexOf(`    - id: ${id}`)
    const end = bundle.findIndex((line, index) => index > start && line.startsWith('    - id: '))
    const rows = bundle.slice(start, end < 0 ? undefined : end)
    const configStart = rows.indexOf('      config:')
    if (start < 0 || configStart < 0) throw new Error(`Bundle config missing: ${id}`)
    const config = rows.slice(configStart).filter(line => line.startsWith('      ')).map(line => {
      const adjusted = line.slice(4)
      const match = /^    ([A-Za-z]+): /.exec(adjusted)
      if (name === 'device-bob' && match?.[1] === 'privateDir') {
        return "    privateDir: !!js process.env.PE_PRIVATE_DIR + '/device-bob'"
      }
      return match && Object.hasOwn(values, match[1]) ? `    ${match[1]}: ${values[match[1]]}` : adjusted
    }).join('\n')
    return `- id: ${id}\n${config}\n`
  }).join('')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
}
console.log('Prepared isolated PowerEvolve trial configuration; credentials were not printed.')
