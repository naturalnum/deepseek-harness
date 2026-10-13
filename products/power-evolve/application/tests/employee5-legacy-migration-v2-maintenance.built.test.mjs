/** Plain-Node maintenance Profile consumers of a retained, readonly Schema37 inventory. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const application = join(repo, 'products/power-evolve/application')
const required = createRequire(join(application, 'package.json'))
const { Pool } = required('pg')
const entry = '@power-evolve/application/legacy-migration-v2-maintenance'
const maintenance = join(application, 'lib/platform/legacy-migration-v2-maintenance.js')
const cli = join(repo, 'apps/cli/lib/bin.js')
const ownerTables = ['pe_sandbox_instances', 'pe_cloud_execution_resolutions', 'pe_stdio_v2_preparations',
  'pe_stdio_v2_decisions', 'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_results',
  'pe_stdio_v2_catalogs', 'pe_stdio_v2_observations']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function protectedBytes(path) {
  assert.ok(isAbsolute(path), 'Private input must use an absolute path')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    assert.ok(before.isFile() && before.uid === process.getuid() && (before.mode & 0o077) === 0
      && before.size <= 8 * 1024 * 1024, 'Private input must be an owned, bounded regular file')
    const bytes = await handle.readFile(), after = await handle.stat()
    assert.equal(after.size, before.size)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(bytes.byteLength, before.size)
    return bytes
  } finally { await handle.close() }
}

async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

async function fixture() {
  const path = process.env.PE_EMPLOYEE5_BUILT_MAINTENANCE_FIXTURE
  assert.ok(path, 'Built maintenance requires its retained private fixture')
  const input = JSON.parse((await protectedBytes(path)).toString('utf8'))
  assert.equal(input.version, 1)
  assert.ok(Number.isInteger(input.expectedSchemaVersion) && input.expectedSchemaVersion > 2)
  for (const field of ['cohortRoot', 'requestFixture', 'adminUrlFile', 'evidenceRoot']) assert.ok(isAbsolute(input[field]))
  const evidence = await lstat(input.evidenceRoot)
  assert.ok(evidence.isDirectory() && !evidence.isSymbolicLink() && evidence.uid === process.getuid()
    && (evidence.mode & 0o077) === 0, 'Built evidence requires an owned private directory')
  const capture = JSON.parse((await protectedBytes(join(input.cohortRoot, 'capture.json'))).toString('utf8'))
  assert.equal(capture.source.schema, 37)
  assert.equal(capture.format, 'power-evolve-legacy-offline')
  for (const table of ownerTables) assert.ok(capture.tables[table].length > 0, `Original owner missing: ${table}`)
  const request = JSON.parse((await protectedBytes(input.requestFixture)).toString('utf8'))
  assert.equal(request.mode, 'migrate')
  assert.deepEqual(request.source.identity, capture.source)
  assert.deepEqual(request.files,
    JSON.parse((await protectedBytes(join(input.cohortRoot, 'physical-files.json'))).toString('utf8')))
  return { ...input, capture, request }
}

async function artifactSnapshot() {
  const files = ['pnpm-lock.yaml', 'apps/cli/package.json', 'products/power-evolve/application/package.json',
    'products/power-evolve/contracts/package.json']
  async function collect(directory) {
    const entries = await readdir(join(repo, directory), { withFileTypes: true })
    for (const item of entries) {
      assert.ok(!item.isSymbolicLink(), 'Candidate artifact inventory cannot contain symlinks')
      const path = join(directory, item.name)
      if (item.isDirectory()) await collect(path)
      else if (item.isFile() && item.name.endsWith('.js')) files.push(path)
    }
  }
  for (const directory of ['apps/cli/lib', 'products/power-evolve/application/lib', 'products/power-evolve/contracts/lib']) {
    await collect(directory)
  }
  assert.ok(files.includes(relative(repo, maintenance)))
  assert.ok(files.includes(relative(repo, cli)))
  const hashes = {}
  for (const file of files.sort()) hashes[file] = digest(await readFile(join(repo, file)))
  return hashes
}

function normalizedRows(rows) {
  return rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).sort()
}

function sqlIdentifier(value) {
  assert.match(value, /^[a-z_][a-z0-9_]*$/u)
  return `"${value}"`
}

async function readonlyInventory(input) {
  const sourceUrl = new URL((await protectedBytes(join(input.cohortRoot, 'readonly-url-private'))).toString('utf8').trim())
  assert.equal(decodeURIComponent(sourceUrl.pathname.slice(1)), input.request.source.expectedDatabase)
  const source = new Pool({ connectionString: sourceUrl.href, max: 1, connectionTimeoutMillis: 5000 })
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const state = (await source.query("SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly")).rows[0]
    assert.equal(state.database, input.request.source.expectedDatabase)
    assert.equal(state.readonly, 'on')
    assert.deepEqual((await source.query('SELECT version FROM pe_schema')).rows, [{ version: 37 }])
    const projections = {}, rowHashes = {}
    for (const table of ownerTables) {
      const columns = (await source.query('SELECT column_name,data_type FROM information_schema.columns '
        + "WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows
      assert.deepEqual(columns.map(column => column.column_name).sort(), Object.keys(input.capture.tables[table][0]).sort())
      projections[table] = columns.map(column => column.data_type === 'timestamp with time zone'
        ? `to_char(${sqlIdentifier(column.column_name)} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${sqlIdentifier(column.column_name)}`
        : `${sqlIdentifier(column.column_name)}::text AS ${sqlIdentifier(column.column_name)}`).join(',')
      const rows = (await source.query(`SELECT ${projections[table]} FROM ${sqlIdentifier(table)}`)).rows
      assert.deepEqual(normalizedRows(rows), normalizedRows(input.capture.tables[table]))
      rowHashes[table] = digest(JSON.stringify(normalizedRows(rows)))
    }
    await source.query('COMMIT')
    return { sourceUrl, projections, rowHashes }
  } finally { await source.end() }
}

function within(root, path) {
  const suffix = relative(root, path)
  assert.ok(suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'Fixture path escaped its owned root')
  return path
}

async function migrateRequest(input, root, sourceUrl, targetUrl) {
  const request = structuredClone(input.request)
  const payload = (await protectedBytes(join(input.cohortRoot, 'cut-payload.json'))).toString('utf8')
  const keys = generateKeyPairSync('ed25519')
  await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'employee5-built',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
  await privateJson(join(root, 'cut.json'), { keyId: 'employee5-built', payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
  await mkdir(join(root, 'bundle'), { mode: 0o700 })
  for (const file of request.files) if (file.kind === 'file' && file.sourcePath !== null) {
    const source = within(join(input.cohortRoot, 'detached-files'), resolve(input.cohortRoot, 'detached-files', file.sourcePath))
    const destination = within(join(root, 'bundle'), resolve(root, 'bundle', file.sourcePath))
    const bytes = await readFile(source)
    assert.equal(digest(bytes), file.sha256)
    assert.equal(String(bytes.byteLength), file.bytes)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, bytes, { flag: 'wx', mode: file.mode })
    await chmod(destination, file.mode)
  }
  await writeFile(join(root, 'source-url'), sourceUrl.href, { flag: 'wx', mode: 0o600 })
  await writeFile(join(root, 'target-url'), targetUrl.href, { flag: 'wx', mode: 0o600 })
  request.migrationId = randomUUID()
  request.outputFile = join(root, 'output.json')
  request.failureEvidenceFile = join(root, 'failure.json')
  request.evidenceFile = join(root, 'cut.json')
  request.trustedEvidenceKeysFile = join(root, 'keys.json')
  request.source.urlFile = join(root, 'source-url')
  request.target.urlFile = join(root, 'target-url')
  request.target.expectedDatabase = decodeURIComponent(targetUrl.pathname.slice(1))
  request.initializeCurrent = true
  request.storage = { ...request.storage, bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'),
    targetUid: process.getuid(), targetGid: process.getgid() }
  return request
}

async function launch(root, request, expectedCode) {
  const home = join(root, 'home'), profile = `employee5-built-${randomUUID()}`
  const directory = join(home, 'profiles', profile), rawDirectory = join(root, 'v8')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(rawDirectory, { mode: 0o700 })
  await privateJson(join(directory, 'package.json'), { name: `dsh-profile-${profile}`, private: true, type: 'module',
    dsh: { profile: { bundles: [] } }, dependencies: { '@power-evolve/application': `file:${application}` } })
  await mkdir(join(directory, 'node_modules', '@power-evolve'), { recursive: true, mode: 0o700 })
  await symlink(application, join(directory, 'node_modules', '@power-evolve', 'application'))
  assert.equal(createRequire(join(directory, 'package.json')).resolve(entry), maintenance)
  await privateJson(join(root, 'request.json'), request)
  const witness = join(directory, 'process-witness.mjs'), witnessOutput = join(root, 'process-witness.json')
  await writeFile(witness, `import {writeFileSync} from 'node:fs'\nimport {threadId} from 'node:worker_threads'\nexport const name='employee5-built-process'\nexport function apply(){writeFileSync(${JSON.stringify(witnessOutput)},JSON.stringify({pid:process.pid,threadId}),{flag:'wx',mode:0o600})}\n`, { flag: 'wx', mode: 0o600 })
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: employee5-built-process\n      name: '${pathToFileURL(witness).href}'\n    - id: employee5-built-maintenance\n      name: '${entry}'\n      config:\n        requestFile: '${join(root, 'request.json')}'\n        maxRequestBytes: 1048576\n        maxEvidenceBytes: 1048576\n        maxKeyBytes: 65536\n`, { flag: 'wx', mode: 0o600 })
  const stop = new AbortController(), deadline = setTimeout(() => { stop.abort() }, 60000)
  const log = await open(join(root, 'loader-output.log'), 'wx', 0o600)
  let processError
  try {
    const child = spawn(process.execPath, [cli, '--profile', profile], { cwd: repo,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
        DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_V8_COVERAGE: rawDirectory },
      signal: stop.signal, stdio: ['ignore', log.fd, log.fd] })
    const result = await new Promise((done) => {
      child.once('error', (error) => { processError = error })
      child.once('close', (exitCode, signal) => { done({ exitCode, signal }) })
    })
    let loadedArtifacts, witnessProcess, bindingError
    try {
      witnessProcess = JSON.parse((await protectedBytes(witnessOutput)).toString('utf8'))
      assert.equal(witnessProcess.pid, child.pid)
      assert.equal(witnessProcess.threadId, 0)
      const coverageFiles = (await readdir(rawDirectory)).filter(name => name.startsWith(`coverage-${child.pid}-`) && name.endsWith('-0.json'))
      assert.ok(coverageFiles.length > 0, 'Built child did not complete native V8 capture')
      const urls = new Set(), executed = new Set()
      for (const file of coverageFiles) {
        const captured = JSON.parse(await readFile(join(rawDirectory, file), 'utf8'))
        for (const script of captured.result) {
          urls.add(script.url)
          if (script.functions.some(fn => fn.ranges.some(range => range.count > 0))) executed.add(script.url)
        }
      }
      for (const artifact of [cli, maintenance]) {
        assert.ok(executed.has(pathToFileURL(artifact).href), 'Built entry was not executed')
      }
      const sourceFallbacks = [...urls].filter(url => url.startsWith(pathToFileURL(repo + sep).href)
        && relative(repo, fileURLToPath(url)).split(sep).includes('src')
        && !relative(repo, fileURLToPath(url)).split(sep).includes('node_modules'))
      assert.deepEqual(sourceFallbacks, [], 'Built Profile loaded workspace source')
      loadedArtifacts = { coverageFiles: coverageFiles.map(file => join(rawDirectory, file)),
        executedEntries: [cli, maintenance],
        loadedWorkspaceUrls: [...urls].filter(url => url.startsWith(pathToFileURL(repo + sep).href)).sort(),
        sourceFallbacks }
    } catch (error) { bindingError = error }
    let resultSha256 = null
    try { resultSha256 = digest(await readFile(request.outputFile)) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await privateJson(join(root, 'launch.json'), { plane: 'artifact', cli: [process.execPath, cli, '--profile', profile],
      maintenanceExport: entry, resolvedMaintenance: maintenance, childPid: child.pid ?? null, witnessProcess,
      expectedCode, ...result, timedOut: stop.signal.aborted, loadedArtifacts,
      bindingFailure: bindingError instanceof Error ? bindingError.message : null,
      processError: processError?.message ?? null, requestSha256: digest(await readFile(join(root, 'request.json'))), resultSha256 })
    assert.equal(stop.signal.aborted, false)
    assert.ok(child.pid > 0)
    assert.equal(result.signal, null)
    assert.equal(processError, undefined)
    assert.equal(result.exitCode, expectedCode, 'Inspect the retained private loader log for the actual child failure')
    if (bindingError !== undefined) throw bindingError
    return expectedCode === 0 ? JSON.parse((await protectedBytes(request.outputFile)).toString('utf8')) : null
  } finally { clearTimeout(deadline); await log.close() }
}

async function verifyFiles(request, output) {
  const areas = { workspace: file => join(output.storage.roots.workspaceRoot, file.resource, file.path),
    home: file => join(output.storage.roots.sandboxLocalRoot, 'homes', file.owner, file.path),
    'skill-text': file => join(output.storage.roots.workspaceRoot, 'extensions', file.owner, `${file.resource}.md`),
    'skill-package': file => file.path === 'archive.zip'
      ? join(output.storage.root, 'legacy-backup', 'skill-archives', file.owner, file.resource, 'archive.zip')
      : join(output.storage.roots.skillLibraryRoot, 'skill-packages', file.owner, 'sha256', file.resource, file.path),
    office: file => join(output.storage.roots.officeRoot, file.resource, file.path) }
  for (const file of request.files) {
    const path = within(output.storage.root, areas[file.area](file)), stat = await lstat(path)
    assert.equal(stat.isSymbolicLink(), false)
    assert.equal(stat.isDirectory(), file.kind === 'directory')
    assert.equal(stat.isFile(), file.kind === 'file')
    assert.equal(stat.mode & 0o777, file.mode)
    assert.equal(stat.uid, process.getuid())
    assert.equal(stat.gid, process.getgid())
    if (file.kind === 'file') {
      assert.equal(digest(await readFile(path)), file.sha256)
      assert.equal(String(stat.size), file.bytes)
    }
  }
}

async function runCase(label, consume) {
  const input = await fixture(), root = await mkdtemp(join(input.evidenceRoot, `${label}-`))
  const before = await artifactSnapshot(), original = await readonlyInventory(input)
  const adminUrl = new URL((await protectedBytes(input.adminUrlFile)).toString('utf8').trim())
  const suffix = randomUUID().replaceAll('-', ''), role = `pe_e5_built_${suffix}`, database = `${role}_target`
  const targetUrl = new URL(adminUrl)
  targetUrl.pathname = `/${database}`; targetUrl.username = role; targetUrl.password = randomUUID()
  const admin = new Pool({ connectionString: adminUrl.href, max: 1, connectionTimeoutMillis: 5000 })
  const target = new Pool({ connectionString: targetUrl.href, max: 1, connectionTimeoutMillis: 5000 })
  let roleCreated = false, databaseCreated = false, passed = false
  try {
    await privateJson(join(root, 'artifact-before.json'), before)
    await admin.query(`CREATE ROLE ${sqlIdentifier(role)} LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    roleCreated = true
    await admin.query(`CREATE DATABASE ${sqlIdentifier(database)} OWNER ${sqlIdentifier(role)}`)
    databaseCreated = true
    const privileges = (await target.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls '
      + 'FROM pg_roles WHERE rolname=current_user')).rows
    assert.deepEqual(privileges, [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolreplication: false, rolbypassrls: false }])
    const request = await migrateRequest(input, root, original.sourceUrl, targetUrl)
    await consume({ input, root, request, target, original })
    assert.deepEqual((await readonlyInventory(input)).rowHashes, original.rowHashes)
    passed = true
  } finally {
    const closed = await Promise.allSettled([target.end()])
    try {
      assert.equal(closed[0].status, 'fulfilled')
      if (databaseCreated) await admin.query(`DROP DATABASE ${sqlIdentifier(database)}`)
      if (roleCreated) await admin.query(`DROP ROLE ${sqlIdentifier(role)}`)
    } finally {
      await admin.end()
      const after = await artifactSnapshot()
      await privateJson(join(root, 'artifact-after.json'), after)
      await privateJson(join(root, 'case.json'), { label, passed: passed && JSON.stringify(before) === JSON.stringify(after),
        readonlySourceSchema: 37,
        currentSchemaVersion: input.expectedSchemaVersion, sourceRowHashes: original.rowHashes,
        artifactUnchanged: JSON.stringify(before) === JSON.stringify(after), systemMigrationComplete: false })
      assert.deepEqual(after, before, 'Candidate App/CLI artifacts changed during their consumer case')
    }
  }
}

test('built public maintenance captures the readonly original inventory', { timeout: 90000 }, async () => {
  await runCase('capture', async ({ input, root, request, target }) => {
    const captureRequest = Object.fromEntries(['format', 'version', 'migrationId', 'limits', 'phaseTimeoutMs',
      'outputFile', 'failureEvidenceFile', 'source'].map(key => [key, request[key]]))
    const output = await launch(root, { ...captureRequest, mode: 'capture' }, 0)
    assert.equal(output.phase, 'captured')
    assert.equal(output.systemMigrationComplete, false)
    assert.deepEqual(output.capture.source, input.capture.source)
    assert.equal(output.capture.catalogSha256, input.capture.catalogSha256)
    for (const [table, rows] of Object.entries(input.capture.tables)) {
      assert.deepEqual(normalizedRows(output.capture.tables[table]), normalizedRows(rows))
    }
    assert.deepEqual((await target.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows, [])
  })
})

test('built public maintenance retains nine original owners in an ordinary-role current database', { timeout: 90000 }, async () => {
  await runCase('nine-owner', async ({ input, request, root, target, original }) => {
    const output = await launch(root, request, 0)
    assert.equal(output.phase, 'current-schema-initialized')
    assert.equal(output.version, input.expectedSchemaVersion)
    assert.equal(output.systemMigrationComplete, false)
    assert.deepEqual((await target.query('SELECT version FROM pe_schema')).rows, [{ version: input.expectedSchemaVersion }])
    const owners = {}
    for (const table of ownerTables) {
      const rows = (await target.query(`SELECT ${original.projections[table]} FROM ${sqlIdentifier(table)}`)).rows
      assert.deepEqual(normalizedRows(rows), normalizedRows(input.capture.tables[table]))
      assert.equal(output.tableCounts[table], String(rows.length))
      owners[table] = { rows: rows.length, sha256: digest(JSON.stringify(normalizedRows(rows))) }
    }
    await verifyFiles(request, output)
    await privateJson(join(root, 'nine-owners.json'), { owners, files: request.files.length,
      fileBytesRetained: true, ordinaryRole: true, systemMigrationComplete: false })
  })
})

test('built public maintenance refuses an unsigned cut before target publication', { timeout: 90000 }, async () => {
  await runCase('unsigned-cut', async ({ root, request, target }) => {
    const envelope = JSON.parse((await protectedBytes(request.evidenceFile)).toString('utf8'))
    await writeFile(request.evidenceFile, JSON.stringify({ ...envelope, signature: '' }) + '\n', { mode: 0o600 })
    await launch(root, request, 1)
    const failure = JSON.parse((await protectedBytes(request.failureEvidenceFile)).toString('utf8'))
    assert.deepEqual(failure, { phase: 'failed', code: 'maintenance_cut_signature', systemMigrationComplete: false })
    assert.deepEqual((await target.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows, [])
    await assert.rejects(lstat(request.storage.candidateRoot), { code: 'ENOENT' })
    await assert.rejects(lstat(request.outputFile), { code: 'ENOENT' })
  })
})
