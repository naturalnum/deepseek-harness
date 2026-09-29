/** Stop writers, snapshot PG and POSIX bytes, then restore into a fresh trial. */
import { randomBytes, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, openSync, readFileSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const { Client } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const command = process.argv[2]
const bundle = process.env.PE_BACKUP_BUNDLE
const trialName = process.env.PE_TRIAL_NAME
const privateDir = process.env.PE_PRIVATE_DIR
const kubeContext = process.env.PE_KUBE_CONTEXT
if (!['create', 'restore'].includes(command) || !bundle || !isAbsolute(bundle)
  || !trialName || !/^[a-z0-9-]{1,32}$/u.test(trialName)
  || !privateDir || !isAbsolute(privateDir)) {
  throw new Error('Set create|restore, absolute PE_BACKUP_BUNDLE, PE_TRIAL_NAME and absolute PE_PRIVATE_DIR')
}
const bundlePath = resolve(bundle)
const privatePath = resolve(privateDir)
if (!privatePath.startsWith(`${join(homedir(), '.config', 'power-evolve')}/`)) {
  throw new Error('Trial private directory must be under ~/.config/power-evolve')
}
const container = `pe-shared-host-${trialName}-postgres-1`
const secretNames = ['users.json', 'worker-token', 'connector-key', 'model-key', 'model.env',
  'runner-key', 'ssh-credential-key']
const dataNames = ['workspaces', 'homes', 'skill-packages', 'artifacts']
const trialScript = join(root, 'products/power-evolve/scripts/trial.mjs')
const prepareScript = join(root, 'products/power-evolve/scripts/prepare-trial.mjs')
const composeFiles = ['-f', 'products/power-evolve/compose.yaml',
  ...(process.env.PE_COMPOSE_EXTERNAL_NETWORK
    ? ['-f', 'products/power-evolve/compose.external-network.yaml'] : [])]

function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, { cwd: root, env: process.env, encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${basename(exe)} ${args[0] ?? ''} failed`)
  return result.stdout?.trim() ?? ''
}
async function exists(path) {
  try { return await lstat(path) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function roots() {
  const sandbox = await exists(join(privatePath, 'sandbox.json'))
    ? await json(join(privatePath, 'sandbox.json')) : null
  const shared = sandbox ? resolve(sandbox.localRoot) : privatePath
  if (sandbox && (resolve(sandbox.workspaceRoot) !== join(shared, 'workspaces')
    || !isAbsolute(sandbox.nodeRoot) || !sandbox.namespace)) {
    throw new Error('Sandbox POSIX root is inconsistent')
  }
  if (!(await exists(shared))?.isDirectory() || (await lstat(shared)).isSymbolicLink()) {
    throw new Error('Shared POSIX root must be a real directory')
  }
  return { sandbox, shared }
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function inventory(directory) {
  const entries = []
  async function walk(path, relative) {
    const value = await lstat(path)
    if (value.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name), relative ? `${relative}/${name}` : name)
    } else if (value.isFile()) {
      entries.push({ path: relative, kind: 'file', size: value.size,
        sha256: sha(await readFile(path)) })
    } else if (value.isSymbolicLink()) {
      entries.push({ path: relative, kind: 'symlink', target: await readlink(path) })
    } else throw new Error(`Unsupported backup file type: ${relative}`)
  }
  await walk(directory, '')
  return entries
}
async function version(url) {
  const client = new Client({ connectionString: url })
  try {
    await client.connect()
    const schema = await client.query('SELECT version FROM pe_schema')
    const active = await client.query(`SELECT
      (SELECT count(*)::integer FROM pe_operations WHERE state IN ('queued','running')) AS operations,
      (SELECT count(*)::integer FROM pe_cloud_executions WHERE state IN ('queued','starting','running','cancelling','uncertain')) AS executions,
      (SELECT count(*)::integer FROM pe_stdio_mcp_calls WHERE state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')) AS stdio,
      (SELECT count(*)::integer FROM pe_ssh_calls WHERE state IN ('accepted','preparing','ready','dispatch-intent','running','uncertain')) AS ssh`)
    return { schema: schema.rows[0]?.version, active: active.rows[0] }
  } finally { await client.end() }
}
async function waitStableDatabase(url) {
  const until = Date.now() + 30_000
  let consecutive = 0
  while (Date.now() < until) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 1000 })
    try {
      await client.connect()
      await client.query('SELECT 1')
      if (++consecutive === 3) return
    } catch (_notReady) { consecutive = 0 }
    finally { await client.end().catch(() => {}) }
    await delay(300)
  }
  throw new Error('Restore PostgreSQL did not become stable')
}
function requireNoKubernetesWriters(sandbox) {
  if (!sandbox) return
  if (!kubeContext) throw new Error('PE_KUBE_CONTEXT is required to check Sandbox writers')
  const sandboxes = JSON.parse(run('kubectl', ['--context', kubeContext, '-n', sandbox.namespace,
    'get', 'sandboxes.agents.x-k8s.io', '-o', 'json']))
  if (sandboxes.items.length) throw new Error('Sandbox objects remain active during backup')
  const ssh = (() => {
    try { return JSON.parse(readFileSync(join(privatePath, 'ssh.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  })()
  if (ssh) {
    const resources = JSON.parse(run('kubectl', ['--context', kubeContext, '-n', ssh.namespace,
      'get', 'pods', '-o', 'json']))
    if (resources.items.some(item => /^pe-(cr|mcp)-/u.test(item.metadata.name))) {
      throw new Error('Connector Runner Pods remain active during backup')
    }
  }
}
function dump(path) {
  const fd = openSync(path, 'wx', 0o600)
  try { run('docker', ['exec', container, 'pg_dump', '-U', 'powerevolve', '-d', 'powerevolve',
    '--format=custom', '--no-owner', '--no-acl'], { stdio: ['ignore', fd, 'pipe'] }) }
  finally { closeSync(fd) }
}
function restoreDump(path) {
  const fd = openSync(path, 'r')
  try {
    const result = spawnSync('docker', ['exec', '-i', container, 'pg_restore', '-U', 'powerevolve',
      '-d', 'powerevolve', '--no-owner', '--no-acl', '--exit-on-error'],
    { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    if (result.error || result.status !== 0) {
      const reason = result.stderr?.includes('already exists') ? 'target_not_empty'
        : result.stderr?.includes('database system is starting up') ? 'database_starting'
          : 'restore_failed'
      throw new Error(`pg_restore failed: ${reason}`)
    }
  }
  finally { closeSync(fd) }
}
async function copyTree(source, target) {
  if (!(await exists(source))) { await mkdir(target, { mode: 0o700 }); return }
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink()) {
    throw new Error('POSIX backup source must be a real directory')
  }
  await cp(source, target, { recursive: true, preserveTimestamps: true, errorOnExist: true })
}

if (command === 'create') {
  if (await exists(bundlePath)) throw new Error('Backup destination already exists')
  const { sandbox, shared } = await roots()
  const stage = `${bundlePath}.partial-${randomBytes(5).toString('hex')}`
  await mkdir(dirname(bundlePath), { recursive: true, mode: 0o700 })
  await mkdir(stage, { mode: 0o700 })
  let stopped = false
  let backupError
  const startedAt = Date.now()
  try {
    stopped = true
    run(process.execPath, [trialScript, 'stop'])
    const stoppedAt = Date.now()
    const databaseUrl = (await readFile(join(privatePath, 'database-url'), 'utf8')).trim()
    const status = await version(databaseUrl)
    if (!Number.isInteger(status.schema) || status.schema < 18
      || Object.values(status.active).some(count => count !== 0)) {
      throw new Error('Backup requires schema 18+ with no pending operations or Runner calls')
    }
    requireNoKubernetesWriters(sandbox)
    dump(join(stage, 'database.dump'))
    await mkdir(join(stage, 'data'), { mode: 0o700 })
    for (const name of dataNames) await copyTree(join(name === 'artifacts' ? privatePath : shared, name),
      join(stage, 'data', name))
    await mkdir(join(stage, 'config'), { mode: 0o700 })
    const included = []
    for (const name of secretNames) {
      if (await exists(join(privatePath, name))) {
        await copyFile(join(privatePath, name), join(stage, 'config', name), constants.COPYFILE_EXCL)
        await chmod(join(stage, 'config', name), 0o600)
        included.push(name)
      }
    }
    if (!['users.json', 'worker-token', 'connector-key', 'model-key', 'model.env']
      .every(name => included.includes(name))) throw new Error('Required private configuration missing')
    const files = await inventory(stage)
    const capturedAt = Date.now()
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify({ format: 1, sourceTrial: trialName,
      schema: status.schema, startedAt, stoppedAt, capturedAt, sourceSharedRoot: shared,
      configFiles: included, files }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(stage, bundlePath)
    console.log(`Backup ready; writer freeze ${capturedAt - stoppedAt} ms; bundle ${bundlePath}`)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    backupError = error
  } finally {
    if (stopped) {
      try { run(process.execPath, [trialScript, 'up']) }
      catch (error) {
        if (backupError) throw new AggregateError([backupError, error], 'Backup failed and source restart failed')
        throw error
      }
    }
  }
  if (backupError) throw backupError
} else {
  const startedAt = Date.now()
  const manifest = await json(join(bundlePath, 'manifest.json'))
  if (manifest.format !== 1 || !Number.isInteger(manifest.schema) || manifest.schema < 18
    || manifest.sourceTrial === trialName
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.configFiles)) {
    throw new Error('Unsupported backup or source/restore trial collision')
  }
  const actual = (await inventory(bundlePath)).filter(entry => entry.path !== 'manifest.json')
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Backup integrity check failed before restore')
  }
  const { shared } = await roots()
  if (shared === manifest.sourceSharedRoot || bundlePath.startsWith(`${shared}/`)
    || bundlePath.startsWith(`${privatePath}/`)) throw new Error('Restore paths overlap the source or bundle')
  for (const name of dataNames) {
    const target = join(name === 'artifacts' ? privatePath : shared, name)
    const current = await exists(target)
    if (current && (!current.isDirectory() || (await readdir(target)).length)) {
      throw new Error(`Restore target ${name} must be empty`)
    }
  }
  for (const name of manifest.configFiles) {
    if (!secretNames.includes(name) || await exists(join(privatePath, name))) {
      throw new Error('Restore config target must be fresh')
    }
  }
  const volume = `pe-shared-host-${trialName}_postgres-data`
  const volumeCheck = spawnSync('docker', ['volume', 'inspect', volume], { encoding: 'utf8' })
  if (volumeCheck.status === 0) throw new Error('Restore PostgreSQL volume already exists')
  if (volumeCheck.status !== 1) throw new Error('Could not check restore PostgreSQL volume')
  for (const name of manifest.configFiles) {
    await copyFile(join(bundlePath, 'config', name), join(privatePath, name), constants.COPYFILE_EXCL)
    await chmod(join(privatePath, name), 0o600)
  }
  for (const name of dataNames) {
    const target = join(name === 'artifacts' ? privatePath : shared, name)
    if (await exists(target)) await rm(target, { recursive: true })
    await copyTree(join(bundlePath, 'data', name), target)
  }
  run(process.execPath, [prepareScript])
  run('docker', ['compose', '-p', `pe-shared-host-${trialName}`,
    ...composeFiles, 'up', '-d', '--wait'])
  const targetUrl = (await readFile(join(privatePath, 'database-url'), 'utf8')).trim()
  await waitStableDatabase(targetUrl)
  const clean = new Client({ connectionString: targetUrl })
  try {
    await clean.connect()
    const initial = await clean.query(`SELECT count(*)::integer AS objects
      FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`)
    if (initial.rows[0].objects !== 0) throw new Error('Restore database is not empty')
  } finally { await clean.end() }
  restoreDump(join(bundlePath, 'database.dump'))
  const restored = await version((await readFile(join(privatePath, 'database-url'), 'utf8')).trim())
  if (restored.schema !== manifest.schema) throw new Error('Restored database schema differs from the source snapshot')
  run(process.execPath, [trialScript, 'up'])
  const readyAt = Date.now()
  const ready = await version((await readFile(join(privatePath, 'database-url'), 'utf8')).trim())
  if (ready.schema < manifest.schema) throw new Error('Startup downgraded the restored schema')
  await writeFile(join(privatePath, 'restore-evidence.json'), `${JSON.stringify({ sourceTrial: manifest.sourceTrial,
    restoredTrial: trialName, startedAt, readyAt, rtoToHealthMs: readyAt - startedAt,
    sourceCapturedAt: manifest.capturedAt, schemaBeforeStartup: restored.schema,
    schemaAfterStartup: ready.schema }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' })
  console.log(`Restored trial ${trialName}: schema ${restored.schema} -> ${ready.schema}; health RTO ${readyAt - startedAt} ms`)
}
