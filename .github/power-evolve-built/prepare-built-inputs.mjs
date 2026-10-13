/** Assemble built inputs from the current job's protected, qualified Schema37 cohort; this does not produce original business evidence. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertOwnedBuiltInputDirectory } from './owned-built-input-directory.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(repository, 'products/power-evolve/application/package.json'))
const { Pool } = require('pg')
const flags = new Map()
const allowed = new Set(['--out', '--owner', '--runner-temp', '--admin-url-file', '--legacy-fixture-file', '--build-log', '--chrome', '--evidence-root'])
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1]
  assert(allowed.has(key) && value && !flags.has(key), 'Invalid or missing explicit built preparation input')
  flags.set(key, key === '--owner' ? value : resolve(value))
}
for (const key of allowed) {
  assert(flags.has(key), key === '--legacy-fixture-file'
    ? 'Missing current-job qualified Schema37 fixture; historical local credentials/paths cannot be substituted'
    : 'Missing required built preparation flag: ' + key)
}
assert.equal(process.platform, 'linux', 'This fixture preparation belongs to the existing POSIX leg')
assert.equal(typeof process.getuid, 'function')
const out = flags.get('--out'), evidenceRoot = flags.get('--evidence-root')
await assertOwnedBuiltInputDirectory({ out, owner: flags.get('--owner'), runnerTemp: flags.get('--runner-temp'), empty: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownerTables = ['pe_sandbox_instances', 'pe_cloud_execution_resolutions', 'pe_stdio_v2_preparations',
  'pe_stdio_v2_decisions', 'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_results',
  'pe_stdio_v2_catalogs', 'pe_stdio_v2_observations']
const { replicasHelperSHA256: helperPins } = JSON.parse(await readFile(new URL('./schema37-producer/runtime-inputs.lock.json', import.meta.url), 'utf8'))
assert.deepEqual(Object.keys(helperPins).sort(), ['fault-proxy.mjs', 'identity-evidence.mjs', 'native-intent-key.mjs', 'replica-plan.mjs'])
async function privateBytes(file) {
  assert(isAbsolute(file), 'Private fixture input path must be absolute')
  const info = await lstat(file)
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o077) === 0 && info.size <= 8 * 1024 * 1024, 'Invalid owned private fixture input')
  return readFile(file)
}
async function privateDirectory(directory) {
  await mkdir(directory, { mode: 0o700 })
  const info = await lstat(directory)
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o077) === 0, 'Invalid private evidence directory')
}
async function json(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
// Validate the explicit producer output before creating any role or fixture output.
const fixturePath = flags.get('--legacy-fixture-file')
const fixture = JSON.parse((await privateBytes(fixturePath)).toString('utf8'))
assert.equal(fixture.version, 1)
assert.equal(fixture.expectedSchemaVersion, 6)
for (const key of ['cohortRoot', 'requestFixture', 'adminUrlFile', 'evidenceRoot']) assert(isAbsolute(fixture[key]))
const capture = JSON.parse((await privateBytes(join(fixture.cohortRoot, 'capture.json'))).toString('utf8'))
const physical = JSON.parse((await privateBytes(join(fixture.cohortRoot, 'physical-files.json'))).toString('utf8'))
const request = JSON.parse((await privateBytes(fixture.requestFixture)).toString('utf8'))
assert.equal(capture.format, 'power-evolve-legacy-offline')
assert.equal(capture.source.schema, 37)
assert.equal(request.mode, 'migrate')
assert(isDeepStrictEqual(request.source.identity, capture.source))
assert(isDeepStrictEqual(request.files, physical))
for (const table of ownerTables) assert(capture.tables[table]?.length > 0, 'Missing original owner fixture: ' + table)
await privateBytes(join(fixture.cohortRoot, 'cut-payload.json'))
const readonlyUrl = new URL((await privateBytes(join(fixture.cohortRoot, 'readonly-url-private'))).toString('utf8').trim())
const adminUrl = new URL((await privateBytes(flags.get('--admin-url-file'))).toString('utf8').trim())
assert(['127.0.0.1', 'localhost', '[::1]'].includes(adminUrl.hostname), 'Built admin URL must use its owned loopback mapping')
assert.equal(readonlyUrl.hostname, adminUrl.hostname)
assert.equal(readonlyUrl.port, adminUrl.port)
assert.equal(decodeURIComponent(readonlyUrl.pathname.slice(1)), request.source.expectedDatabase)
const browser = await lstat(flags.get('--chrome'))
assert(browser.isFile() && (browser.mode & 0o111) !== 0, 'An actual executable Chromium input is required')
const buildLog = await readFile(flags.get('--build-log'))
assert(buildLog.length > 0, 'The current application build log must not be empty')
await privateDirectory(evidenceRoot)
const browserEvidence = join(evidenceRoot, 'browser'), maintenanceEvidence = join(evidenceRoot, 'maintenance')
await privateDirectory(browserEvidence); await privateDirectory(maintenanceEvidence)
const helperRoot = join(out, 'replicas-helpers'); await privateDirectory(helperRoot)
for (const [name, expected] of Object.entries(helperPins)) {
  assert.match(expected, /^[a-f0-9]{64}$/u)
  const source = join(repository, '.github/power-evolve-built/replicas-helpers', name)
  assert.equal(hash(await readFile(source)), expected, 'Committed replicas helper differs from its reviewed fixture input')
  await copyFile(source, join(helperRoot, name)); await chmod(join(helperRoot, name), 0o600)
}
const admin = new Pool({ connectionString: adminUrl.href, max: 1, connectionTimeoutMillis: 10000 })
const source = new Pool({ connectionString: readonlyUrl.href, max: 1, connectionTimeoutMillis: 10000 })
const role = 'pe_ci_built_' + randomUUID().replaceAll('-', ''), password = randomBytes(32).toString('hex')
const ordinaryUrl = new URL(adminUrl); ordinaryUrl.username = role; ordinaryUrl.password = password
let created = false, published = false
try {
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.deepEqual((await source.query('SELECT version FROM pe_schema')).rows, [{ version: 37 }])
  for (const table of ownerTables) assert((await source.query('SELECT count(*)::integer AS count FROM ' + table)).rows[0].count > 0)
  await source.query('COMMIT')
  // Identifier and generated hexadecimal password are constrained here; no credential is printed or sent in argv.
  assert.match(role, /^[a-z0-9_]+$/u); assert.match(password, /^[a-f0-9]{64}$/u)
  await admin.query('CREATE ROLE "' + role + '" LOGIN PASSWORD \'' + password
    + '\' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS')
  created = true
  const ordinary = new Pool({ connectionString: ordinaryUrl.href, max: 1, connectionTimeoutMillis: 10000 })
  try {
    assert.deepEqual((await ordinary.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls '
      + 'FROM pg_roles WHERE rolname=current_user')).rows,
    [{ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }])
  } finally { await ordinary.end() }
  const ordinaryFile = join(out, 'ordinary-url-private')
  await writeFile(ordinaryFile, ordinaryUrl.href + '\n', { mode: 0o600, flag: 'wx' })
  const builtFixtureFile = join(out, 'maintenance-fixture.json')
  await json(builtFixtureFile, { version: 1, cohortRoot: fixture.cohortRoot, requestFixture: fixture.requestFixture,
    adminUrlFile: flags.get('--admin-url-file'), evidenceRoot: maintenanceEvidence, expectedSchemaVersion: 6 })
  const env = { PE_TEST_DATABASE_URL_FILE: flags.get('--admin-url-file'), PE_TEST_ORDINARY_DATABASE_URL_FILE: ordinaryFile,
    PE_EMPLOYEE5_BUILT_MAINTENANCE_FIXTURE: builtFixtureFile, PE_E2E_EVIDENCE_DIR: browserEvidence,
    PE_E2E_REPLICAS_HELPERS_DIR: helperRoot, PE_E2E_BUILD_LOG: flags.get('--build-log'),
    PE_E2E_CHROME: flags.get('--chrome'), PE_E2E_HEADLESS: '1', PE_E2E_HOLD_ON_FAILURE: '0' }
  await json(join(out, 'environment.private.json'), env)
  await json(join(evidenceRoot, 'prepared-input-binding.json'), { fixtureProducerOutputSha256: hash(await privateBytes(fixturePath)),
    captureSha256: hash(await privateBytes(join(fixture.cohortRoot, 'capture.json'))), helpers: helperPins,
    currentBuildLogSha256: hash(buildLog), ordinaryRole: role, ordinaryPrivilegesVerified: true,
    noModelBrowserOrBuiltTestStartedByPreparer: true, schema37ProducerWasExplicitCurrentJobInput: true })
  published = true
  console.log(JSON.stringify({ environmentFile: join(out, 'environment.private.json'), prepared: true }))
} finally {
  await source.end()
  try { if (created && !published) await admin.query('DROP ROLE "' + role + '"') }
  finally { await admin.end() }
}
