/** Real current-schema backup/restore under an isolated non-superuser role and exact owned resources. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { watch, writeFileSync } from 'node:fs'
import { appendFile, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { initializeDatabase } from '../application/src/platform/database.ts'
import { backupConfig, createBackup, restoreBackup } from './backup.mjs'
import { connectDatabase, databaseCensus, postgresTool, requireCurrentSchema, requireEmptyDatabase, requireQuiescentDatabase, verifyTools } from './backup-postgres.mjs'
import { copyTree, inventoryTree, newPrivatePath, physicalPath, separatePaths } from './backup-tree.mjs'
import { durableJson, privateJson } from './lifecycle.mjs'

const { Client, Pool } = createRequire(new URL('../application/package.json', import.meta.url))('pg')
const labels = ['privateConfig', 'workspaces', 'homes', 'skillPackages', 'attachments', 'officeCache']
async function observed(check) {
  const deadline = Date.now() + 30000
  for (;;) {
    if (await check()) return
    if (Date.now() >= deadline) throw new Error('Current built Profile readiness was not observed')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 })
  if (result.error || result.signal || result.status !== 0) throw new Error('Owned employee4 PostgreSQL tools transport failed')
  return result.stdout.trim()
}
async function backupCli(command, config, configPath) {
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./backup.mjs', import.meta.url)), command, configPath], { encoding: 'utf8', timeout: 60000 })
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
async function runProfile(t, role, configPath, directory, whenReady) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./start.mjs', import.meta.url)), role, configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', closed = false
  child.stdout.on('data', (bytes) => { output += bytes })
  child.stderr.on('data', (bytes) => { output += bytes })
  const done = once(child, 'close').then(([code, signal]) => { closed = true; return { code, signal } })
  try {
    await observed(async () => {
      if (closed) throw new Error(`Built ${role} Profile exited before readiness; inspect locally captured diagnostics`)
      return !!await privateJson(join(directory, 'ready.json'))
    })
    const ready = await privateJson(join(directory, 'ready.json'))
    assert.equal((await fetch(ready.url + '/health')).status, 200)
    await whenReady?.(ready)
    child.kill('SIGTERM')
    const exit = await done
    assert.deepEqual(exit, { code: 0, signal: null })
    const lifecycle = await privateJson(join(directory, 'lifecycle.json'))
    assert.equal(lifecycle.phase, 'stopped')
    assert.equal(lifecycle.child.pid, ready.pid)
    return { readiness: true, stopped: true, diagnosticBytes: Buffer.byteLength(output) }
  } catch (error) {
    await writeFile(join('/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence', `employee4-${role}-last-private.log`), output, { mode: 0o600 })
    throw error
  } finally { if (!closed) child.kill('SIGTERM'); await done }
}

test('current-cloud backup refuses incomplete storage selection', () => {
  assert.throws(() => backupConfig({ format: 1, bundle: '/tmp/bundle', postgres: {}, roots: {}, profiles: [] }), /Invalid/u)
  const valid = { format: 1, bundle: '/tmp/bundle', postgres: { urlFile: '/tmp/url', database: 'fixture', role: 'fixture' },
    roots: Object.fromEntries(labels.map(label => [label, '/tmp/' + label])), profiles: ['/tmp/host', '/tmp/platform'],
    nativeIntentKeyFile: '/tmp/privateConfig/native-intent-key' }
  assert.throws(() => backupConfig({ ...valid, nativeIntentKeyFile: undefined }), /Invalid/u)
  assert.throws(() => backupConfig({ ...valid, nativeIntentKeyFile: '/tmp/outside-key' }), /inside privateConfig/u)
  for (const tools of [{ container: 'fixture' }, { binDir: 'relative' }, { host: 'white space' },
    { container: 'fixture', host: 'localhost', port: '5432', binDir: '/tmp/bin' }]) {
    assert.throws(() => backupConfig({ ...valid, postgres: { ...valid.postgres, tools } }), /transport/u)
  }
  for (const [tool, url, message] of [
    ['unsupported', 'postgres://fixture@localhost/fixture', /Unsupported PostgreSQL tool/u],
    ['psql', 'https://fixture@localhost/fixture', /tool URL/u],
    ['psql', 'postgres://fixture@localhost/fixture?sslmode=require', /tool URL/u],
    ['psql', 'postgres://fixture@localhost/fixture#fragment', /tool URL/u],
    ['psql', 'postgres://fixture@localhost/', /literal database/u],
    ['psql', 'postgres://fixture@localhost/fixture%3Doption', /literal database/u],
  ]) assert.throws(() => postgresTool(tool, url, valid.postgres, []), message)
})
test('native intent key archives bind original private bytes and reject substitution before PostgreSQL access', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-intent-key-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const roots = Object.fromEntries(labels.map(label => [label, join(root, 'source-' + label)]))
  const profiles = [join(root, 'source-host'), join(root, 'source-platform')]
  for (const path of [...Object.values(roots), ...profiles]) await mkdir(path, { mode: 0o700 })
  const nativeIntentKeyFile = join(roots.privateConfig, 'platform/native-intent-key')
  await mkdir(join(roots.privateConfig, 'platform'), { mode: 0o700 })
  const original = Buffer.from(randomBytes(32).toString('base64url') + '\n')
  await writeFile(nativeIntentKeyFile, original, { mode: 0o600 })
  const config = { format: 1, bundle: join(root, 'bundle'), roots, profiles, nativeIntentKeyFile,
    postgres: { urlFile: join(root, 'absent-database-url'), database: 'fixture', role: 'fixture' } }
  // The absent URL proves key validation completes before any PostgreSQL connection or bundle write.
  await assert.rejects(createBackup(config), { code: 'ENOENT' })
  await chmod(nativeIntentKeyFile, 0o640)
  await assert.rejects(createBackup(config), /0600 canonical/u)
  await chmod(nativeIntentKeyFile, 0o600)
  for (const placeholder of [randomUUID(), 'A'.repeat(42) + '_', 'A'.repeat(43) + '\r\n']) {
    await writeFile(nativeIntentKeyFile, placeholder)
    await assert.rejects(createBackup(config), /0600 canonical/u)
  }
  await writeFile(nativeIntentKeyFile, original)
  const alias = join(roots.privateConfig, 'key-alias')
  await symlink(nativeIntentKeyFile, alias)
  await assert.rejects(createBackup({ ...config, nativeIntentKeyFile: alias }), /physical/u)
  await rm(alias)
  const inventories = { profiles: [] }
  await mkdir(config.bundle, { mode: 0o700 })
  await mkdir(join(config.bundle, 'roots'), { mode: 0o700 })
  await mkdir(join(config.bundle, 'profiles'), { mode: 0o700 })
  for (const label of labels) {
    inventories[label] = await inventoryTree(roots[label], label === 'privateConfig' || label === 'attachments')
    await copyTree(roots[label], join(config.bundle, 'roots', label), inventories[label])
  }
  for (const [index, path] of profiles.entries()) {
    inventories.profiles.push(await inventoryTree(path))
    await copyTree(path, join(config.bundle, 'profiles', String(index)), inventories.profiles[index])
  }
  // This fixture exercises pre-database archive validation; its marker is deliberately not a PG dump.
  await writeFile(join(config.bundle, 'database.dump'), 'pre-database key validation fixture', { mode: 0o600 })
  const nativeIntentKey = { path: 'platform/native-intent-key', size: original.length,
    sha256: createHash('sha256').update(original).digest('hex') }
  const manifest = { format: 1, kind: 'power-evolve-current-cloud-backup', schema: 8, family: 'cloud-native',
    sourceRoots: roots, sourceProfiles: profiles, nativeIntentKey, inventories,
    files: (await inventoryTree(config.bundle)).filter(entry => entry.path !== '') }
  const saveManifest = async (value) => {
    await durableJson(join(config.bundle, 'manifest.json'), value)
    await durableJson(join(config.bundle, 'manifest-digest.json'),
      { sha256: createHash('sha256').update(JSON.stringify(value) + '\n').digest('hex') })
  }
  await saveManifest(manifest)
  const targetRoots = Object.fromEntries(labels.map(label => [label, join(root, 'target-' + label)]))
  const target = { ...config, roots: targetRoots, profiles: [join(root, 'target-host'), join(root, 'target-platform')],
    nativeIntentKeyFile: join(targetRoots.privateConfig, nativeIntentKey.path) }
  for (const schema of [2, 3, 4, 5, 6, 7]) {
    await saveManifest({ ...manifest, schema })
    const oldBytes = await readFile(join(config.bundle, 'manifest.json'))
    await assert.rejects(restoreBackup(target), /Invalid current-cloud backup manifest or digest/u)
    assert.deepEqual(await readFile(join(config.bundle, 'manifest.json')), oldBytes)
    for (const path of [...Object.values(targetRoots), ...target.profiles]) await assert.rejects(lstat(path), { code: 'ENOENT' })
  }
  await saveManifest(manifest)
  const archivedKeyFile = join(config.bundle, 'roots/privateConfig', nativeIntentKey.path)
  assert.deepEqual(await readFile(archivedKeyFile), original)
  assert.equal((await lstat(archivedKeyFile)).mode & 0o7777, 0o600)
  await assert.rejects(restoreBackup({ ...target, nativeIntentKeyFile: join(targetRoots.privateConfig, 'native-intent-key') }), /original relative path/u)
  await assert.rejects(restoreBackup(target), { code: 'ENOENT' })
  await saveManifest({ ...manifest, nativeIntentKey: undefined })
  await assert.rejects(restoreBackup(target), /Invalid native intent key manifest/u)
  await saveManifest({ ...manifest, nativeIntentKey: { ...nativeIntentKey, sha256: '0'.repeat(64) } })
  await assert.rejects(restoreBackup(target), /differs from the privateConfig inventory/u)
  await saveManifest(manifest)
  await writeFile(archivedKeyFile, randomBytes(32).toString('base64url') + '\n')
  await assert.rejects(restoreBackup(target), /integrity or permission mismatch/u)
  for (const path of [...Object.values(targetRoots), ...target.profiles]) await assert.rejects(lstat(path), { code: 'ENOENT' })
  await assert.rejects(lstat(config.postgres.urlFile), { code: 'ENOENT' })
})
test('physical roots reject symlink aliases and preserve symlink bytes without following them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-trees-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'data'), { mode: 0o700 })
  await symlink(join(root, 'data'), join(root, 'alias'))
  await assert.rejects(separatePaths([join(root, 'data'), join(root, 'alias/new')]), /overlap/u)
  await symlink('../does-not-exist', join(root, 'data/link'))
  assert.equal((await inventoryTree(join(root, 'data')))[1].link, '../does-not-exist')
  await assert.rejects(inventoryTree(join(root, 'data'), true), /private/u)
  await copyTree(join(root, 'data'), join(root, 'restored'), await inventoryTree(join(root, 'data')))
  assert.equal(await readlink(join(root, 'restored/link')), '../does-not-exist')
  const fifo = join(root, 'data/fifo')
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 10000 })
  assert.equal(created.error, undefined); assert.equal(created.signal, null); assert.equal(created.status, 0, created.stderr)
  await assert.rejects(inventoryTree(join(root, 'data')), /nonregular/u)
})

test('restore directories and durable inventories reject aliases, public parents and invalid hardlinks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-inventory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 })
  await writeFile(join(source, 'first'), 'immutable bytes', { mode: 0o600 })
  await assert.rejects(physicalPath(join(source, 'first/nested')), { code: 'ENOTDIR' })
  await assert.rejects(newPrivatePath(join(source, 'first/nested')), { code: 'ENOTDIR' })
  await link(join(source, 'first'), join(source, 'second'))
  const inventory = await inventoryTree(source, true)
  assert.equal(inventory[2].kind, 'hardlink')
  await copyTree(source, join(root, 'copied'), inventory)
  const first = await lstat(join(root, 'copied/first')), second = await lstat(join(root, 'copied/second'))
  assert.equal(first.ino, second.ino); assert.equal(first.dev, second.dev)
  assert.equal(first.mode & 0o777, 0o600)
  assert.equal(first.uid, inventory[1].uid); assert.equal(first.gid, inventory[1].gid)
  await mkdir(join(root, 'public'), { mode: 0o755 })
  await chmod(join(root, 'public'), 0o755)
  await assert.rejects(newPrivatePath(join(root, 'public/new')), /private and physical/u)
  await symlink(source, join(root, 'alias'))
  await assert.rejects(inventoryTree(join(root, 'alias')), /real directory/u)
  await assert.rejects(inventoryTree(join(source, 'first')), /real directory/u)
  await assert.rejects(newPrivatePath(join(root, 'alias/new')), /private and physical/u)
  const variants = [
    { entries: [], message: /root inventory/u },
    { entries: [inventory[0], { ...inventory[1], path: '../escape' }], message: /inventory path/u },
    { entries: [inventory[0], inventory[1], inventory[1]], message: /inventory order/u },
    { entries: [inventory[0], { ...inventory[1], path: 'absent/file' }], message: /inventory order/u },
    { entries: [inventory[0], inventory[1], { ...inventory[2], mode: 0o644 }], message: /hardlink identity/u },
    { entries: [inventory[0], { ...inventory[1], sha256: '0'.repeat(64) }], message: /digest changed/u },
    { entries: [inventory[0], { ...inventory[1], kind: 'unsupported' }], message: /inventory kind/u },
  ]
  for (const [index, variant] of variants.entries()) {
    await assert.rejects(copyTree(source, join(root, `invalid-${index}`), variant.entries), variant.message)
  }
})

test('backup CLI invalid invocation reports failure without publishing a bundle', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./backup.mjs', import.meta.url)), 'unsupported'],
    { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Business readiness is unchecked/u)
})

test('copy refuses a real source append observed after target bytes begin streaming', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-concurrent-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), target = join(root, 'copied'), file = join(source, 'payload')
  await mkdir(source, { mode: 0o700 })
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024, 37), { mode: 0o600 })
  const inventory = await inventoryTree(source)
  const sourceHandle = await open(file, 'r')
  let fileHandlePrototype
  try { fileHandlePrototype = Object.getPrototypeOf(sourceHandle) }
  finally { await sourceHandle.close() }
  const originalWriteFile = fileHandlePrototype.writeFile
  let targetHandle, copiedBytes = 0, appendAcknowledged = false
  const hook = t.mock.method(fileHandlePrototype, 'writeFile', async function (...args) {
    if (targetHandle && this !== targetHandle) return Reflect.apply(originalWriteFile, this, args)
    if (!targetHandle) {
      let byPath
      try { byPath = await lstat(join(target, 'payload')) }
      catch (error) { if (error.code === 'ENOENT') return Reflect.apply(originalWriteFile, this, args); throw error }
      const byFd = await this.stat()
      if (!byPath.isFile() || byFd.dev !== byPath.dev || byFd.ino !== byPath.ino) {
        return Reflect.apply(originalWriteFile, this, args)
      }
      targetHandle = this
    }
    const result = await Reflect.apply(originalWriteFile, this, args)
    if (!appendAcknowledged) {
      copiedBytes = (await this.stat()).size
      assert.ok(copiedBytes > 0 && copiedBytes < inventory[1].size)
      // The original consume await holds copying until this real append completes.
      await appendFile(file, 'concurrent-owned-byte')
      appendAcknowledged = true
    }
    return result
  })
  try { await assert.rejects(copyTree(source, target, inventory), /Backup file changed while reading/u) }
  finally { hook.mock.restore() }
  assert.equal(appendAcknowledged, true)
  assert.ok(copiedBytes > 0 && copiedBytes < inventory[1].size)
  assert.equal((await lstat(file)).size, inventory[1].size + Buffer.byteLength('concurrent-owned-byte'))
})

test('ordinary deployment role restores all current tables and original private/file bytes', { timeout: 180000 }, async (t) => {
  if (!process.env.PE_TEST_DATABASE_URL_FILE) throw new Error('Employee4 backup acceptance requires PE_TEST_DATABASE_URL_FILE')
  const root = await mkdtemp(join(tmpdir(), 'pe-employee4-backup-'))
  const adminUrl = new URL((await readFile(process.env.PE_TEST_DATABASE_URL_FILE, 'utf8')).trim())
  const admin = new Client({ connectionString: adminUrl.href })
  await admin.connect()
  const suffix = randomUUID().replaceAll('-', ''), role = `pe_employee4_${suffix}`
  const names = ['source', 'target', 'occupied', 'legacy'].map(label => `pe_employee4_${label}_${suffix}`)
  const password = randomUUID()
  let toolsContainer = null, roleCreated = false
  const clients = []
  t.after(async () => {
    for (const client of clients) await client.end()
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    if (roleCreated) await admin.query(`DROP ROLE "${role}"`)
    await admin.end()
    if (toolsContainer) { docker(['stop', '--time', '5', toolsContainer]); docker(['rm', toolsContainer]) }
    await rm(root, { recursive: true, force: true })
  })
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`); roleCreated = true
  for (const name of names) await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`)
  const toolsName = `pe-employee4-pgtools-${suffix}`
  const ownToolHost = process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []
  toolsContainer = docker(['run', '-d', '--name', toolsName, ...ownToolHost, '--entrypoint', 'sleep', 'postgres:16-alpine', 'infinity'])
  const sourceParent = join(root, 'source'), targetParent = join(root, 'target')
  await mkdir(sourceParent, { mode: 0o700 }); await mkdir(targetParent, { mode: 0o700 })
  const roots = Object.fromEntries(labels.map(label => [label, join(sourceParent, label)]))
  for (const path of Object.values(roots)) await mkdir(path, { mode: 0o700 })
  const postgres = async (name, path) => {
    const url = new URL(adminUrl.href); url.pathname = '/' + name; url.username = role; url.password = password
    await writeFile(path, url.href, { mode: 0o600 })
    return { urlFile: path, database: name, role, tools: { container: toolsContainer, host: 'host.docker.internal', port: adminUrl.port } }
  }
  const sourcePg = await postgres(names[0], join(roots.privateConfig, 'database-url'))
  const source = await connectDatabase(sourcePg); clients.push(source.client)
  assert.equal((await source.client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper, false)
  assert.match(toolsContainer, /^[a-f0-9]{64}$/u)
  const pathTools = join(root, 'path-tools'); await mkdir(pathTools, { mode: 0o700 })
  await writeFile(join(pathTools, 'psql'), '#!/bin/sh\nexec docker exec -i --env PGDATABASE --env PGUSER --env PGPASSWORD --env PGHOST --env PGPORT --env PGCONNECT_TIMEOUT --env PGOPTIONS ' + toolsContainer + ' psql "$@"\n', { mode: 0o700 })
  const pathProgram = `import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{postgresTool}from ${JSON.stringify(new URL('./backup-postgres.mjs', import.meta.url).href)};
    const url=(await readFile(${JSON.stringify(sourcePg.urlFile)},'utf8')).trim();
    const output=postgresTool('psql',url,${JSON.stringify({ urlFile: sourcePg.urlFile, tools: { host: 'host.docker.internal', port: adminUrl.port } })},['--no-psqlrc','--tuples-only','--no-align','--command','SELECT current_user']);
    assert.equal(output.trim(),${JSON.stringify(role)});console.log('owned PATH libpq identity verified');`
  const pathRun = spawnSync(process.execPath, ['--input-type=module', '--eval', pathProgram],
    { env: { ...process.env, PATH: pathTools + ':' + process.env.PATH }, encoding: 'utf8', timeout: 30000 })
  assert.equal(pathRun.error, undefined); assert.equal(pathRun.signal, null); assert.equal(pathRun.status, 0, pathRun.stderr)
  assert.equal(pathRun.stdout.trim(), 'owned PATH libpq identity verified')
  await assert.rejects(connectDatabase({ ...sourcePg, role: role + '_different' }), /deployment identity/u)
  await assert.rejects(connectDatabase({ ...sourcePg, database: names[1] }), /deployment identity/u)
  const anotherToolUrl = new URL(source.url); anotherToolUrl.pathname = '/' + names[1]
  assert.throws(() => verifyTools({ ...source, url: anotherToolUrl.href }, sourcePg), /another database or role/u)
  assert.throws(() => postgresTool('psql', source.url, { ...sourcePg, tools: { binDir: join(root, 'absent-tools') } }, ['--version']), /psql failed/u)
  const mismatch = docker(['run', '-d', '--name', `pe-employee4-pg17-${suffix}`, ...ownToolHost,
    '--entrypoint', 'sleep', 'postgres:17-alpine', 'infinity'])
  try {
    assert.throws(() => verifyTools(source, { ...sourcePg, tools: { ...sourcePg.tools, container: mismatch } }), /server major version/u)
  }
  finally { docker(['stop', '--time', '5', mismatch]); docker(['rm', mismatch]) }
  const pool = new Pool({ connectionString: source.url, max: 2 })
  try { await initializeDatabase(pool) } finally { await pool.end() }
  const alice = randomUUID(), bob = randomUUID()
  await source.client.query('INSERT INTO pe_users(id,username,password_hash,settings,display_name) VALUES($1,$2,$3,$4,$2),($5,$6,$3,$4,$6)',
    [alice, 'employee4-alice', 'opaque-hash', { model: 'trial', maxTokens: 1000, revision: 1, unicode: '中文😀' }, bob, 'employee4-bob'])
  await source.client.query('INSERT INTO pe_credentials(digest,user_id,audience,expires_at,credential_version) VALUES($1,$2,$3,$4,1)',
    ['a'.repeat(64), alice, 'agent', '2026-10-09T12:34:56.123456Z'])
  await source.client.query('CREATE TABLE employee4_extra_column_manifest(value integer)')
  await assert.rejects(requireCurrentSchema(source.client), /table manifest differs/u)
  await source.client.query('DROP TABLE employee4_extra_column_manifest')
  await source.client.query("CREATE SEQUENCE employee4_restore_counter START 7; SELECT nextval('employee4_restore_counter')")
  await source.client.end(); clients.pop()
  for (const key of ['worker-token', 'model-key', 'connector-key', 'runner-key']) await writeFile(join(roots.privateConfig, key), randomUUID(), { mode: 0o600 })
  const nativeIntentKeyFile = join(roots.privateConfig, 'native-intent-key')
  await writeFile(nativeIntentKeyFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 })
  await writeFile(join(roots.workspaces, '原始.txt'), 'workspace bytes\0\n中文😀', { mode: 0o640 })
  await chmod(join(roots.workspaces, '原始.txt'), 0o640)
  await mkdir(join(roots.homes, 'empty-home'), { mode: 0o750 })
  await chmod(join(roots.homes, 'empty-home'), 0o750)
  await writeFile(join(roots.skillPackages, 'old-version.zip'), Buffer.from([0, 1, 2, 255]), { mode: 0o644 })
  await chmod(join(roots.skillPackages, 'old-version.zip'), 0o644)
  await writeFile(join(roots.attachments, 'original-file.bin'), Buffer.from([0, 4, 7, 255, 128]), { mode: 0o600 })
  await link(join(roots.attachments, 'original-file.bin'), join(roots.attachments, 'original-alias.bin'))
  await mkdir(join(roots.attachments, 'crash-staging'), { mode: 0o700 })
  await writeFile(join(roots.attachments, 'crash-staging/orphan.bin'), Buffer.from([31, 255, 128]), { mode: 0o600 })
  await writeFile(join(roots.officeCache, 'cached.pdf'), '%PDF-employee4-original-cache', { mode: 0o640 })
  await chmod(join(roots.officeCache, 'cached.pdf'), 0o640)
  const dshHome = join(sourceParent, 'dsh')
  const deployment = { mode: 'local-http', privateDir: roots.privateConfig, dshHome,
    hostOrigin: 'http://127.0.0.1:18880', platformOrigin: 'http://127.0.0.1:18881', platformInternalUrl: 'http://127.0.0.1:18881',
    rows: { platform: { 'web-server': { port: 0 }, 'power-evolve-platform': { workspaceRoot: roots.workspaces,
      attachmentRoot: roots.attachments, skillLibraryRoot: roots.skillPackages, nativeIntentKeyFile,
      seedUsersFile: '', accountManagementFile: '', preinstalledSkills: [] } },
    host: { 'web-server': { port: 0 } } } }
  const deploymentPath = join(sourceParent, 'deployment.json')
  await writeFile(deploymentPath, JSON.stringify(deployment), { mode: 0o600 })
  const profiles = ['host', 'platform'].map(name => join(dshHome, 'profiles', `power-evolve-cloud-${name}`))
  await runProfile(t, 'platform', deploymentPath, profiles[1], async (ready) => {
    const hostPath = join(sourceParent, 'host-deployment.json')
    await writeFile(hostPath, JSON.stringify({ ...deployment, platformInternalUrl: ready.url }), { mode: 0o600 })
    await runProfile(t, 'host', hostPath, profiles[0])
  })
  const config = { format: 1, bundle: join(root, 'backup'), postgres: sourcePg, roots, profiles, nativeIntentKeyFile }
  const duplicateHost = join(sourceParent, 'duplicate-host')
  await copyTree(profiles[0], duplicateHost, await inventoryTree(profiles[0]))
  await assert.rejects(createBackup({ ...config, profiles: [profiles[0], duplicateHost] }), /distinct Host and Platform/u)
  for (const path of [profiles[0], duplicateHost]) assert.equal(await privateJson(join(path + '.lifecycle-lock', 'instance.json')), null)
  const lifecycleFile = join(profiles[0], 'lifecycle.json'), stopped = await privateJson(lifecycleFile)
  const ownerFile = join(profiles[0], 'power-evolve-owner.json'), owner = await privateJson(ownerFile)
  try {
    await durableJson(ownerFile, { ...owner, format: 1 })
    await assert.rejects(createBackup(config), /stopped Profile evidence/u)
    await durableJson(ownerFile, { ...owner, deployment: undefined })
    await assert.rejects(createBackup(config), /stopped Profile evidence/u)
    await durableJson(ownerFile, owner)
    await durableJson(lifecycleFile, { ...stopped, phase: 'running' })
    await assert.rejects(createBackup(config), /stopped Profile evidence/u)
    await durableJson(lifecycleFile, { ...stopped, parent: { pid: process.pid, birth: 'current-owned-test' } })
    await assert.rejects(createBackup(config), /active or uncertain/u)
  } finally { await durableJson(lifecycleFile, stopped); await durableJson(ownerFile, owner) }
  await chmod(sourcePg.urlFile, 0o644)
  try { await assert.rejects(createBackup(config), /private regular files/u) }
  finally { await chmod(sourcePg.urlFile, 0o600) }
  await chmod(roots.attachments, 0o755)
  try { await assert.rejects(createBackup(config), /private and physical/u) }
  finally { await chmod(roots.attachments, 0o700) }
  for (const path of profiles) assert.equal(await privateJson(join(path + '.lifecycle-lock', 'instance.json')), null)
  const changedBundle = join(root, 'changed-backup'), concurrentSource = join(roots.workspaces, 'concurrent-owned-file')
  let changedAfterInventory = false
  const sourceWatcher = watch(root, (event, name) => {
    if (changedAfterInventory || !name?.toString().startsWith('changed-backup.') || !name.toString().endsWith('.partial')) return
    writeFileSync(concurrentSource, 'written after captured inventory', { mode: 0o600, flag: 'wx' }); changedAfterInventory = true
  })
  try { await assert.rejects(createBackup({ ...config, bundle: changedBundle }), /Backup source bytes or permissions changed/u) }
  finally { sourceWatcher.close(); await rm(concurrentSource, { force: true }) }
  assert.equal(changedAfterInventory, true)
  await assert.rejects(lstat(changedBundle), { code: 'ENOENT' })
  assert.equal((await readdir(root)).filter(name => name.startsWith('changed-backup.') && name.endsWith('.partial')).length, 1)
  for (const path of profiles) assert.equal(await privateJson(join(path + '.lifecycle-lock', 'instance.json')), null)
  const capture = await backupCli('create', config, join(root, 'create-config.json'))
  assert.equal(capture.schema, 8); assert.equal(capture.tables, 82); assert.equal(capture.keptStopped, true)
  const before = await inventoryTree(config.bundle)
  await assert.rejects(createBackup(config), /already exists/u)
  assert.deepEqual(await inventoryTree(config.bundle), before)
  const target = { ...config, postgres: await postgres(names[1], join(targetParent, 'database-url')),
    nativeIntentKeyFile: join(targetParent, 'privateConfig/native-intent-key'),
    roots: Object.fromEntries(labels.map(label => [label, join(targetParent, label)])), profiles: [join(targetParent, 'host-snapshot'), join(targetParent, 'platform-snapshot')] }
  const restored = await backupCli('restore', target, join(root, 'restore-config.json'))
  assert.equal(restored.schema, 8); assert.equal(restored.tables, 82)
  assert.equal(restored.allRowsVerified, true); assert.equal(restored.allFilesVerified, true)
  assert.equal(restored.readinessChecked, false)
  assert.deepEqual(await readFile(target.nativeIntentKeyFile), await readFile(nativeIntentKeyFile))
  const targetUrl = (await readFile(target.postgres.urlFile, 'utf8')).trim()
  assert.throws(() => postgresTool('psql', targetUrl, target.postgres,
    ['--no-psqlrc', '--command', 'SELECT employee4_function_does_not_exist()']), /psql failed/u)
  assert.deepEqual(await readFile(join(target.roots.attachments, 'original-file.bin')), Buffer.from([0, 4, 7, 255, 128]))
  assert.equal((await lstat(join(target.roots.attachments, 'original-file.bin'))).ino,
    (await lstat(join(target.roots.attachments, 'original-alias.bin'))).ino)
  assert.deepEqual(await readFile(join(target.roots.attachments, 'crash-staging/orphan.bin')), Buffer.from([31, 255, 128]))
  assert.equal((await lstat(join(target.roots.workspaces, '原始.txt'))).mode & 0o777, 0o640)
  const targetDatabase = await connectDatabase(target.postgres); clients.push(targetDatabase.client)
  await requireCurrentSchema(targetDatabase.client)
  assert.equal((await targetDatabase.client.query('SELECT count(*)::text AS n FROM pe_users')).rows[0].n, '2')
  assert.equal((await targetDatabase.client.query('SELECT expires_at::text FROM pe_credentials')).rows[0].expires_at, '2026-10-09 12:34:56.123456+00')
  assert.deepEqual((await targetDatabase.client.query('SELECT last_value::text,is_called FROM employee4_restore_counter')).rows,
    [{ last_value: '7', is_called: true }])
  await targetDatabase.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.deepEqual(await databaseCensus(targetDatabase.client), (await privateJson(join(config.bundle, 'manifest.json'))).census)
  await targetDatabase.client.query('COMMIT')
  await targetDatabase.client.end(); clients.pop()
  await assert.rejects(restoreBackup({ ...target, roots: Object.fromEntries(labels.map(label => [label, join(targetParent, 'second-' + label)])),
    nativeIntentKeyFile: join(targetParent, 'second-privateConfig/native-intent-key'),
    profiles: [join(targetParent, 'second-host'), join(targetParent, 'second-platform')] }), /not empty/u)
  assert.equal(await privateJson(join(targetParent, 'second-privateConfig', 'unused')), null)
  const occupiedConfig = await postgres(names[2], join(root, 'occupied-url'))
  let occupied = await connectDatabase(occupiedConfig); clients.push(occupied.client)
  await requireEmptyDatabase(occupied.client)
  await occupied.client.query(`ALTER DATABASE "${names[2]}" SET work_mem='8MB'`)
  await assert.rejects(requireEmptyDatabase(occupied.client), /not empty/u)
  await occupied.client.query(`ALTER DATABASE "${names[2]}" RESET ALL`)
  await occupied.client.query('CREATE SCHEMA employee4_occupied')
  await assert.rejects(requireEmptyDatabase(occupied.client), /not empty/u)
  await occupied.client.query('DROP SCHEMA employee4_occupied')
  await occupied.client.query('CREATE FUNCTION public.employee4_nonempty() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  await assert.rejects(requireEmptyDatabase(occupied.client), /not empty/u)
  await occupied.client.query('DROP FUNCTION public.employee4_nonempty()')
  await requireEmptyDatabase(occupied.client)
  await occupied.client.end(); clients.pop()
  const changedRoots = Object.fromEntries(labels.map(label => [label, join(targetParent, 'changed-' + label)]))
  let changedDuringRestore = false
  const targetWatcher = watch(targetParent, (event, name) => {
    if (changedDuringRestore || name?.toString() !== 'changed-workspaces') return
    writeFileSync(join(changedRoots.workspaces, 'concurrent-owned-file'), 'written during real restore', { mode: 0o600, flag: 'wx' }); changedDuringRestore = true
  })
  try { await assert.rejects(restoreBackup({ ...target, postgres: occupiedConfig, roots: changedRoots,
    nativeIntentKeyFile: join(changedRoots.privateConfig, 'native-intent-key'),
    profiles: [join(targetParent, 'changed-host'), join(targetParent, 'changed-platform')] }), /Restored file bytes, owners or permissions differ/u) }
  finally { targetWatcher.close() }
  assert.equal(changedDuringRestore, true)
  assert.equal(await readFile(join(changedRoots.workspaces, 'concurrent-owned-file'), 'utf8'), 'written during real restore')
  // Reset only this fixture's explicitly allocated random database before the next independent failure.
  occupied = await connectDatabase(occupiedConfig); clients.push(occupied.client)
  await occupied.client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await requireEmptyDatabase(occupied.client)
  const canceledRoots = Object.fromEntries(labels.map(label => [label, join(targetParent, 'canceled-' + label)]))
  const blockerPid = (await occupied.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const restoring = restoreBackup({ ...target, postgres: occupiedConfig, roots: canceledRoots,
    nativeIntentKeyFile: join(canceledRoots.privateConfig, 'native-intent-key'),
    profiles: [join(targetParent, 'canceled-host'), join(targetParent, 'canceled-platform')] }).then(
    () => ({ success: true }), error => ({ error }))
  let blockingObserved = false
  try {
    await observed(async () => (await occupied.client.query("SELECT to_regclass('public.pe_users') AS relation")).rows[0].relation)
    await occupied.client.query('BEGIN; LOCK TABLE pe_users IN ACCESS EXCLUSIVE MODE')
    await observed(async () => {
      await occupied.client.query('SELECT pg_stat_clear_snapshot()')
      const { rows } = await occupied.client.query(`SELECT pid FROM pg_stat_activity WHERE datname=$1 AND usename=current_user
        AND query LIKE 'DECLARE backup_rows%' AND query LIKE '%"pe_users"%' AND $2=ANY(pg_blocking_pids(pid))`, [names[2], blockerPid])
      if (rows.length !== 1) return false
      assert.equal((await occupied.client.query('SELECT pg_cancel_backend($1) AS canceled', [rows[0].pid])).rows[0].canceled, true)
      blockingObserved = true; return true
    })
  } finally { await occupied.client.query('ROLLBACK') }
  const canceled = await restoring
  assert.equal(blockingObserved, true); assert.equal(canceled.error?.code, '57014')
  for (const path of [...Object.values(canceledRoots), join(targetParent, 'canceled-host'), join(targetParent, 'canceled-platform')]) {
    await assert.rejects(lstat(path), { code: 'ENOENT' })
  }
  await occupied.client.end(); clients.pop()
  const legacyConfig = await postgres(names[3], join(root, 'legacy-url'))
  const legacy = await connectDatabase(legacyConfig); clients.push(legacy.client)
  await legacy.client.query("CREATE TABLE pe_schema(version integer,family text); INSERT INTO pe_schema VALUES(37,'legacy')")
  await assert.rejects(requireCurrentSchema(legacy.client), /Schema 8/u)
  assert.deepEqual((await legacy.client.query('SELECT version,family FROM pe_schema')).rows, [{ version: 37, family: 'legacy' }])
  await legacy.client.end(); clients.pop()
  const competing = await connectDatabase(sourcePg); clients.push(competing.client)
  const uncertainWorkspace = randomUUID(), uncertainSession = randomUUID()
  await competing.client.query('BEGIN')
  try {
    await competing.client.query('INSERT INTO pe_workspaces(id,user_id) VALUES($1,$2)', [uncertainWorkspace, alice])
    await competing.client.query('INSERT INTO pe_sessions(id,user_id,workspace_id,create_request_id,header) VALUES($1,$2,$3,$4,$5)',
      [uncertainSession, alice, uncertainWorkspace, randomUUID(), {}])
    await competing.client.query("INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,state) VALUES($1,$2,$3,'unknown')",
      [alice, uncertainSession, uncertainWorkspace])
    await assert.rejects(requireQuiescentDatabase(competing.client), /active or uncertain in pe_mount_slots/u)
  } finally { await competing.client.query('ROLLBACK') }
  await assert.rejects(createBackup({ ...config, bundle: join(root, 'concurrent-backup') }), /another connection/u)
  await competing.client.end(); clients.pop()
  const independentRoots = Object.fromEntries(labels.map(label => [label, join(targetParent, 'denied-' + label)]))
  await assert.rejects(restoreBackup({ ...target, postgres: await postgres(names[0], join(targetParent, 'source-url')),
    nativeIntentKeyFile: join(independentRoots.privateConfig, 'native-intent-key'),
    roots: independentRoots, profiles: [join(targetParent, 'denied-host'), join(targetParent, 'denied-platform')] }), /source database/u)
  const manifestFile = join(config.bundle, 'manifest.json'), checksumFile = join(config.bundle, 'manifest-digest.json')
  const manifestBytes = await readFile(manifestFile), checksumBytes = await readFile(checksumFile)
  try {
    await durableJson(checksumFile, { sha256: '0'.repeat(64) })
    await assert.rejects(restoreBackup(target), /manifest or digest/u)
    await writeFile(checksumFile, checksumBytes)
    const damaged = JSON.parse(manifestBytes)
    damaged.inventories.attachments[0].mode = 0o600
    const damagedBytes = JSON.stringify(damaged) + '\n'
    await writeFile(manifestFile, damagedBytes)
    await durableJson(checksumFile, { sha256: createHash('sha256').update(damagedBytes).digest('hex') })
    await assert.rejects(restoreBackup(target), /root inventory differs/u)
    const refusalDatabase = await connectDatabase(legacyConfig); clients.push(refusalDatabase.client)
    await refusalDatabase.client.query('DROP TABLE pe_schema')
    await requireEmptyDatabase(refusalDatabase.client)
    await refusalDatabase.client.end(); clients.pop()
    const mismatchedCensus = JSON.parse(manifestBytes)
    mismatchedCensus.census.tables.pe_users.rows += 1
    const mismatchedBytes = JSON.stringify(mismatchedCensus) + '\n'
    await writeFile(manifestFile, mismatchedBytes)
    await durableJson(checksumFile, { sha256: createHash('sha256').update(mismatchedBytes).digest('hex') })
    await assert.rejects(restoreBackup({ ...target, postgres: legacyConfig, roots: independentRoots,
      nativeIntentKeyFile: join(independentRoots.privateConfig, 'native-intent-key'),
      profiles: [join(targetParent, 'denied-host'), join(targetParent, 'denied-platform')] }), /Restored table rows/u)
    await assert.rejects(lstat(independentRoots.workspaces), { code: 'ENOENT' })
  } finally { await writeFile(manifestFile, manifestBytes); await writeFile(checksumFile, checksumBytes) }
  await writeFile(join(config.bundle, 'roots/attachments/original-file.bin'), Buffer.from([1, 2, 3]))
  await assert.rejects(restoreBackup(target), /integrity/u)
  await chmod(join(config.bundle, 'roots/attachments/original-file.bin'), 0o600)
})
