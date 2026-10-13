/** Seal actual stopped source37 fixture records and verify the current built ordinary-role bootstrap. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { constants } from 'node:fs'
import { chown, lstat, mkdir, open, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { reserveProfile, superviseChild } from '/opt/power-evolve/products/power-evolve/deploy/lifecycle.mjs'

const p = JSON.parse(await readFile(process.argv[2], 'utf8')), out = '/pe-ci-data', cohort = join(out, 'cohort')
const inputsLock = JSON.parse(await readFile(new URL('./runtime-inputs.lock.json', import.meta.url), 'utf8'))
assert.match(inputsLock.sourceCommit, /^[a-f0-9]{40}$/u)
assert.equal(p.sourceCommit, inputsLock.sourceCommit)
const current = '/opt/power-evolve', application = join(current, 'products/power-evolve/application')
const { Pool } = createRequire(join(application, 'package.json'))('pg')
const built = file => import(pathToFileURL(join(application, 'lib/platform', file + '.js')).href)
const { legacyDigest, legacyRowDigest } = await built('legacy-import-codec')
const { LEGACY_SQL_DIGESTS, LEGACY_SOURCE_LAYOUT } = await built('legacy-import-layout')
const { legacyMigrationCatalogDigest } = await built('legacy-migration-v2-source')
const { createLegacyMigrationStdioDiscoveryContext } = await built('legacy-migration-v2-stdio-discovery')
const { createLegacyMigrationCloudResolutionContext } = await built('legacy-migration-v2-cloud-resolution')
const { CURRENT_SCHEMA_VERSION } = await built('database')
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const decode = async file => JSON.parse(await readFile(file, 'utf8'))
const quote = (value) => { assert.match(value, /^[a-z_][a-z0-9_]*$/u); return '"' + value + '"' }
const owners = ['pe_sandbox_instances', 'pe_cloud_execution_resolutions', 'pe_stdio_v2_preparations',
  'pe_stdio_v2_decisions', 'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_results',
  'pe_stdio_v2_catalogs', 'pe_stdio_v2_observations']
const limits = { maxBundleBytes: 4194304, maxRows: 2000, maxCellBytes: 262144, maxJsonDepth: 40,
  maxJsonNodes: 40000, maxFiles: 100, maxFileBytes: 65536, maxStorageBytes: 262144 }
await mkdir(cohort, { mode: 0o700 }); await mkdir(join(cohort, 'detached-files'), { mode: 0o700 })

// Runtime evidence must show original source execution; no archived compiled lib may participate.
const originalExecutions = {}
for (const role of ['bootstrap', 'stdio', 'resolution']) {
  const directory = join(out, 'generated', role, 'v8'), executed = new Set()
  for (const file of await readdir(directory)) {
    if (!file.startsWith('coverage-') || !file.endsWith('.json')) continue
    for (const script of (await decode(join(directory, file))).result) {
      assert(!script.url.startsWith('file:///opt/pe-ci-original/') || !script.url.includes('/lib/'), 'Archived compiled lib was loaded')
      if (script.functions.some(fn => fn.ranges.some(range => range.count > 0))) executed.add(script.url)
    }
  }
  const needed = ['database.ts', 'identity.ts', ...role === 'stdio' ? ['stdio-v2-authorization.ts', 'stdio-v2-results.ts', 'sandbox.ts']
    : role === 'resolution' ? ['executions.ts', 'cloud-execution-resolution.ts', 'sandbox.ts'] : []]
  for (const name of needed) assert(executed.has('file:///opt/pe-ci-original/products/power-evolve/application/src/platform/' + name),
    'Original fixture source was not executed: ' + role + '/' + name)
  originalExecutions[role] = [...executed].filter(url => url.startsWith('file:///opt/pe-ci-original/')).sort()
}
async function launch(label, request) {
  const root = join(out, label), directory = join(root, 'home/profiles', 'ci-current-' + randomUUID())
  const lock = await reserveProfile(directory, p.owner), name = directory.split('/').at(-1)
  await mkdir(join(directory, 'node_modules/@power-evolve'), { recursive: true, mode: 0o700 })
  await json(join(directory, 'package.json'), { name: 'dsh-profile-' + name, private: true, type: 'module',
    dsh: { profile: { bundles: [] } }, dependencies: { '@power-evolve/application': 'file:' + application } })
  await symlink(application, join(directory, 'node_modules/@power-evolve/application'))
  const requestFile = join(root, 'request.json'), entry = '@power-evolve/application/legacy-migration-v2-maintenance'
  const module = join(application, 'lib/platform/legacy-migration-v2-maintenance.js'), cli = join(current, 'apps/cli/lib/bin.js')
  assert.equal(createRequire(join(directory, 'package.json')).resolve(entry), module)
  await json(requestFile, request)
  await writeFile(join(directory, 'cordis.patch.yml'), '- insert:\n    - id: current-maintenance\n      name: ' + JSON.stringify(entry)
    + '\n      config:\n        requestFile: ' + JSON.stringify(requestFile)
    + '\n        maxRequestBytes: 1048576\n        maxEvidenceBytes: 1048576\n        maxKeyBytes: 65536\n', { flag: 'wx', mode: 0o600 })
  const coverage = join(root, 'v8'); await mkdir(coverage, { mode: 0o700 })
  const log = await open(join(root, 'loader.log'), 'wx', 0o600)
  try {
    const child = spawn(process.execPath, [cli, '--profile', name], { cwd: current, shell: false,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', DSH_HOME: join(root, 'home'),
        DSH_TELEMETRY_DISABLED: '1', NODE_V8_COVERAGE: coverage }, stdio: ['ignore', log.fd, log.fd] })
    const exit = await superviseChild(child, lock, join(root, 'lifecycle.json'))
    assert.deepEqual(exit, { code: 0, signal: null })
    const executed = new Set(), urls = new Set()
    for (const file of await readdir(coverage)) for (const script of (await decode(join(coverage, file))).result) {
      urls.add(script.url)
      if (script.functions.some(fn => fn.ranges.some(range => range.count > 0))) executed.add(script.url)
    }
    for (const file of [cli, module]) assert(executed.has(pathToFileURL(file).href), 'Current built entry did not execute')
    const sourceFallbacks = [...urls].filter(url => url.startsWith('file:///opt/pe-ci-original/')
      || url.startsWith(pathToFileURL(current + sep).href) && relative(current, fileURL(url)).split(sep).includes('src')
        && !relative(current, fileURL(url)).split(sep).includes('node_modules'))
    assert.deepEqual(sourceFallbacks, [])
    await json(join(root, 'built-profile-binding.json'), { exit, childPid: child.pid, plainNode: true,
      sourceFallbacks,
      executedEntries: [cli,
        module],
      cliSHA256: legacyDigest(await readFile(cli)),
      maintenanceSHA256: legacyDigest(await readFile(module)) },
    )
    return decode(request.outputFile)
  } finally { await log.close() }
}
function fileURL(url) { return decodeURIComponent(new URL(url).pathname) }

/** Enumerate stopped original Workspace/Home trees and detach their actual bytes without changing source metadata. */
async function capturePhysicalInventory({ dataRoot, bundleRoot, tables, sourceUid, sourceGid, limits }) {
  assert.equal(await realpath(dataRoot), dataRoot)
  const files = [], raw = [], seen = new Set()
  let totalBytes = 0
  const fact = stat => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
    size: stat.size, nlink: stat.nlink, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
  const stable = (before, after) => assert.deepEqual(fact(after), fact(before), 'Stopped original storage changed during export')
  const names = async directory => (await readdir(directory, { encoding: 'buffer' })).map((bytes) => {
    const name = bytes.toString('utf8')
    assert(Buffer.from(name).equals(bytes) && name && !['.', '..'].includes(name) && !/[\\/\u0000-\u001f\u007f]/u.test(name),
      'Original storage has an unsupported filename')
    return name
  }).sort()
  async function walk(scope, root, path = '') {
    assert(path.split('/').length <= 16 && files.length < limits.maxFiles, 'Original physical inventory exceeds its bound')
    const actual = join(root, path), before = await lstat(actual)
    assert(!before.isSymbolicLink() && (before.isDirectory() || before.isFile()) && (before.mode & 0o7000) === 0,
      'Original physical inventory contains a link or special entry')
    assert.equal(before.uid, sourceUid); assert.equal(before.gid, sourceGid)
    const entry = { ...scope, path, kind: before.isDirectory() ? 'directory' : 'file', sourcePath: null,
      bytes: null, sha256: null, mode: before.mode & 0o777, uid: before.uid, gid: before.gid }
    const observation = { ...scope, path, actualSourcePath: actual, before: fact(before) }
    files.push(entry); raw.push(observation)
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | (before.isDirectory() ? constants.O_DIRECTORY : 0))
    try {
      stable(before, await handle.stat())
      if (before.isDirectory()) {
        const children = await names(actual)
        assert(children.length <= limits.maxFiles - files.length, 'Original directory exceeds its inventory bound')
        observation.children = children
        for (const child of children) await walk(scope, root, path ? path + '/' + child : child)
        assert.deepEqual(await names(actual), children, 'Stopped original directory entries changed during export')
      } else {
        assert.equal(before.nlink, 1, 'Original physical inventory contains a hard link')
        assert(before.size <= limits.maxFileBytes && totalBytes + before.size <= limits.maxStorageBytes,
          'Original physical bytes exceed their export bound')
        const bytes = await handle.readFile()
        assert.equal(bytes.length, before.size)
        totalBytes += bytes.length
        entry.sourcePath = String(raw.length - 1) + '.bin'; entry.bytes = String(bytes.length); entry.sha256 = legacyDigest(bytes)
        const detached = await open(join(bundleRoot, entry.sourcePath), 'wx', 0o600)
        try {
          await detached.writeFile(bytes)
          await detached.chown(entry.uid, entry.gid); await detached.chmod(entry.mode)
          observation.detached = fact(await detached.stat())
          assert.equal(observation.detached.uid, entry.uid); assert.equal(observation.detached.gid, entry.gid)
          assert.equal(observation.detached.mode & 0o777, entry.mode); assert.equal(observation.detached.size, bytes.length)
        } finally { await detached.close() }
        observation.sha256 = entry.sha256
      }
      observation.after = fact(await handle.stat()); stable(before, await handle.stat())
      stable(before, await lstat(actual))
    } finally { await handle.close() }
  }
  const groups = [
    { area: 'workspace', directory: join(dataRoot, 'workspaces'), roots: tables.pe_storage_spaces.map((space) => {
      assert.equal(space.root_state, 'ready')
      return { owner: space.user_id, resource: space.root_key }
    }) },
    { area: 'home', directory: join(dataRoot, 'homes'), roots: tables.pe_users.map(user => ({ owner: user.id, resource: user.id })) },
  ]
  for (const group of groups) {
    assert.equal(await realpath(group.directory), group.directory)
    const before = await lstat(group.directory); assert(before.isDirectory() && !before.isSymbolicLink())
    const expected = group.roots.map((scope) => {
      assert.match(scope.owner, /^[a-f0-9-]{36}$/u); assert.match(scope.resource, /^[a-f0-9-]{36}$/u)
      const key = group.area + '/' + scope.resource; assert(!seen.has(key)); seen.add(key)
      return scope.resource
    }).sort()
    assert.deepEqual(await names(group.directory), expected, 'Original physical inventory has an unselected root')
    for (const scope of group.roots.toSorted((a, b) => a.resource.localeCompare(b.resource))) {
      await walk({ area: group.area, ...scope }, join(group.directory, scope.resource))
    }
    assert.deepEqual(await names(group.directory), expected)
    stable(before, await lstat(group.directory))
  }
  return { files, raw }
}
const admin = new Pool({ connectionString: p.adminUrl, max: 1 }), source = new Pool({ connectionString: p.sourceUrl, max: 1 })
const suffix = randomUUID().replaceAll('-', ''), readRole = 'pe_ci_read_' + suffix, targetRole = 'pe_ci_probe_owner_' + suffix
const targetName = 'pe_ci_probe_' + suffix, readonly = new URL(p.sourceUrl), targetUrl = new URL(p.adminUrl)
readonly.username = readRole; readonly.password = randomBytes(32).toString('hex')
targetUrl.username = targetRole; targetUrl.password = randomBytes(32).toString('hex'); targetUrl.pathname = '/' + targetName
const acquired = { readRole: false, targetRole: false, targetDatabase: false }
let published = false
try {
  for (const [role, password, key] of [[readRole, readonly.password, 'readRole'], [targetRole, targetUrl.password, 'targetRole']]) {
    assert.match(password, /^[a-f0-9]{64}$/u)
    await admin.query('CREATE ROLE ' + quote(role) + " LOGIN PASSWORD '" + password
      + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"); acquired[key] = true
  }
  await source.query('GRANT USAGE ON SCHEMA public TO ' + quote(readRole))
  await source.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + quote(readRole))
  await admin.query('CREATE DATABASE ' + quote(targetName) + ' OWNER ' + quote(targetRole)); acquired.targetDatabase = true
  const sourceFile = join(cohort, 'readonly-url-private'), targetFile = join(out, 'probe-target-url')
  await writeFile(sourceFile, readonly.href + '\n', { flag: 'wx', mode: 0o600 })
  await writeFile(targetFile, targetUrl.href + '\n', { flag: 'wx', mode: 0o600 })
  const client = await source.connect()
  let catalog, cut
  try {
    catalog = await legacyMigrationCatalogDigest(client)
    cut = (await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cut")).rows[0].cut
  } finally { client.release() }
  const identity = { schema: 37, ddlSha256: LEGACY_SQL_DIGESTS.source37, snapshotId: randomUUID(),
    codeId: 'ci-original-source-' + p.sourceCommit, stoppedAt: cut, cut }
  const common = { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits,
    phaseTimeoutMs: 30000, source: { purpose: 'offline-readonly-export', urlFile: sourceFile, expectedDatabase: p.sourceName,
      expectedCatalogSha256: catalog, identity, batchRows: 20, statementTimeoutMs: 5000 } }
  const captured = await launch('current-capture', { ...common, mode: 'capture', outputFile: join(cohort, 'capture-output.json') })
  assert.equal(captured.phase, 'captured'); const capture = captured.capture
  assert.equal(Object.keys(capture.tables).length, Object.keys(LEGACY_SOURCE_LAYOUT).length)
  for (const table of owners) assert(capture.tables[table].length > 0, 'Actual producer omitted required owner ' + table)
  await json(join(cohort, 'capture.json'), capture)
  const stdio = await decode(join(out, 'generated/stdio/original-ready-stdio-results.json'))
  const resolution = await decode(join(out, 'generated/resolution/original-resolution-results.json'))
  assert.equal(stdio.originalStopStatus, 'KUBELET_STOPPED'); assert.equal(resolution.originalStopStatus, 'KUBELET_STOPPED')
  assert.equal(stdio.resourcesAbsentAfterManagerStop, true); assert.equal(resolution.resourcesAbsentAfterManagerStop, true)
  assert.equal(stdio.cohorts.length, 1); assert.equal(stdio.cohorts[0].terminalState, 'succeeded')
  const actionId = stdio.cohorts[0].accepted.actionId
  const action = capture.tables.pe_stdio_v2_actions.find(row => row.id === actionId)
  const selectedTables = new Set(['pe_sandbox_instances', 'pe_cloud_executions', 'pe_mount_slots',
    'pe_stdio_v2_connections',
    'pe_stdio_v2_configurations',
    'pe_stdio_v2_management_requests',
    'pe_stdio_v2_actions',
    ...owners.filter(name => name.startsWith('pe_stdio_v2_'))])
  const sourceRows = Object.entries(capture.tables).flatMap(([table, rows]) => selectedTables.has(table)
    ? rows.filter(row => row.user_id === stdio.userId || row.action_id === actionId).map(row => ({
      table,
      sha256: legacyRowDigest(table,
        row) }
    )) : [])
  const discovery = { format: 'power-evolve-legacy-stdio-discovery', version: 1, sourceCodeId: identity.codeId,
    limits: stdio.limits, management: stdio.management, maxReplyBytes: 262144, deploymentPin: stdio.deploymentPin,
    manifestJson: p.image.manifestJson, configJson: p.image.configJson, requests: [{ actionId, userId: stdio.userId,
      sessionId: stdio.sessionId, executionId: action.execution_id, connectionId: stdio.created.connectionId,
      namespaceUid: stdio.resources.namespaceUid, podReady: stdio.podReady, podStopped: stdio.podStopped,
      capturedSpec: stdio.captures[0].spec, pvc: stdio.pvc,
      pv: stdio.pv, resourcesAbsentAfterManagerStop: true, sourceRows }] }
  const one = (table,
    field,
    id) => {
    const rows = capture.tables[table].filter(row => row[field] === id)
    assert.equal(rows.length,
      1)
    return rows[0] }

  const evidence = { format: 'power-evolve-legacy-cloud-resolution', version: 1, sourceCodeId: identity.codeId,
    commandTimeoutMs: resolution.commandTimeoutMs, requests: [{ userId: resolution.userId, sessionId: resolution.sessionId,
      workspaceId: resolution.workspaceId, executionId: resolution.request.executionId, requestId: resolution.request.requestId,
      resolutionSha256: legacyRowDigest('pe_cloud_execution_resolutions',
        one('pe_cloud_execution_resolutions',
          'execution_id',
          resolution.request.executionId)),

      executionSha256: legacyRowDigest('pe_cloud_executions', one('pe_cloud_executions', 'id', resolution.request.executionId)),
      instanceSha256: legacyRowDigest('pe_sandbox_instances', one('pe_sandbox_instances', 'session_id', resolution.sessionId)),
      slotSha256: legacyRowDigest('pe_mount_slots', one('pe_mount_slots', 'user_id', resolution.userId)),
      namespace: resolution.resources.namespace, namespaceUid: resolution.resources.namespaceUid,
      runningResult: resolution.runningResult, uncertain: resolution.uncertain, inspection: resolution.inspection,
      request: resolution.request, status: resolution.status, podReady: resolution.podReady, podStopped: resolution.podStopped,
      sandboxBeforeStop: resolution.sandboxBeforeStop,
      originalStopStatus: resolution.originalStopStatus,
      resourcesAbsentAfterManagerStop: true },
    ] }

  await json(join(cohort, 'discovery-evidence.json'), discovery); await json(join(cohort, 'resolution-evidence.json'), evidence)
  const key = (await readFile(join(out, 'generated/stdio/original-approval-key'), 'utf8')).trim()
  assert.match(key, /^[a-f0-9]{64}$/u)
  await writeFile(join(cohort, 'original-approval-key'), key + '\n', { flag: 'wx', mode: 0o600 })
  const stdioContext = createLegacyMigrationStdioDiscoveryContext(discovery, Buffer.from(key, 'hex'), identity.codeId, limits)
  const resolutionContext = createLegacyMigrationCloudResolutionContext(evidence, identity.codeId, limits)
  const { files, raw: physicalRaw } = await capturePhysicalInventory({ dataRoot: p.dataRoot,
    bundleRoot: join(cohort, 'detached-files'), tables: capture.tables, sourceUid: 1000, sourceGid: 1000, limits })
  await json(join(cohort, 'physical-files-raw.json'), physicalRaw)
  await json(join(cohort, 'physical-files.json'), files)
  assert(files.every(file => file.kind === 'directory'),
    'Minimal owner fixture unexpectedly contains business files; retain its actual inventory and do not publish incompatible built inputs')
  const inventory = { files, attachmentSources: [], attachmentSourceRoots: {},
    cloudResolutionEvidenceSha256: resolutionContext.evidenceSha256, stdioDiscoveryEvidenceSha256: stdioContext.evidenceSha256 }
  const payload = JSON.stringify({ version: 2, snapshotId: identity.snapshotId, codeId: identity.codeId, stoppedAt: cut, cut,
    catalogSha256: catalog,
    tablesSha256: legacyDigest(JSON.stringify(capture.tables)),
    filesSha256: legacyDigest(JSON.stringify(inventory)),
    kind: 'owned-fixture' },
  )
  await writeFile(join(cohort, 'cut-payload.json'), payload, { flag: 'wx', mode: 0o600 })
  const keys = generateKeyPairSync('ed25519'), keyId = 'ci-current-seal'
  await json(join(cohort,
    'keys.json'),
  {
    version: 1,
    keys: [{
      keyId,
      publicKeyPem: keys.publicKey.export({
        type: 'spki',
        format: 'pem' },
      ).toString() },
    ] },
  )
  await json(join(cohort, 'cut.json'), { keyId, payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
  const request = {
    ...common,
    mode: 'migrate',
    outputFile: join(out,
      'probe-output.json'),
    failureEvidenceFile: join(out,
      'probe-failure.json'),

    evidenceFile: join(cohort, 'cut.json'), trustedEvidenceKeysFile: join(cohort, 'keys.json'), initializeCurrent: true,
    histories: capture.tables.pe_sessions.map(row => ({
      sessionId: row.id,
      encoding: 'pg-logical' }
    )),
    attachmentSources: [],
    attachmentSourceRoots: {
    }
    ,
    files,

    stdioDiscovery: {
      evidenceFile: join(cohort,
        'discovery-evidence.json'),
      originalApprovalKeyFile: join(cohort,
        'original-approval-key') }
    ,

    cloudResolution: {
      evidenceFile: join(cohort,
        'resolution-evidence.json') }
    ,
    target: {
      urlFile: targetFile,
      expectedDatabase: targetName,
      statementTimeoutMs: 5000 }
    ,

    storage: {
      bundleRoot: join(cohort,
        'detached-files'),
      candidateRoot: join(out,
        'probe-storage'),
      sourceUid: 1000,
      sourceGid: 1000,
      targetUid: 0,
      targetGid: 0 },
  }

  const result = await launch('current-bootstrap', request)
  assert.equal(result.phase, 'current-schema-initialized'); assert.equal(result.version, CURRENT_SCHEMA_VERSION)
  const target = new Pool({ connectionString: targetUrl.href, max: 1 })
  try {
    assert.deepEqual((await target.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows,

      [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }])
    for (const table of owners) {
      const projection = Object.entries(LEGACY_SOURCE_LAYOUT[table]).map(([name, column]) => column.kind === 'timestamptz'
        ? 'to_char(' + quote(name) + ' AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS ' + quote(name)
        : quote(name) + '::text AS ' + quote(name)).join(',')
      const rows = (await target.query('SELECT ' + projection + ' FROM ' + quote(table))).rows
      const normalize = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],
        [b]) => a.localeCompare(b))))).sort()
      assert.deepEqual(normalize(rows), normalize(capture.tables[table]), 'Current bootstrap changed original owner ' + table)
    }
  } finally { await target.end() }
  const hostPaths = value => typeof value === 'string' && value.startsWith(out + '/') ? p.hostOut + value.slice(out.length)
    : Array.isArray(value) ? value.map(hostPaths) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, hostPaths(value)])) : value
  await json(join(out, 'request-fixture.json'), hostPaths(request))
  await json(join(out,
    'maintenance-fixture.json'),
  {
    version: 1,
    cohortRoot: p.hostOut + '/cohort',
    requestFixture: p.hostOut + '/request-fixture.json',

    adminUrlFile: p.hostAdminFile, evidenceRoot: p.hostOut, expectedSchemaVersion: CURRENT_SCHEMA_VERSION })
  await json(join(out, 'fixture-production.json'), { owner: p.owner, sourceCommit: p.sourceCommit, sourceName: p.sourceName, readRole,
    originalExecutions, oldLibLoaded: false, actualOriginalStdioCatalog: true, actualOriginalResolutionAndPhysicalStop: true,
    currentBuiltBootstrapVersion: result.version,
    ownerCounts: Object.fromEntries(owners.map(table => [table,
      capture.tables[table].length])),

    captureSHA256: legacyDigest(await readFile(join(cohort, 'capture.json'))),
    physicalRawSHA256: legacyDigest(await readFile(join(cohort, 'physical-files-raw.json'))),
    physicalDirectoryCount: files.length, physicalOrdinaryFileCount: 0, fileMigrationDemonstrated: false,
    noModelInvoked: true, systemMigrationComplete: false })
  published = true
} finally {
  await source.end()
  try {
    if (acquired.targetDatabase) await admin.query('DROP DATABASE ' + quote(targetName))
    if (acquired.targetRole) await admin.query('DROP ROLE ' + quote(targetRole))
    if (!published && acquired.readRole) await admin.query('DROP ROLE ' + quote(readRole))
  } finally { await admin.end() }
  // The host's existing preparer verifies POSIX UID ownership; the PVC data keeps the actual original UID1000.
  async function returnHostOwnership(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === out && ['storage', 'context', 'bin'].includes(entry.name)) continue
      const file = join(directory, entry.name), info = await lstat(file)
      if (directory === cohort && entry.name === 'detached-files') {
        await chown(file, p.hostUid, p.hostGid)
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await returnHostOwnership(file)
      await chown(file, p.hostUid, p.hostGid)
    }
  }
  await returnHostOwnership(out)
}
