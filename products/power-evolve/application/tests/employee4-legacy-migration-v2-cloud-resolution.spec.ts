/** Actual original Runner resolutions imported through an owned maintenance Profile and read by ordinary current services. */
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { Pool } from 'pg'
import { z } from 'zod'
import { expect, test } from 'vitest'
import { executionResolutionInspection, executionResolutionRequest, executionResolutionStatus,
  resolutionExecutionId, resolutionRequestId } from '@power-evolve/contracts/execution-resolution'
import { legacyDigest, legacyJson, legacyRowDigest, type LegacyFileEntry, type LegacyImportLimits } from '../src/platform/legacy-import-codec.ts'
import { LEGACY_SOURCE_LAYOUT, LEGACY_SQL_DIGESTS } from '../src/platform/legacy-import-layout.ts'
import type { LegacyPlannedRow } from '../src/platform/legacy-import-preflight.ts'
import { captureLegacyMigrationSource, legacyMigrationCatalogDigest } from '../src/platform/legacy-migration-v2-source.ts'
import { createLegacyMigrationCloudResolutionContext, legacyMigrationCloudResolutionEvidence,
  validateLegacyMigrationCloudResolution } from '../src/platform/legacy-migration-v2-cloud-resolution.ts'
import { migrateLegacyHistories } from '../src/platform/legacy-migration-v2-history.ts'
import { prepareLegacyMigration } from '../src/platform/legacy-migration-v2-plan.ts'
import { CloudExecutionResolutionService } from '../src/platform/cloud-execution-resolution.ts'
import { IdentityService } from '../src/platform/identity.ts'
import { FileService } from '../src/platform/files.ts'
import { SandboxManager } from '../src/platform/sandbox.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/platform/database.ts'

const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const budgets: LegacyImportLimits = { maxBundleBytes: 4194304, maxRows: 2000, maxCellBytes: 262144,
  maxJsonDepth: 40, maxJsonNodes: 40000, maxFiles: 100, maxFileBytes: 65536, maxStorageBytes: 262144 }
const jsonObject = z.record(z.string(), z.json())
const rawResults = z.object({ ownedFixture: z.literal(true), productionSource: z.literal(false),
  userId: z.uuid(), sessionId: z.uuid(), workspaceId: z.uuid(), commandTimeoutMs: z.number().int().positive(),
  runningResult: jsonObject, uncertain: jsonObject, inspection: executionResolutionInspection,
  request: executionResolutionRequest, status: executionResolutionStatus, podReady: jsonObject, podStopped: jsonObject,
  resources: z.object({ namespace: z.string().startsWith('pe-e4-resolution-'), namespaceUid: z.uuid(), claim: z.string() }).loose(),
  originalStopStatus: z.literal('KUBELET_STOPPED'), resourcesAbsentAfterManagerStop: z.literal(true), cut: z.string() }).loose()
const fileEntries = z.array(z.object({ area: z.enum(['workspace', 'home']), owner: z.uuid(), resource: z.string(),
  path: z.literal(''), kind: z.literal('directory'), sourcePath: z.null(), bytes: z.null(), sha256: z.null(),
  mode: z.number().int(), uid: z.number().int(), gid: z.number().int() }).strict())
async function privateJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

const sourceProcessSchema = z.object({ pid: z.number().int().positive(), threadId: z.number().int().nonnegative() }).strict()

function sourceSubprocessEnvironment(): Record<string, string> {
  const input = process.env.PE_CLOUD_COVERAGE_INPUT, encoded = process.env.PE_CLOUD_SOURCE_SUBPROCESS_ENV
  if (input === undefined && encoded === undefined) return {}
  if (!input || !encoded) throw new Error('Source subprocess coverage requires matching input and environment records')
  const environment = z.object({ PE_CLOUD_COVERAGE_INPUT: z.string().min(1),
    NODE_V8_COVERAGE: z.string().min(1), NODE_OPTIONS: z.string().min(1) }).strict().parse(JSON.parse(encoded))
  if (environment.PE_CLOUD_COVERAGE_INPUT !== input) throw new Error('Source subprocess coverage input changed')
  return environment
}

async function sourceLoadedWitness(environment: Record<string, string>, process: z.infer<typeof sourceProcessSchema>, moduleEntry: string) {
  const inputPath = environment.PE_CLOUD_COVERAGE_INPUT
  if (inputPath === undefined) return null
  const inputBytes = await readFile(inputPath), inputHash = legacyDigest(inputBytes)
  const input = z.object({ directory: z.string(), executionDirectory: z.string().optional(),
    hashes: z.record(z.string(), z.string()) }).loose().parse(JSON.parse(inputBytes.toString('utf8')))
  const collectorFile = join(input.executionDirectory ?? input.directory, 'code', `${process.pid}-${process.threadId}.json`)
  const collected = z.object({ pid: z.number(), threadId: z.number(), inputHash: z.string(), errors: z.array(z.string()),
    scripts: z.record(z.string(), z.object({ url: z.string(), hash: z.string(), originalHash: z.string() }).loose()) }).loose()
    .parse(JSON.parse(await readFile(collectorFile, 'utf8')))
  expect(collected).toMatchObject({ pid: process.pid, threadId: process.threadId, inputHash, errors: [] })
  const source = Object.values(collected.scripts).find(item => item.url === moduleEntry)
  const originalHash = input.hashes['products/power-evolve/application/src/platform/legacy-migration-v2-maintenance.ts']
  if (!source || !originalHash || source.originalHash !== originalHash) throw new Error('Source maintenance entry was not captured in its actual process')
  const rawDirectory = environment.NODE_V8_COVERAGE
  if (rawDirectory === undefined) throw new Error('Source coverage raw directory missing')
  const coverageFiles = (await readdir(rawDirectory)).filter(name => name.startsWith(`coverage-${process.pid}-`) && name.endsWith('.json'))
  if (!coverageFiles.length) throw new Error('Source maintenance process did not complete V8 capture')
  const coverageSchema = z.object({ result: z.array(z.object({ url: z.string(), functions: z.array(z.object({
    ranges: z.array(z.object({ count: z.number() }).loose()),
  }).loose()) }).loose()) }).loose()
  let executed = false
  for (const file of coverageFiles) {
    const coverage = coverageSchema.parse(JSON.parse(await readFile(join(rawDirectory, file), 'utf8')))
    if (coverage.result.some(script => script.url === moduleEntry
      && script.functions.some(fn => fn.ranges.some(range => range.count > 0)))) executed = true
  }
  if (!executed) throw new Error('Source maintenance entry has no executed range in its completed process')
  return { collectorFile, inputHash, sourceHash: source.originalHash, executedCodeHash: source.hash,
    coverageFiles: coverageFiles.map(file => join(rawDirectory, file)), loadedSource: moduleEntry, executed }
}

async function launch(root: string, request: object) {
  const home = join(root, 'home'), profile = `employee4-resolution-${randomUUID()}`, directory = join(home, 'profiles', profile)
  const coverageEnvironment = sourceSubprocessEnvironment()
  const environment = { ...process.env, ...coverageEnvironment }
  const cli = ['dsh', '--profile', profile]
  if (coverageEnvironment.NODE_OPTIONS !== undefined) {
    cli.unshift(`--config.node-options=${coverageEnvironment.NODE_OPTIONS}`)
    delete environment.NODE_OPTIONS
  }
  await mkdir(join(directory, 'node_modules', '@power-evolve'), { recursive: true, mode: 0o700 })
  await privateJson(join(directory, 'package.json'), { name: `dsh-profile-${profile}`, private: true, type: 'module',
    dsh: { profile: { bundles: [] } }, dependencies: { '@power-evolve/application': `file:${join(repo, 'products/power-evolve/application')}` } })
  await symlink(join(repo, 'products/power-evolve/application'), join(directory, 'node_modules', '@power-evolve', 'application'))
  const requestFile = join(root, 'request.json'), module = pathToFileURL(join(repo, 'products/power-evolve/application/src/platform/legacy-migration-v2-maintenance.ts')).href
  await privateJson(requestFile, request)
  const processFile = join(root, 'source-process.json'), witnessFile = join(directory, 'source-process-witness.mjs')
  await writeFile(witnessFile, `import {writeFileSync} from 'node:fs'\nimport {threadId} from 'node:worker_threads'\nexport const name='employee4-source-process-witness'\nexport function apply(){writeFileSync(${JSON.stringify(processFile)},JSON.stringify({pid:process.pid,threadId}),{flag:'wx',mode:0o600})}\n`, { mode: 0o600, flag: 'wx' })
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: employee4-source-process\n      name: '${pathToFileURL(witnessFile).href}'\n    - id: employee4-resolution-maintenance\n      name: '${module}'\n      config:\n        requestFile: '${requestFile}'\n        maxRequestBytes: 1048576\n        maxEvidenceBytes: 1048576\n        maxKeyBytes: 65536\n`, { mode: 0o600, flag: 'wx' })
  const stop = new AbortController(), deadline = setTimeout(() => { stop.abort() }, 60000)
  let output = '', processError: Error | undefined
  try {
    const child = spawn('pnpm', cli, { cwd: repo, env: { ...environment, DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'error' }, signal: stop.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error })
      child.once('close', (code, signal) => { done({ code, signal }) })
    })
    await writeFile(join(root, 'loader-output.log'), output, { mode: 0o600, flag: 'wx' })
    if (processError) throw processError
    expect(result, output).toEqual({ code: 0, signal: null })
    const sourceProcess = sourceProcessSchema.parse(JSON.parse(await readFile(processFile, 'utf8')))
    const loadedSource = await sourceLoadedWitness(coverageEnvironment, sourceProcess, module)
    if (loadedSource) await privateJson(join(root, 'source-loaded-witness.json'), loadedSource)
    return z.object({ version: z.literal(6), systemMigrationComplete: z.literal(false),
      storage: z.object({ roots: z.object({ workspaceRoot: z.string() }).loose() }).loose() }).loose()
      .parse(JSON.parse(await readFile(join(root, 'output.json'), 'utf8')))
  } finally { clearTimeout(deadline) }
}

test('actual original uncertain Cloud resolution retains its stopped writer and ordinary schema6 receipts without replay', async () => {
  const originalRoot = process.env.PE_EMPLOYEE4_ORIGINAL_RESOLUTION_COHORT
  const adminFile = process.env.PE_TEST_DATABASE_URL_FILE
  const sourceAdminFile = process.env.PE_EMPLOYEE4_SOURCE_ADMIN_URL_FILE
  if (!originalRoot || !adminFile || !sourceAdminFile) throw new Error('Actual owned resolution cohort and private source/target PG files are required; this case never skips')
  if (Object.keys(process.env).some(key => key.startsWith('PE_NATIVE_') && key.endsWith('_DDL'))) throw new Error('Formal initializer DDL overrides are forbidden')
  const original = rawResults.parse(legacyJson(await readFile(join(originalRoot, 'original-resolution-results.json'), 'utf8'), budgets))
  const host = z.object({ sourceUrl: z.url(), sourceName: z.string().startsWith('pe_employee4_resolution_source_') }).loose()
    .parse(JSON.parse(await readFile(join(originalRoot, 'host-private.json'), 'utf8')))
  const params = z.object({ username: z.string(), password: z.string(), image: z.object({ imageReference: z.string() }).loose() }).loose()
    .parse(JSON.parse(await readFile(join(originalRoot, 'parameters-private.json'), 'utf8')))
  const sandboxBeforeStop = jsonObject.parse(legacyJson(await readFile(join(originalRoot, 'sandbox-before-stop.json'), 'utf8'), budgets))
  const files: LegacyFileEntry[] = fileEntries.parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
  const admin = new Pool({ connectionString: (await readFile(adminFile, 'utf8')).trim(), max: 1 })
  const sourceAdmin = new Pool({ connectionString: (await readFile(sourceAdminFile, 'utf8')).trim(), max: 1 })
  const owner = new Pool({ connectionString: host.sourceUrl, max: 1 })
  const suffix = randomUUID().replaceAll('-', ''), readonlyRole = `pe_e4_resolution_read_${suffix}`
  const targetRole = `pe_e4_resolution_target_${suffix}`, targetDatabase = `pe_employee4_resolution_target_${suffix}`
  const readonlyUrl = new URL(host.sourceUrl); readonlyUrl.username = readonlyRole; readonlyUrl.password = randomUUID()
  const targetUrl = new URL((await readFile(adminFile, 'utf8')).trim()); targetUrl.username = targetRole
  targetUrl.password = randomUUID(); targetUrl.pathname = `/${targetDatabase}`
  const source = new Pool({ connectionString: readonlyUrl.href, max: 1 }), target = new Pool({ connectionString: targetUrl.href, max: 2 })
  const root = await mkdtemp(join(originalRoot, 'schema6-consumer-'))
  let readRoleCreated = false, targetRoleCreated = false, targetCreated = false
  try {
    await sourceAdmin.query(`CREATE ROLE "${readonlyRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(readonlyUrl.password)}`)
    readRoleCreated = true
    await sourceAdmin.query(`GRANT CONNECT ON DATABASE "${host.sourceName}" TO "${readonlyRole}"`)
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${readonlyRole}"`)
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${readonlyRole}"`)
    const client = await owner.connect()
    const catalogSha256 = await legacyMigrationCatalogDigest(client); client.release()
    const codeId = 'original-schema37@4acb888058b3e5a95ec7d085ba75bcf2442d3636'
    const identity = { schema: 37 as const, ddlSha256: LEGACY_SQL_DIGESTS.source37, snapshotId: randomUUID(), codeId,
      stoppedAt: original.cut, cut: original.cut }
    const capture = await captureLegacyMigrationSource(source, identity, { purpose: 'offline-readonly-export',
      expectedDatabase: host.sourceName, expectedCatalogSha256: catalogSha256, batchRows: 20, statementTimeoutMs: 5000,
      limits: budgets }, new AbortController().signal)
    await privateJson(join(root, 'source-capture.json'), capture)
    const rows: LegacyPlannedRow[] = Object.entries(capture.tables).flatMap(([table, records]) => records.map(values => ({
      table, sourceTable: table, sourceSha256: legacyRowDigest(table, values), values,
    })))
    const rowFor = (table: string) => {
      const row = rows.find(item => item.table === table)
      if (!row) throw new Error(`Original nonempty ${table} missing`)
      return row
    }
    const resolution = rowFor('pe_cloud_execution_resolutions'), execution = rowFor('pe_cloud_executions')
    const evidence = legacyMigrationCloudResolutionEvidence.parse({ format: 'power-evolve-legacy-cloud-resolution', version: 1,
      sourceCodeId: codeId, commandTimeoutMs: original.commandTimeoutMs, requests: [{
        userId: original.userId, sessionId: original.sessionId, workspaceId: original.workspaceId,
        executionId: original.request.executionId, requestId: original.request.requestId,
        resolutionSha256: resolution.sourceSha256, executionSha256: execution.sourceSha256,
        instanceSha256: rowFor('pe_sandbox_instances').sourceSha256, slotSha256: rowFor('pe_mount_slots').sourceSha256,
        namespace: original.resources.namespace, namespaceUid: original.resources.namespaceUid,
        runningResult: original.runningResult, uncertain: original.uncertain, inspection: original.inspection,
        request: original.request, status: original.status, podReady: original.podReady, podStopped: original.podStopped,
        sandboxBeforeStop, originalStopStatus: original.originalStopStatus,
        resourcesAbsentAfterManagerStop: original.resourcesAbsentAfterManagerStop,
      }] })
    const context = createLegacyMigrationCloudResolutionContext(evidence, codeId, budgets)
    await privateJson(join(root, 'resolution-evidence.json'), evidence)
    const ownedTables = ['pe_cloud_execution_resolutions', 'pe_cloud_executions', 'pe_sandbox_instances', 'pe_mount_slots']
    for (const table of ownedTables) {
      expect(validateLegacyMigrationCloudResolution(rowFor(table), rows, budgets, identity.cut, context)).toBe(true)
    }
    expect(validateLegacyMigrationCloudResolution(rowFor('pe_schema'), rows, budgets, identity.cut, context)).toBe(false)
    expect(() => validateLegacyMigrationCloudResolution(resolution, rows, budgets, identity.cut)).toThrow('migration_cloud_resolution_evidence_missing')
    expect(() => validateLegacyMigrationCloudResolution(resolution, rows, budgets, identity.cut,
      { evidenceSha256: context.evidenceSha256 })).toThrow()
    expect(() => createLegacyMigrationCloudResolutionContext(evidence, 'replaced-original-code', budgets)).toThrow()
    expect(() => createLegacyMigrationCloudResolutionContext({ ...evidence,
      requests: [...evidence.requests, ...evidence.requests] }, codeId, budgets)).toThrow()
    expect(() => createLegacyMigrationCloudResolutionContext(evidence, codeId, { ...budgets, maxJsonNodes: 2 })).toThrow()

    const replace = (table: string, changes: Record<string, string | null>) => rows.map(item => item.table === table
      ? { ...item, values: { ...item.values, ...changes },
        sourceSha256: legacyRowDigest(item.sourceTable, { ...item.values, ...changes }) } : item)
    const contextFor = (changed: readonly LegacyPlannedRow[]) => createLegacyMigrationCloudResolutionContext({ ...evidence,
      requests: evidence.requests.map(item => ({ ...item,
        resolutionSha256: changed.find(value => value.table === 'pe_cloud_execution_resolutions')?.sourceSha256,
        executionSha256: changed.find(value => value.table === 'pe_cloud_executions')?.sourceSha256,
        instanceSha256: changed.find(value => value.table === 'pe_sandbox_instances')?.sourceSha256,
        slotSha256: changed.find(value => value.table === 'pe_mount_slots')?.sourceSha256,
      })) }, codeId, budgets)
    for (const [table, changes] of [
      ['pe_cloud_execution_resolutions', { fingerprint: '0'.repeat(64) }],
      ['pe_cloud_execution_resolutions', { request_digest: '0'.repeat(64) }],
      ['pe_cloud_execution_resolutions', { runner_request_digest: '0'.repeat(64) }],
      ['pe_cloud_execution_resolutions', { state: 'accepted' }],
      ['pe_cloud_execution_resolutions', { lease_owner: randomUUID() }],
      ['pe_cloud_execution_resolutions', { continuation_queued: 'false' }],
      ['pe_cloud_executions', { request_digest: '0'.repeat(64) }],
      ['pe_cloud_executions', { runner_instance_id: randomUUID() }],
      ['pe_cloud_executions', { result: '{"exitCode":0}' }],
      ['pe_mount_slots', { generation: '2' }],
      ['pe_mount_slots', { state: 'ready' }],
      ['pe_sandbox_instances', { stop_pod_uid: randomUUID() }],
    ] satisfies readonly (readonly [string, Record<string, string | null>])[]) {
      const changed = replace(table, changes), selected = changed.find(item => item.table === 'pe_cloud_execution_resolutions')
      if (!selected) throw new Error('Changed original resolution absent')
      expect(() => validateLegacyMigrationCloudResolution(selected, changed, budgets, identity.cut, contextFor(changed)), `${table}: ${JSON.stringify(changes)}`).toThrow()
    }
    const next = rows.find(item => item.table === 'pe_operations' && item.values.source_execution_id === original.request.executionId)
    if (!next) throw new Error('Original unique continuation absent')
    expect(() => validateLegacyMigrationCloudResolution(resolution, [...rows, next], budgets, identity.cut, context)).toThrow('migration_cloud_resolution_continuation')
    expect(() => validateLegacyMigrationCloudResolution(resolution, rows.filter(item => item !== next), budgets,
      identity.cut, context)).toThrow()
    expect(() => validateLegacyMigrationCloudResolution(resolution, rows.map(item => item === next
      ? { ...item, values: { ...item.values, input: 'Replay this command' } } : item), budgets, identity.cut, context)).toThrow()
    const proof = evidence.requests[0]
    if (!proof) throw new Error('Original resolution evidence absent')
    const pod = z.object({ metadata: jsonObject, status: jsonObject }).loose().parse(proof.podStopped)
    for (const changedPod of [{ ...pod, metadata: { ...pod.metadata, uid: randomUUID() } },
      { ...pod, status: { ...pod.status, phase: 'Running' } }]) {
      const altered = createLegacyMigrationCloudResolutionContext({ ...evidence,
        requests: [{ ...proof, podStopped: changedPod }] }, codeId, budgets)
      expect(() => validateLegacyMigrationCloudResolution(resolution, rows, budgets, identity.cut, altered)).toThrow()
    }

    const histories = capture.tables.pe_sessions?.map(item => ({ sessionId: z.uuid().parse(item.id), encoding: 'pg-logical' as const })) ?? []
    const fileDigest = legacyDigest(JSON.stringify({ files, attachmentSources: [], attachmentSourceRoots: {},
      cloudResolutionEvidenceSha256: context.evidenceSha256 }))
    const cut = { version: 2 as const, snapshotId: identity.snapshotId, codeId, stoppedAt: identity.stoppedAt, cut: identity.cut,
      catalogSha256, tablesSha256: legacyDigest(JSON.stringify(capture.tables)), filesSha256: fileDigest, kind: 'owned-fixture' as const }
    const plan = prepareLegacyMigration(randomUUID(), capture, migrateLegacyHistories(capture, histories, budgets), [], files,
      fileDigest, cut, budgets, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, context)
    expect(plan.rows.filter(item => item.table === 'pe_cloud_execution_resolutions')).toHaveLength(1)
    await admin.query(`CREATE ROLE "${targetRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(targetUrl.password)}`)
    targetRoleCreated = true
    await admin.query(`CREATE DATABASE "${targetDatabase}" OWNER "${targetRole}"`); targetCreated = true
    await writeFile(join(root, 'source-url'), readonlyUrl.href, { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
    const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cut)
    await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'employee4-owned-resolution',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(root, 'cut.json'), { keyId: 'employee4-owned-resolution', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    await mkdir(join(root, 'bundle'), { mode: 0o700 })
    const completed = await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(),
      mode: 'migrate', limits: budgets, phaseTimeoutMs: 30000, outputFile: join(root, 'output.json'), failureEvidenceFile: join(root, 'failure.json'),
      evidenceFile: join(root, 'cut.json'), trustedEvidenceKeysFile: join(root, 'keys.json'),
      source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: host.sourceName,
        expectedCatalogSha256: catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 }, histories,
      attachmentSources: [], attachmentSourceRoots: {}, files, initializeCurrent: true,
      cloudResolution: { evidenceFile: join(root, 'resolution-evidence.json') },
      target: { urlFile: join(root, 'target-url'), expectedDatabase: targetDatabase, statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: 1000, sourceGid: 1000,
        targetUid: process.getuid?.(), targetGid: process.getgid?.() } })
    const role = (await target.query<{ privileged: boolean }>('SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication '
      + 'OR rolbypassrls AS privileged FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role?.privileged).toBe(false)
    expect((await target.query<{ version: number }>('SELECT version FROM pe_schema')).rows[0]?.version).toBe(6)
    const retainedRows = async () => {
      const retained: Record<string, unknown> = {}
      for (const table of ownedTables) {
        const columns = LEGACY_SOURCE_LAYOUT[table]
        if (!columns) throw new Error('Original column inventory absent')
        const projection = Object.entries(columns).map(([name, field]) => field.kind === 'timestamptz'
          ? `to_char("${name}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${name}"` : `"${name}"::text AS "${name}"`).join(',')
        retained[table] = (await target.query<Record<string, string | null>>(`SELECT ${projection} FROM "${table}"`)).rows
      }
      return retained
    }
    const before = await retainedRows()
    for (const table of ownedTables) expect(before[table]).toEqual(capture.tables[table])
    const identities = new IdentityService(target, 60000), actor = await identities.login(params.username, params.password)
    const approval = await identities.login(params.username, params.password, 'approval')
    const filesService = new FileService(target, completed.storage.roots.workspaceRoot); await filesService.init()
    const kubeconfig = process.env.PE_EMPLOYEE4_RESOLUTION_KUBECONFIG
    if (!kubeconfig) throw new Error('Actual owned cluster kubeconfig is required for the ordinary consumer')
    const kube = await KubernetesClient.fromFile(kubeconfig), actualCall = kube.call.bind(kube)
    let apiCalls = 0
    kube.call = async <T>(...args: Parameters<KubernetesClient['call']>): Promise<T> => {
      apiCalls += 1; return actualCall<T>(...args)
    }
    const manager = new SandboxManager(kube, filesService, target, randomUUID(), { namespace: proof.namespace,
      image: params.image.imageReference, localRoot: completed.storage.roots.workspaceRoot, nodeRoot: '',
      volumeClaimName: original.resources.claim, readyTimeoutMs: 1000, maxExecutions: 1 })
    const service = new CloudExecutionResolutionService(target, manager, async () => { throw new Error('Completed receipt attempted new continuation') }, 7, 1000, 100)
    try {
      const executionId = resolutionExecutionId.parse(proof.executionId), requestId = resolutionRequestId.parse(proof.requestId)
      expect(await service.status(actor.user, requestId)).toEqual(original.status)
      const listed = await service.list(actor.user, {})
      expect(listed.items).toHaveLength(1); expect(listed.items[0]?.resolution).toEqual(original.status.receipt)
      const inspected = await service.inspect(actor.user, executionId)
      expect(inspected.canStop).toBe(false); expect(inspected.blockedReason).toBe('execution_resolution_exists')
      expect(inspected.item.executionState).toBe(original.status.receipt?.finalState)
      expect(await service.resolve(actor.user, proof.request, approval.token)).toEqual(original.status.receipt)
      await expect(service.resolve(actor.user, { ...proof.request, note: 'Changed retained request' }, approval.token)).rejects.toMatchObject({ code: 'request_id_conflict' })
      await expect(service.resolve(actor.user, { ...proof.request, requestId: resolutionRequestId.parse(randomUUID()) }, approval.token)).rejects.toMatchObject({ code: 'execution_resolution_exists' })
      await expect(service.resolve(actor.user, proof.request, actor.token)).rejects.toMatchObject({ code: 'account_unauthorized' })
      expect(await service.status(actor.user, resolutionRequestId.parse(randomUUID()))).toEqual({ receipt: null })
      expect(await service.poll(new AbortController().signal)).toBe(false)
      expect(apiCalls).toBe(0)
      expect(await retainedRows()).toEqual(before)
      expect((await target.query<{ count: number }>('SELECT count(*)::integer AS count FROM pe_operations WHERE source_execution_id=$1', [execution.values.id])).rows[0]?.count).toBe(1)
      await privateJson(join(root, 'ordinary-consumers.json'), { schemaVersion: CURRENT_SCHEMA_VERSION, ownedFixture: true, productionMigration: false,
        status: original.status, listed, inspected, apiCalls, sourceRowsUnchanged: true, continuationCount: 1 })
    } finally { await identities.logout(actor.token); await identities.logout(approval.token) }
  } finally {
    try {
      await Promise.all([source.end(), target.end()])
      if (targetCreated) await admin.query(`DROP DATABASE "${targetDatabase}"`)
      if (targetRoleCreated) await admin.query(`DROP ROLE "${targetRole}"`)
      if (readRoleCreated) {
        await owner.query(`REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM "${readonlyRole}"`)
        await owner.query(`REVOKE USAGE ON SCHEMA public FROM "${readonlyRole}"`)
        await sourceAdmin.query(`REVOKE CONNECT ON DATABASE "${host.sourceName}" FROM "${readonlyRole}"`)
        await sourceAdmin.query(`DROP ROLE "${readonlyRole}"`)
      }
      await owner.end(); await admin.end()
    } finally {
      await sourceAdmin.end()
    }
  }
}, 120000)
