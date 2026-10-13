/** Detached legacy packet guards and real, exclusively new PostgreSQL/file candidates. */
import { randomUUID, scryptSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { z } from 'zod'
import { expect, test } from 'vitest'
import { LEGACY_SOURCE_LAYOUT, LEGACY_TARGET_LAYOUT, LEGACY_SQL_DIGESTS } from '../src/platform/legacy-import-layout.ts'
import { LegacyImportError, legacyDigest, legacyJson, legacyLimits, legacyRowDigest, parseLegacyBundle,
  type LegacyBundle, type LegacyImportLimits, type LegacyJson, type LegacySourceRow } from '../src/platform/legacy-import-codec.ts'
import { preflightLegacyImport, legacyTimestamp, type LegacyImportOwners } from '../src/platform/legacy-import-preflight.ts'
import { writeLegacyImport } from '../src/platform/legacy-import-write.ts'
import { verifyLegacyStorage, type LegacyStorageOptions } from '../src/platform/legacy-import-storage.ts'
import { CURRENT_SCHEMA_VERSION, initializeDatabase } from '../src/platform/database.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { IdentityService, verifyPassword } from '../src/platform/identity.ts'
import { identity, sessionId } from '../src/contracts.ts'
import { skillPackageManifest, verifyPublishedSkillPackage } from '../src/platform/skill-package-manifest.ts'
import { stdioCloudDeploymentV2, stdioPreparedV2, stdioApprovalBindingV2, stdioStartPermitV2, stdioDispatchV2,
  stdioCheckRequestV2, stdioTaskSchemasV2, stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementSchemasV2 } from '@power-evolve/contracts/stdio-management'
import { stdioOutcomeV2, stdioRuntimeViewV2, stdioCloudStopEvidenceV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioSha256V2, stdioCatalogFingerprintV2, stdioApprovalFingerprintV2,
  type StdioDigestDomainV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { StdioConnectionServiceV2 } from '../src/platform/stdio-v2-connections.ts'
import { StdioActionServiceV2 } from '../src/platform/stdio-v2-actions.ts'

const limits: LegacyImportLimits = { maxBundleBytes: 2_097_152, maxRows: 1000, maxCellBytes: 65_536,
  maxJsonDepth: 32, maxJsonNodes: 20_000, maxFiles: 100, maxFileBytes: 65_536, maxStorageBytes: 262_144 }
const time = '2025-01-02T03:04:05.123456Z'
const cut = '2025-02-02T03:04:05.123456Z'
const payload = Buffer.from('旧包文件 😀\0\n')
const passwordSalt = '01'.repeat(16)
const passwordHash = `${passwordSalt}:${scryptSync('owned-fixture-password', passwordSalt, 64).toString('hex')}`
const stdioLimits = { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
const stdioManagement = { maxNameBytes: 80, pageItems: 2, maxConnections: 4 }
const stdioJsonLimits = { maxDepth: stdioLimits.maxJsonDepth, maxNodes: stdioLimits.maxJsonNodes, maxBytes: stdioLimits.maxInputBytes }
const ids = () => ({ user: randomUUID(), workspace: randomUUID(), session: randomUUID(), operation: randomUUID() })

function records(bundle: LegacyBundle, table: string): LegacySourceRow[] {
  const rows = bundle.tables[table]
  if (!rows) throw new Error('Fixture source table missing')
  return rows
}
function sourceRow(table: string, patch: Record<string, string | null> = {}): LegacySourceRow {
  const columns = LEGACY_SOURCE_LAYOUT[table]
  if (!columns) throw new Error('Fixture source table missing')
  const values: Record<string, string | null> = {}
  for (const [column, definition] of Object.entries(columns)) {
    if (definition.nullable) { values[column] = null; continue }
    switch (definition.kind) {
      case 'uuid': values[column] = randomUUID(); break
      case 'text': values[column] = ''; break
      case 'boolean': values[column] = 'false'; break
      case 'json':
      case 'jsonb': values[column] = '{}'; break
      case 'timestamptz': values[column] = time; break
      case 'integer':
      case 'bigint': values[column] = '0'; break
      case 'bytea': values[column] = '\\x'; break
    }
  }
  Object.assign(values, patch)
  return { disposition: table === 'pe_schema' || table === 'pe_file_mutations' ? 'convert' : 'preserve',
    values, sha256: legacyRowDigest(table, values) }
}
function seal(bundle: LegacyBundle): string {
  const counts = { preserve: 0, convert: 0, excluded: 0, rejected: 0 }
  for (const [table, rows] of Object.entries(bundle.tables)) for (const row of rows) {
    row.sha256 = legacyRowDigest(table, row.values); counts[row.disposition]++
  }
  bundle.counts = counts
  return JSON.stringify(bundle)
}
function packet() {
  const alice = ids(), bob = ids()
  const bundle: LegacyBundle = { format: 'power-evolve-legacy-offline', version: 1,
    source: { schema: 37, ddlSha256: LEGACY_SQL_DIGESTS.source37, snapshotId: randomUUID(), codeId: 'reviewed-fixed-fixture', stoppedAt: time, cut },
    tables: Object.fromEntries(Object.keys(LEGACY_SOURCE_LAYOUT).map(table => [table, []])),
    counts: { preserve: 0, convert: 0, excluded: 0, rejected: 0 }, files: [], cutProof: '{"kind":"owned-fixture-cut"}', stops: [] }
  records(bundle, 'pe_schema').push(sourceRow('pe_schema', { version: '37' }))
  for (const [index, id] of [alice, bob].entries()) {
    records(bundle, 'pe_users').push(sourceRow('pe_users', { id: id.user, username: index ? 'import-bob' : 'import-alice',
      password_hash: passwordHash, display_name: index ? 'Bob' : 'Alice', role: 'USER', enabled: 'true',
      account_revision: '7', credential_version: '3', password_change_required: 'false',
      settings: '{ "model": "trial-model", "maxTokens": 1000, "revision": 7 }' }))
    records(bundle, 'pe_workspaces').push(sourceRow('pe_workspaces', { id: id.workspace, user_id: id.user,
      title: index ? 'Bob Home' : 'Alice Home', is_default: 'true', create_request_id: randomUUID(),
      binding_generation: '9', binding_state: 'ready' }))
    records(bundle, 'pe_storage_spaces').push(sourceRow('pe_storage_spaces', { id: id.workspace, user_id: id.user,
      root_key: id.workspace, title: 'retained cloud root', is_default: 'true', root_state: 'ready' }))
    records(bundle, 'pe_workspace_bindings').push(sourceRow('pe_workspace_bindings', { workspace_id: id.workspace,
      user_id: id.user, space_id: id.workspace, root_relative_path: '' }))
    const event = JSON.stringify({ seq: 0, time: 1, type: 'session/title', data: { title: index ? 'Bob old title' : 'Alice old title',
      messageSeqs: [], source: { kind: 'user' } } })
    const ignored = '{ "seq":1, "time":2, "type":"employee5/retained", "ignorable":true, "data":{"value":1e0,"emoji":"\\uD83D\\uDE00"} }'
    const events = index ? [event] : [event, ignored]
    records(bundle, 'pe_sessions').push(sourceRow('pe_sessions', { id: id.session, user_id: id.user, workspace_id: id.workspace,
      create_request_id: randomUUID(), header: JSON.stringify({ id: id.session, version: 4, createdAt: 1, isSeeded: false }),
      event_count: String(events.length),
      event_bytes: String(events.reduce((sum, text) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(text))), 0)),
      lease_epoch: '13' }))
    for (const [seq, text] of events.entries()) records(bundle, 'pe_events').push(sourceRow('pe_events', {
      session_id: id.session, seq: String(seq), event: text }))
    records(bundle, 'pe_operations').push(sourceRow('pe_operations', { id: id.operation, session_id: id.session,
      request_id: randomUUID(), input: index ? 'old bob prompt' : 'old alice prompt', state: 'completed', attempts: '1', completed_at: time,
      settings: '{"model":"trial-model","maxTokens":1000,"revision":7}', source: 'user', execution_target: '{"kind":"cloud"}',
      skill_selection: '[]', mcp_selection: '[]', stdio_mcp_selection: '[]', ssh_selection: '[]', remote_mcp_selection: '[]', stdio_v2_selection: '[]' }))
    records(bundle, 'pe_attempts').push(sourceRow('pe_attempts', { operation_id: id.operation, epoch: '13', worker_id: randomUUID(), ended_at: time }))
    records(bundle, 'pe_credentials').push(sourceRow('pe_credentials', { user_id: id.user, audience: 'agent',
      digest: legacyDigest(`expired-token-${id.user}`), expires_at: time, credential_version: '3' }))
    for (const area of ['workspace', 'home'] as const) bundle.files.push({ area, owner: id.user,
      resource: area === 'workspace' ? id.workspace : id.user, path: '', kind: 'directory', sourcePath: null,
      bytes: null, sha256: null, mode: 0o750, uid: 1000, gid: 1000 })
  }
  bundle.files.push({ area: 'workspace', owner: alice.user, resource: alice.workspace, path: '旧文件.txt', kind: 'file',
    sourcePath: 'payload.bin', bytes: String(payload.length), sha256: legacyDigest(payload), mode: 0o640, uid: 1000, gid: 1000 })
  seal(bundle)
  return { bundle, alice, bob }
}
function jsonObject(value: LegacyJson | undefined): value is Readonly<Record<string, LegacyJson>> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}
function owners(text: string, overrides: Partial<LegacyImportOwners> = {}): LegacyImportOwners {
  const expected = legacyDigest(text)
  return { verifyCut: (source, proof, packetSha256) => {
    if (packetSha256 !== expected || source.codeId !== 'reviewed-fixed-fixture' || proof === null
      || typeof proof !== 'object' || !('kind' in proof) || proof.kind !== 'owned-fixture-cut') throw new Error('unverified cut')
  }, validateRow: () => {}, references: ({ row, json }) => {
    const event = json.event
    if (row.table !== 'pe_events' || !jsonObject(event)
      || event.type !== 'employee5/retained' || !jsonObject(event.data) || !Object.hasOwn(event.data, 'workspaceId')) return []
    return [{ column: 'event', targetTable: 'pe_workspaces', ownership: 'same',
      fields: [{ targetColumn: 'id', value: { kind: 'json', path: ['data', 'workspaceId'] } }] }]
  }, verifyStopped: () => { throw new Error('This fixture supplies no physical stop adapter') },
  verifyFiles: () => {}, ...overrides }
}
function planned(bundle: LegacyBundle, configuration = limits, adapters: Partial<LegacyImportOwners> = {}) {
  const text = seal(bundle)
  return preflightLegacyImport(text, configuration, owners(text, adapters))
}
function stoppedCloud(bundle: LegacyBundle, owner: ReturnType<typeof ids>) {
  const execution = sourceRow('pe_cloud_executions', { id: randomUUID(), user_id: owner.user, session_id: owner.session,
    operation_id: owner.operation, call_id: 'retained-call', command: 'printf old-result', cwd: '/home/agent',
    request_digest: legacyDigest(JSON.stringify({ command: 'printf old-result', cwd: '/home/agent', timeoutMs: 30000 })), state: 'succeeded',
    result: '{ "code":0,"stdout":"old-result","stderr":"" }', sandbox_name: 'owned-old-sandbox', pod_uid: randomUUID(),
    runner_instance_id: randomUUID(), attempts: '1', continuation_request_id: randomUUID(),
    execution_kind: 'legacy_command', execution_target: 'cloud', origin_kind: 'operation' })
  records(bundle, 'pe_cloud_executions').push(execution)
  const proof = { kind: 'owned-fixture-physical-stop', executionId: execution.values.id, podUid: execution.values.pod_uid,
    runnerInstanceId: execution.values.runner_instance_id, requestDigest: execution.values.request_digest }
  bundle.stops.push({ table: 'pe_cloud_executions', rowSha256: execution.sha256, evidence: JSON.stringify(proof) })
  const verifyStopped: LegacyImportOwners['verifyStopped'] = (context, evidence) => {
    if (context.row.table !== 'pe_cloud_executions' || JSON.stringify(evidence) !== JSON.stringify(proof)) {
      throw new Error('Original physical identity does not match')
    }
  }
  const validateRow: LegacyImportOwners['validateRow'] = ({ row }) => {
    if (row.table === 'pe_cloud_executions' && row.values.request_digest !== legacyDigest(JSON.stringify({
      command: row.values.command, cwd: row.values.cwd, timeoutMs: 30000,
    }))) throw new Error('Immutable request changed')
  }
  return { execution, proof, verifyStopped, validateRow }
}
function packagedSkill(bundle: LegacyBundle, owner: ReturnType<typeof ids>) {
  const instruction = Buffer.from('---\nname: owned-import\ndescription: Retained package\n---\nKeep this old skill.\n')
  const files = [{ path: 'skill/SKILL.md', size: instruction.length, sha256: legacyDigest(instruction) }]
  const archive = Buffer.from('owned-fixture original archive backup')
  const archiveDigest = legacyDigest(archive), manifest = skillPackageManifest(archiveDigest, files)
  const skillId = randomUUID(), versionId = randomUUID()
  records(bundle, 'pe_user_skills').push(sourceRow('pe_user_skills', { id: skillId, user_id: owner.user, name: 'owned-import',
    description: 'Retained package', digest: files[0]?.sha256 ?? '', enabled: 'true', revision: '11', kind: 'package', package_version_id: versionId }))
  records(bundle, 'pe_skill_package_versions').push(sourceRow('pe_skill_package_versions', { id: versionId, user_id: owner.user,
    skill_id: skillId, name: 'owned-import', description: 'Retained package', version: '1.2.3', archive_digest: archiveDigest,
    archive_size: String(archive.length), instruction_digest: files[0]?.sha256 ?? '', manifest_digest: legacyDigest(manifest), manifest }))
  const base = { area: 'skill-package' as const, owner: owner.user, resource: archiveDigest, mode: 0o750, uid: 1000, gid: 1000 }
  for (const path of ['', 'skill']) bundle.files.push({ ...base, path, kind: 'directory', sourcePath: null, bytes: null, sha256: null })
  for (const [path, sourcePath, content] of [['manifest.json', 'skill-manifest', Buffer.from(manifest)],
    ['skill/SKILL.md', 'skill-instruction', instruction]] as const) bundle.files.push({ ...base, mode: 0o440, path, kind: 'file',
    sourcePath, bytes: String(content.length), sha256: legacyDigest(content) })
  return { archiveDigest, archive, instruction, manifest, files, skillId, versionId }
}
function noStartStdio(bundle: LegacyBundle, owner: ReturnType<typeof ids>) {
  const cloud = stoppedCloud(bundle, owner), connectionId = randomUUID(), actionId = randomUUID()
  const configuration = '{"kind":"owned-fixture-configuration"}', configDigest = legacyDigest(configuration)
  const task = '{ "kind":"owned-fixture-stdio-call" }', taskDigest = legacyDigest(task)
  records(bundle, 'pe_stdio_v2_connections').push(sourceRow('pe_stdio_v2_connections', {
    id: connectionId, user_id: owner.user, revision: '5', enabled: 'false',
  }))
  records(bundle, 'pe_stdio_v2_configurations').push(sourceRow('pe_stdio_v2_configurations', {
    connection_id: connectionId, user_id: owner.user, revision: '5', configuration, config_digest: configDigest,
  }))
  Object.assign(cloud.execution.values, { state: 'failed', result: null, error_code: 'confirmed_no_start',
    command: null, cwd: null, execution_kind: 'stdio_v2', task_version: '2', stdio_phase: 'call', stdio_task: task,
    stdio_action_id: actionId, request_digest: taskDigest })
  cloud.proof.requestDigest = taskDigest
  const action = sourceRow('pe_stdio_v2_actions', { id: actionId, user_id: owner.user, session_id: owner.session,
    connection_id: connectionId, config_revision: '5', config_digest: configDigest, phase: 'call', execution_target: 'cloud',
    execution_id: cloud.execution.values.id ?? '', cloud_execution_id: cloud.execution.values.id ?? '', operation_id: owner.operation,
    root_operation_id: owner.operation, call_id: 'retained-call', task, task_digest: taskDigest, state: 'failed',
    lease_epoch: '17', continuation_request_id: cloud.execution.values.continuation_request_id ?? null, continuation_queued: 'true' })
  records(bundle, 'pe_stdio_v2_actions').push(action)
  const closure = sourceRow('pe_stdio_v2_no_start_closures', { action_id: actionId, user_id: owner.user,
    session_id: owner.session, phase: 'call', execution_target: 'cloud', execution_id: cloud.execution.values.id ?? '',
    task_digest: taskDigest, worker_id: randomUUID(), lease_epoch: '17', receipt: JSON.stringify(cloud.proof),
    receipt_digest: legacyDigest(JSON.stringify(cloud.proof)) })
  records(bundle, 'pe_stdio_v2_no_start_closures').push(closure)
  const original = bundle.stops[0]
  if (!original) throw new Error('Fixture Cloud stop missing')
  original.rowSha256 = legacyRowDigest('pe_cloud_executions', cloud.execution.values); original.evidence = JSON.stringify(cloud.proof)
  bundle.stops.push({ table: 'pe_stdio_v2_actions', rowSha256: action.sha256, evidence: JSON.stringify(cloud.proof) })
  const validateRow: LegacyImportOwners['validateRow'] = ({ row }) => {
    if (row.table === 'pe_stdio_v2_configurations' && legacyDigest(row.values.configuration ?? '') !== configDigest
      || row.table === 'pe_stdio_v2_actions' && legacyDigest(row.values.task ?? '') !== taskDigest
      || row.table === 'pe_stdio_v2_no_start_closures' && legacyDigest(row.values.receipt ?? '') !== row.values.receipt_digest) {
      throw new Error('Frozen fixture digest changed')
    }
  }
  const verifyStopped: LegacyImportOwners['verifyStopped'] = ({ row }, proof) => {
    if (!['pe_cloud_executions', 'pe_stdio_v2_actions'].includes(row.table) || JSON.stringify(proof) !== JSON.stringify(cloud.proof)) {
      throw new Error('Original stopped fixture executor changed')
    }
  }
  return { action, closure, execution: cloud.execution, validateRow, verifyStopped }
}
function catalogStdio(bundle: LegacyBundle, owner: ReturnType<typeof ids>) {
  const actionId = randomUUID(), executionId = randomUUID(), connectionId = randomUUID(), catalogId = randomUUID()
  const requestId = stdioReceiptRequestV2.shape.requestId.parse(randomUUID()), expiresAt = '2025-01-02T04:04:05.123456Z'
  const sha = (domain: StdioDigestDomainV2, value: unknown) => stdioSha256V2(domain, value, stdioJsonLimits)
  const schemas = stdioManagementSchemasV2(stdioLimits, stdioManagement)
  const configuration = schemas.configuration.parse({ name: 'Retained catalog',
    invocation: { program: 'node', argv: ['old.mjs'], cwd: '.' } })
  const configDigest = sha('configuration', configuration)
  const deployment = stdioCloudDeploymentV2.parse({ kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2,
    platform: { os: 'linux', architecture: 'arm64' }, imageReference: `fixture.invalid/runner@sha256:${'a'.repeat(64)}`,
    configImageId: `sha256:${'a'.repeat(64)}`, runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] })
  const task = stdioTaskSchemasV2(stdioLimits).task.parse({ formatVersion: 2, phase: 'discover', actionId, userId: owner.user,
    sessionId: owner.session, connectionId, configRevision: 5, configDigest, invocation: configuration.invocation, limits: stdioLimits,
    scopeBinding: { kind: 'cloud', userId: owner.user, workspaceId: owner.workspace, bindingGeneration: 9,
      target: { spaceId: owner.workspace, rootRelativePath: '' }, home: { kind: 'user', userId: owner.user } },
    expectedDeploymentPin: deployment, origin: { kind: 'stdio_discovery', requestId } })
  const taskDigest = sha('task', task), executionRef = { kind: 'cloud' as const, executionId }
  const image = { kind: 'cloud' as const, platform: deployment.platform, imageReference: deployment.imageReference,
    runtimeImageId: deployment.runtimeImageIds[0] }
  const prepared = stdioPreparedV2.parse({ formatVersion: 2, actionId, executionRef, taskDigest, scopeBinding: task.scopeBinding,
    expectedDeploymentPin: deployment, actualExecutorImage: image, fullScopeDigest: sha('scope', task.scopeBinding),
    specDigest: sha('spec', configuration.invocation), capture: { kind: 'cloud', podUid: randomUUID(), podName: 'retained-old-pod',
      namespace: 'offline-owned-fixture', nodeName: 'old-node', runnerInstanceId: randomUUID(), containerId: 'old-container',
      restartCount: 0, mountGeneration: '9', workspaceMount: { claimName: 'old-claim', subPath: `workspaces/${owner.workspace}`,
        mountPath: '/workspace', readOnly: false }, homeMount: { claimName: 'old-claim', subPath: `homes/${owner.user}`,
        mountPath: '/home/agent', readOnly: false } } })
  const preparedDigest = sha('prepared', prepared), approval = stdioApprovalBindingV2.parse({ actionId, taskDigest,
    preparedDigest, approvalEpoch: 1, expiresAt })
  const fingerprint = stdioApprovalFingerprintV2(Buffer.alloc(32, 5), approval, stdioJsonLimits)
  const permit = stdioStartPermitV2.parse({ ...approval, permitId: randomUUID(), authorizationRequestId: randomUUID(),
    executionRef, executorOwner: { kind: 'cloud', runnerInstanceId: prepared.capture.runnerInstanceId },
    approvalFingerprint: fingerprint, issuedAt: time })
  const dispatch = stdioDispatchV2(stdioLimits).parse({ formatVersion: 2, task, taskDigest, executionRef, preparedDigest, permit })
  const dispatchDigest = sha('dispatch', dispatch), rawCatalog = [{ name: 'old_echo', description: '保留目录 😀', inputSchema: { type: 'object' } }]
  const outcome = stdioOutcomeV2(stdioLimits, 131072).parse({ state: 'completed', phase: 'discover', catalog: rawCatalog,
    pages: [{ tools: rawCatalog }], initializeResult: { protocolVersion: 'original' }, facts: { programStartAttempted: true,
      toolsCallAttempted: false, effectMayHaveOccurred: false, childPid: 123, childExitObserved: true, childCloseObserved: true,
      exitCode: 0, signal: null, cleanupConfirmed: true, protocolBytes: 100, protocolMessages: 3, stderrBytes: 0, stderr: '' } })
  const view = stdioRuntimeViewV2(stdioLimits, 131072).parse({ formatVersion: 2, instanceId: prepared.capture.runnerInstanceId,
    actionId, executionRef, taskDigest, dispatchDigest, state: 'completed', writerStopConfirmed: true, outcome })
  const stop = stdioCloudStopEvidenceV2.parse({ formatVersion: 2, kind: 'cloud_uid_quiet', actionId, executionRef, taskDigest,
    dispatchDigest, preparedDigest, fullScopeDigest: prepared.fullScopeDigest, podUid: prepared.capture.podUid,
    runnerInstanceId: prepared.capture.runnerInstanceId, mountGeneration: '9', observedAt: time })
  const check = stdioCheckRequestV2.parse({ requestId, connectionId, expectedRevision: 5, sessionId: owner.session, target: { kind: 'cloud' } })
  const receipt = schemas.checkReceipt.parse({ requestId, purpose: 'check', connectionId, revision: 5, actionId, executionRef })
  const add = (table: string, values: Record<string, string | null>) => {
    const record = sourceRow(table, values); records(bundle, table).push(record); return record
  }
  const connection = add('pe_stdio_v2_connections', { id: connectionId, user_id: owner.user, revision: '5', enabled: 'false', current_catalog_id: catalogId })
  add('pe_stdio_v2_configurations', { connection_id: connectionId, user_id: owner.user, revision: '5',
    configuration: JSON.stringify(configuration), config_digest: configDigest })
  add('pe_stdio_v2_management_requests', { user_id: owner.user, request_id: requestId, purpose: 'check', request: JSON.stringify(check),
    request_digest: sha('management', { purpose: 'check', input: check }), receipt: JSON.stringify(receipt) })
  const execution = add('pe_cloud_executions', { id: executionId, user_id: owner.user, session_id: owner.session, execution_kind: 'stdio_v2',
    execution_target: 'cloud', origin_kind: 'stdio_discovery', task_version: '2', stdio_phase: 'discover', stdio_task: JSON.stringify(task),
    stdio_action_id: actionId, request_digest: taskDigest, state: 'succeeded', sandbox_name: prepared.capture.podName,
    pod_uid: prepared.capture.podUid, runner_instance_id: prepared.capture.runnerInstanceId, continuation_request_id: null })
  const action = add('pe_stdio_v2_actions', { id: actionId, user_id: owner.user, session_id: owner.session, connection_id: connectionId,
    config_revision: '5', config_digest: configDigest, phase: 'discover', execution_target: 'cloud', execution_id: executionId,
    cloud_execution_id: executionId, request_id: requestId, task: JSON.stringify(task), task_digest: taskDigest, state: 'succeeded', lease_epoch: '17' })
  add('pe_stdio_v2_preparations', { action_id: actionId, user_id: owner.user, session_id: owner.session, phase: 'discover',
    execution_target: 'cloud', execution_id: executionId, task_digest: taskDigest, prepared: JSON.stringify(prepared),
    prepared_digest: preparedDigest, approval_binding: JSON.stringify(approval), fingerprint, approval_epoch: '1', expires_at: expiresAt })
  add('pe_stdio_v2_decisions', { action_id: actionId, user_id: owner.user, fingerprint, decision: 'once' })
  add('pe_stdio_v2_start_permits', { action_id: actionId, permit_id: permit.permitId, authorization_request_id: permit.authorizationRequestId,
    execution_id: executionId, task_digest: taskDigest, prepared_digest: preparedDigest, fingerprint, decision: 'once',
    executor_owner: JSON.stringify(permit.executorOwner), permit: JSON.stringify(permit), issued_at: time, expires_at: expiresAt })
  add('pe_stdio_v2_dispatches', { action_id: actionId, dispatch: JSON.stringify(dispatch), dispatch_digest: dispatchDigest })
  add('pe_stdio_v2_results', { action_id: actionId, result: JSON.stringify(outcome), result_digest: sha('result', outcome),
    observation: JSON.stringify(view), stop_evidence: JSON.stringify(stop) })
  const catalog = add('pe_stdio_v2_catalogs', { id: catalogId, user_id: owner.user, connection_id: connectionId, config_revision: '5',
    config_digest: configDigest, action_id: actionId, session_id: owner.session, phase: 'discover', raw_catalog: JSON.stringify(rawCatalog),
    image_expectation: JSON.stringify(image), catalog_digest: stdioCatalogFingerprintV2(rawCatalog, stdioLimits) })
  for (const [table, row] of [['pe_cloud_executions', execution], ['pe_stdio_v2_actions', action]] as const) {
    bundle.stops.push({ table, rowSha256: row.sha256, evidence: JSON.stringify(stop) })
  }
  const validateRow: LegacyImportOwners['validateRow'] = ({ row, json }) => {
    if (row.table === 'pe_stdio_v2_configurations') schemas.configuration.parse(json.configuration)
    if (row.table === 'pe_stdio_v2_actions') {
      const decoded = stdioTaskSchemasV2(stdioLimits).task.parse(json.task)
      if (sha('task', decoded) !== row.values.task_digest) throw new Error('Original task digest changed')
    }
    if (row.table === 'pe_stdio_v2_preparations') stdioPreparedV2.parse(json.prepared)
    if (row.table === 'pe_stdio_v2_start_permits') stdioStartPermitV2.parse(json.permit)
    if (row.table === 'pe_stdio_v2_dispatches') stdioDispatchV2(stdioLimits).parse(json.dispatch)
    if (row.table === 'pe_stdio_v2_results') {
      stdioRuntimeViewV2(stdioLimits, 131072).parse(json.observation)
      stdioCloudStopEvidenceV2.parse(json.stop_evidence)
      if (sha('result', stdioOutcomeV2(stdioLimits, 131072).parse(json.result)) !== row.values.result_digest) {
        throw new Error('Original result digest changed')
      }
    }
  }
  const verifyStopped: LegacyImportOwners['verifyStopped'] = ({ row }, proof) => {
    const decoded = stdioCloudStopEvidenceV2.parse(proof)
    if (!['pe_cloud_executions', 'pe_stdio_v2_actions'].includes(row.table) || JSON.stringify(decoded) !== JSON.stringify(stop)) {
      throw new Error('Original physical stop changed')
    }
  }
  return { connection, catalog, action, execution, task, outcome, configuration, validateRow, verifyStopped }
}
async function freshTarget(run: (fixture: { pool: Pool; name: string; root: string; storage: LegacyStorageOptions }) => Promise<void>,
  ordinary = false) {
  const file = process.env.PE_TEST_DATABASE_URL_FILE
  if (!file) throw new Error('Legacy import tests require PE_TEST_DATABASE_URL_FILE')
  const address = new URL((await readFile(file, 'utf8')).trim())
  const name = `pe_employee5_import_${randomUUID().replaceAll('-', '')}`
  const role = `pe_employee5_import_role_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: address.href, max: 1 })
  const target = new URL(address); target.pathname = `/${name}`
  const pool = new Pool({ connectionString: target.href, max: 4, ...(ordinary ? { options: `-c role=${role}` } : {}) })
  const root = await mkdtemp(join(tmpdir(), 'employee5-legacy-import-'))
  const bundleRoot = join(root, 'packet'), candidateRoot = join(root, 'candidate')
  let acquired = false, acquiredRole = false
  try {
    await mkdir(bundleRoot, { mode: 0o700 }); await writeFile(join(bundleRoot, 'payload.bin'), payload, { mode: 0o600 })
    if (ordinary) {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`); acquiredRole = true
    }
    await admin.query(`CREATE DATABASE "${name}"${ordinary ? ` OWNER "${role}"` : ''}`); acquired = true
    const storage: LegacyStorageOptions = { bundleRoot, candidateRoot, sourceUid: 1000, sourceGid: 1000,
      targetUid: process.getuid?.() ?? 0, targetGid: process.getgid?.() ?? 0 }
    await run({ pool, name, root, storage })
  } finally {
    await pool.end()
    if (acquired) await admin.query(`DROP DATABASE "${name}"`)
    if (acquiredRole) await admin.query(`DROP ROLE "${role}"`)
    await admin.end(); await rm(root, { recursive: true, force: true })
  }
}

test('the fixed packet represents every source table and counts all four source row dispositions', () => {
  const { bundle } = packet()
  const excluded = sourceRow('pe_artifacts'); excluded.disposition = 'excluded'; records(bundle, 'pe_artifacts').push(excluded)
  const text = seal(bundle), parsed = parseLegacyBundle(text, legacyLimits(limits))
  const plan = preflightLegacyImport(text, limits, owners(text))
  expect(Object.keys(parsed.tables)).toHaveLength(77)
  expect(Object.keys(LEGACY_TARGET_LAYOUT)).toHaveLength(71)
  expect(plan.counts.excluded).toBe(1)
  expect(plan.rows.some(row => row.table === 'pe_artifacts')).toBe(false)
  expect(plan.counts.preserve + plan.counts.convert + plan.counts.excluded + plan.counts.rejected)
    .toBe(Object.values(parsed.tables).reduce((sum, rows) => sum + rows.length, 0))
  expect(plan.rows.find(row => row.table === 'pe_schema')?.values).toEqual({ version: '2', family: 'cloud-native' })
  expect(Object.isFrozen(plan.rows[0]?.values)).toBe(true)
  expect(LEGACY_SOURCE_LAYOUT.pe_cloud_executions?.command?.nullable).toBe(true)
  expect(LEGACY_SOURCE_LAYOUT.pe_cloud_executions?.operation_id?.nullable).toBe(true)
  expect(LEGACY_SOURCE_LAYOUT.pe_sessions?.workspace_id?.nullable).toBe(false)
  expect(LEGACY_SOURCE_LAYOUT.pe_users?.display_name?.nullable).toBe(false)
})

for (const input of ['{"x":1,"x":2}', '{"x":9007199254740993}', '{"x":0.100000000000000000001}', '{"x":1e400}', '{"x":1} garbage']) {
  test(`ambiguous or incomplete JSON rejects before planning: ${input}`, () => {
    expect(() => legacyJson(input, limits)).toThrow(LegacyImportError)
  })
}
test('equivalent numeric lexemes and escaped Unicode remain in original JSON while decoding losslessly', () => {
  const { bundle } = packet(), plan = planned(bundle)
  const event = plan.rows.find(row => row.table === 'pe_events' && row.values.seq === '1')
  expect(event?.values.event).toContain('1e0')
  expect(event?.values.event).toContain('\\uD83D\\uDE00')
  expect(legacyJson(event?.values.event ?? '', limits)).toMatchObject({ data: { value: 1, emoji: '😀' } })
  expect(legacyJson('{"nul":"\\u0000"}', limits)).toEqual({ nul: '\0' })
  expect(legacyTimestamp(time)).toBe(BigInt(Date.parse(time)) * 1000n + 456n)
})

test('a lone surrogate remains legal raw JSON but cannot enter JSONB or an unqualified native search history', () => {
  expect(legacyJson('"\\uD800"', limits)).toBe('\uD800')
  const jsonb = packet().bundle, user = records(jsonb, 'pe_users')[0]
  if (!user) throw new Error('Fixture user missing')
  user.values.settings = '{"model":"trial-model","maxTokens":1000,"revision":7,"ignored":"\\uD800"}'
  expect(() => planned(jsonb)).toThrow('jsonb_unicode')
  const native = packet().bundle, session = records(native, 'pe_sessions')[0], event = records(native, 'pe_events')[0]
  if (!session || !event) throw new Error('Fixture native history missing')
  event.values.event = '{"seq":0,"time":1,"type":"employee5/retained","ignorable":true,"data":"\\uD800"}'
  session.values.event_bytes = String(records(native, 'pe_events').filter(row => row.values.session_id === session.values.id)
    .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(row.values.event ?? ''))), 0))
  expect(() => planned(native)).toThrow('native_json_surrogate_adapter_missing')
})

for (const defect of ['missing table', 'unknown table', 'missing column', 'extra column', 'bad hash', 'bad counts', 'rejected row', 'excluded accepted Cloud row'] as const) {
  test(`complete inventories reject ${defect}`, () => {
    const { bundle } = packet(), user = records(bundle, 'pe_users')[0]
    if (!user) throw new Error('Fixture user missing')
    if (defect === 'missing table') delete bundle.tables.pe_ssh_calls
    if (defect === 'unknown table') bundle.tables.arbitrary_sql = []
    if (defect === 'missing column') delete user.values.role
    if (defect === 'extra column') user.values.execute_sql = 'DROP TABLE pe_users'
    if (defect === 'rejected row') user.disposition = 'rejected'
    if (defect === 'excluded accepted Cloud row') user.disposition = 'excluded'
    let text = seal(bundle)
    if (defect === 'bad hash') { user.sha256 = '0'.repeat(64); text = JSON.stringify(bundle) }
    if (defect === 'bad counts') { bundle.counts.excluded++; text = JSON.stringify(bundle) }
    expect(() => preflightLegacyImport(text, limits, owners(text))).toThrow(LegacyImportError)
  })
}
for (const field of ['maxBundleBytes', 'maxRows', 'maxCellBytes', 'maxJsonDepth', 'maxJsonNodes', 'maxFiles'] as const) {
  test(`${field} is a complete maintenance limit rather than truncation`, () => {
    const { bundle } = packet()
    expect(() => planned(bundle, { ...limits, [field]: 1 })).toThrow(LegacyImportError)
  })
}
test('invalid maintenance budgets reject before any packet is decoded', () => {
  expect(() => legacyLimits({ ...limits, maxRows: 0 })).toThrow('invalid_limits')
})

for (const defect of ['cross owner', 'missing FK', 'duplicate PK', 'JSON foreign owner', 'queued', 'grant', 'live credential', 'open attempt'] as const) {
  test(`retained relation rejects ${defect}`, () => {
    const { bundle, bob } = packet(), operation = records(bundle, 'pe_operations')[0], session = records(bundle, 'pe_sessions')[0]
    const attempt = records(bundle, 'pe_attempts')[0], credential = records(bundle, 'pe_credentials')[0]
    if (!operation || !session || !attempt || !credential) throw new Error('Fixture relation missing')
    if (defect === 'cross owner') session.values.workspace_id = bob.workspace
    if (defect === 'missing FK') session.values.workspace_id = randomUUID()
    if (defect === 'duplicate PK') records(bundle, 'pe_operations').push(structuredClone(operation))
    if (defect === 'JSON foreign owner') {
      const event = records(bundle, 'pe_events').find(row => row.values.seq === '1')
      if (!event) throw new Error('Fixture ignored event missing')
      event.values.event = JSON.stringify({ seq: 1, time: 2, type: 'employee5/retained', ignorable: true, data: { workspaceId: bob.workspace } })
      session.values.event_bytes = String(records(bundle, 'pe_events').filter(row => row.values.session_id === session.values.id)
        .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(row.values.event ?? ''))), 0))
    }
    if (defect === 'queued') operation.values.state = 'queued'
    if (defect === 'grant') session.values.grant_digest = legacyDigest('old grant')
    if (defect === 'live credential') credential.values.expires_at = '2031-01-01T00:00:00Z'
    if (defect === 'open attempt') attempt.values.ended_at = null
    expect(() => planned(bundle)).toThrow(LegacyImportError)
  })
}
for (const defect of ['old format', 'future format', 'seed', 'fork', 'missing event', 'JSON sequence', 'tail', 'bytes', 'required unknown'] as const) {
  test(`native restore rejects ${defect} without deleting or renumbering history`, () => {
    const { bundle } = packet(), session = records(bundle, 'pe_sessions')[0], event = records(bundle, 'pe_events')[0]
    if (!session || !event) throw new Error('Fixture history missing')
    const header = z.record(z.string(), z.json()).parse(JSON.parse(session.values.header ?? ''))
    if (defect === 'old format') header.version = 3
    if (defect === 'future format') header.version = 5
    if (defect === 'seed') header.isSeeded = true
    if (defect === 'fork') header.parentSession = randomUUID()
    session.values.header = JSON.stringify(header)
    if (defect === 'missing event') records(bundle, 'pe_events').splice(0, 1)
    if (defect === 'JSON sequence') event.values.event = (event.values.event ?? '').replace('"seq":0', '"seq":9')
    if (defect === 'tail') event.values.seq = '100'
    if (defect === 'bytes') session.values.event_bytes = '1'
    if (defect === 'required unknown') {
      event.values.event = JSON.stringify({ seq: 0, time: 1, type: 'employee5/unknown', data: {} })
      const remaining = records(bundle, 'pe_events').filter(row => row.values.session_id === session.values.id)
      session.values.event_bytes = String(remaining.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(row.values.event ?? ''))), 0))
    }
    expect(() => planned(bundle)).toThrow(LegacyImportError)
  })
}
test('mandatory owner adapters cannot be omitted or have their rejected facts silently skipped', () => {
  const { bundle } = packet(), text = seal(bundle)
  expect(() => preflightLegacyImport(text, limits, { ...owners(text), verifyFiles: () => { throw new Error('Missing file adapter') } })).toThrow('file_snapshot_unverified')
  expect(() => planned(bundle, limits, { validateRow: () => { throw new Error('private secret must not escape') } }))
    .toThrow('subsystem_record_unverified')
  expect(() => planned(bundle, limits, { verifyCut: () => { throw new Error('bad signed cut') } })).toThrow('export_cut_unverified')
})

test('legal legacy JSON NUL preserves its raw text and exposes the PostgreSQL text extraction incompatibility', () => freshTarget(async (f) => {
  const event = '{"seq":0,"time":1,"type":"employee5/retained","ignorable":true,"data":{"nul":"\\u0000"}}'
  expect((await f.pool.query<{ text: string }>('SELECT $1::json::text AS text', [event])).rows[0]?.text).toBe(event)
  await expect(f.pool.query("WITH e AS (SELECT $1::json AS event) SELECT e.event->>'type' AS type FROM e", [event]))
    .rejects.toMatchObject({ code: '22P05', message: 'unsupported Unicode escape sequence' })
  const { bundle } = packet(), session = records(bundle, 'pe_sessions')[0], first = records(bundle, 'pe_events')[0]
  if (!session || !first) throw new Error('Fixture history missing')
  first.values.event = event
  session.values.event_bytes = String(records(bundle, 'pe_events').filter(row => row.values.session_id === session.values.id)
    .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(JSON.parse(row.values.event ?? ''))), 0))
  expect(() => planned(bundle)).toThrow('native_json_nul_adapter_missing')
  expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([])
}))

for (const defect of ['proof absent', 'foreign physical identity', 'changed immutable request', 'running', 'uncertain', 'unknown without closure'] as const) {
  test(`historical Cloud effects reject ${defect} without reconstructing an execution`, () => {
    const { bundle, alice } = packet(), cloud = stoppedCloud(bundle, alice)
    if (defect === 'proof absent') bundle.stops = []
    if (defect === 'foreign physical identity') {
      const proof = bundle.stops[0]
      if (!proof) throw new Error('Fixture stop proof missing')
      proof.evidence = JSON.stringify({ ...cloud.proof, podUid: randomUUID() })
    }
    if (defect === 'changed immutable request') cloud.execution.values.command = 'printf changed-command'
    if (defect === 'running') cloud.execution.values.state = 'running'
    if (defect === 'uncertain') cloud.execution.values.state = 'uncertain'
    if (defect === 'unknown without closure') cloud.execution.values.state = 'closed_unknown'
    const expected = { 'proof absent': 'original_stop_proof_missing', 'foreign physical identity': 'original_stop_unverified',
      'changed immutable request': 'subsystem_record_unverified', running: 'replayable_state', uncertain: 'replayable_state',
      'unknown without closure': 'unknown_closure_missing' }[defect]
    if (['changed immutable request', 'running', 'uncertain'].includes(defect)) {
      const proof = bundle.stops[0]
      if (!proof) throw new Error('Fixture stop proof missing')
      proof.rowSha256 = legacyRowDigest('pe_cloud_executions', cloud.execution.values)
    }
    expect(() => planned(bundle, limits, cloud)).toThrow(expected)
  })
}

test('real PG preserves ended Cloud physical identities and result JSON with no new continuation or runnable row', () => freshTarget(async (f) => {
  const { bundle, alice } = packet(), cloud = stoppedCloud(bundle, alice), plan = planned(bundle, limits, cloud)
  const result = await writeLegacyImport(f.pool, plan, { expectedDatabase: f.name, storage: f.storage })
  expect(result.tableCounts.pe_cloud_executions).toBe('1')
  expect(result.tableCounts.pe_operations).toBe('2')
  expect((await f.pool.query('SELECT id::text,pod_uid::text,runner_instance_id::text,result::text AS result,state FROM pe_cloud_executions')).rows)
    .toEqual([{ id: cloud.execution.values.id, pod_uid: cloud.execution.values.pod_uid,
      runner_instance_id: cloud.execution.values.runner_instance_id, result: cloud.execution.values.result, state: 'succeeded' }])
  expect((await f.pool.query("SELECT id FROM pe_operations WHERE state IN ('queued','running','cancelling')")).rows).toEqual([])
  expect((await f.pool.query('SELECT grant_digest FROM pe_sessions WHERE grant_digest IS NOT NULL')).rows).toEqual([])
  expect((await f.pool.query('SELECT session_id FROM pe_native_prompt_inputs')).rows).toEqual([])
}))

for (const foreignIdentity of [false, true]) {
  test(`formal closed_unknown Cloud closure retains the exact ended execution, foreign identity=${foreignIdentity}`, () => freshTarget(async (f) => {
    const { bundle, alice } = packet(), cloud = stoppedCloud(bundle, alice)
    cloud.execution.values.state = 'closed_unknown'; cloud.execution.values.result = null
    const stop = bundle.stops[0]
    if (!stop) throw new Error('Fixture original stop proof missing')
    stop.rowSha256 = legacyRowDigest('pe_cloud_executions', cloud.execution.values)
    const resolution = sourceRow('pe_cloud_execution_resolutions', { user_id: alice.user, session_id: alice.session,
      execution_id: cloud.execution.values.id ?? '', workspace_id: alice.workspace, mount_generation: '9',
      sandbox_name: cloud.execution.values.sandbox_name ?? '', pod_uid: cloud.execution.values.pod_uid ?? '',
      runner_instance_id: foreignIdentity ? randomUUID() : cloud.execution.values.runner_instance_id ?? '',
      execution_request_digest: cloud.execution.values.request_digest ?? '', request_digest: legacyDigest('fixed-resolution-request'),
      fingerprint: legacyDigest('fixed-resolution-fingerprint'), binding_snapshot: JSON.stringify({ workspaceId: alice.workspace }),
      state: 'completed', stop_evidence: JSON.stringify(cloud.proof), final_execution_state: 'closed_unknown',
      continuation_request_id: cloud.execution.values.continuation_request_id ?? '', continuation_queued: 'true', lease_epoch: '21', attempts: '1' })
    records(bundle, 'pe_cloud_execution_resolutions').push(resolution)
    bundle.stops.push({ table: 'pe_cloud_execution_resolutions', rowSha256: resolution.sha256, evidence: JSON.stringify(cloud.proof) })
    const original = records(bundle, 'pe_operations')[0]
    if (!original) throw new Error('Fixture root operation missing')
    records(bundle, 'pe_operations').push(sourceRow('pe_operations', { ...original.values, id: randomUUID(),
      request_id: cloud.execution.values.continuation_request_id ?? '', source: 'sandbox_result',
      source_execution_id: cloud.execution.values.id ?? '', mcp_root_operation_id: alice.operation }))
    const adapters = { validateRow: cloud.validateRow, verifyStopped: (context: Parameters<LegacyImportOwners['verifyStopped']>[0],
      proof: Parameters<LegacyImportOwners['verifyStopped']>[1]) => {
      if (context.row.table === 'pe_cloud_executions') cloud.verifyStopped(context, proof)
      else if (context.row.table !== 'pe_cloud_execution_resolutions' || JSON.stringify(proof) !== JSON.stringify(cloud.proof)) {
        throw new Error('Original closure stop proof missing')
      }
    } }
    if (foreignIdentity) {
      expect(() => planned(bundle, limits, adapters)).toThrow('resolution_execution_identity_changed')
      await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    const result = await writeLegacyImport(f.pool, planned(bundle, limits, adapters), { expectedDatabase: f.name, storage: f.storage })
    expect(result.tableCounts.pe_cloud_execution_resolutions).toBe('1')
    expect(result.tableCounts.pe_operations).toBe('3')
    expect((await f.pool.query('SELECT state,result FROM pe_cloud_executions')).rows).toEqual([{ state: 'closed_unknown', result: null }])
    expect((await f.pool.query('SELECT state,lease_epoch,continuation_queued FROM pe_cloud_execution_resolutions')).rows)
      .toEqual([{ state: 'completed', lease_epoch: '21', continuation_queued: true }])
  }))
}

test('real PG preserves a closed STDIO no-start fact, its generated Cloud identity and all original immutable triggers', () => freshTarget(async (f) => {
  const { bundle, alice } = packet(), stdio = noStartStdio(bundle, alice)
  const result = await writeLegacyImport(f.pool, planned(bundle, limits, stdio), { expectedDatabase: f.name, storage: f.storage })
  expect(result.tableCounts.pe_stdio_v2_actions).toBe('1')
  expect(result.tableCounts.pe_stdio_v2_start_permits).toBe('0')
  expect(result.tableCounts.pe_stdio_v2_dispatches).toBe('0')
  expect((await f.pool.query('SELECT execution_id::text,cloud_execution_id::text,state,lease_epoch FROM pe_stdio_v2_actions')).rows)
    .toEqual([{ execution_id: stdio.execution.values.id, cloud_execution_id: stdio.execution.values.id, state: 'failed', lease_epoch: '17' }])
  expect((await f.pool.query('SELECT receipt::text,lease_epoch FROM pe_stdio_v2_no_start_closures')).rows)
    .toEqual([{ receipt: stdio.closure.values.receipt, lease_epoch: '17' }])
  await expect(f.pool.query('UPDATE pe_stdio_v2_no_start_closures SET lease_epoch=18')).rejects.toMatchObject({ code: '23514' })
}))

test('a no-start fact cannot coexist with a completed STDIO result even when all referenced rows exist', () => {
  const { bundle, alice } = packet(), stdio = noStartStdio(bundle, alice)
  records(bundle, 'pe_stdio_v2_results').push(sourceRow('pe_stdio_v2_results', { action_id: stdio.action.values.id ?? '',
    result: '{}', result_digest: legacyDigest('{}'), observation: '{}', stop_evidence: '{}' }))
  expect(() => planned(bundle, limits, stdio)).toThrow('start_and_no_start')
})

test('a packet cannot overwrite the generated STDIO Cloud execution identity', () => {
  const { bundle, alice } = packet(), stdio = noStartStdio(bundle, alice)
  stdio.action.values.cloud_execution_id = randomUUID()
  expect(() => planned(bundle, limits, stdio)).toThrow('generated_execution_identity')
})

test('an ordinary PG role imports the non-NULL STDIO catalog cycle with original permits, results and readable native consumers', () => freshTarget(async (f) => {
  expect((await f.pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows)
    .toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }])
  const { bundle, alice } = packet(), stdio = catalogStdio(bundle, alice)
  const result = await writeLegacyImport(f.pool, planned(bundle, limits, stdio), { expectedDatabase: f.name, storage: f.storage })
  expect(result.tableCounts.pe_stdio_v2_catalogs).toBe('1')
  expect(result.tableCounts.pe_stdio_v2_start_permits).toBe('1')
  const fk = (await f.pool.query(`SELECT convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conname='pe_stdio_v2_connections_current_catalog'`)).rows
  expect(fk).toEqual([{ convalidated: true, condeferrable: false, condeferred: false,
    definition: 'FOREIGN KEY (current_catalog_id, user_id, id, revision) REFERENCES pe_stdio_v2_catalogs(id, user_id, connection_id, config_revision)' }])
  expect((await f.pool.query("SELECT count(*)::text AS total,count(*) FILTER(WHERE convalidated)::text AS valid FROM pg_constraint WHERE contype='f'")).rows)
    .toEqual([{ total: '143', valid: '143' }])
  expect((await f.pool.query('SELECT current_catalog_id::text FROM pe_stdio_v2_connections')).rows)
    .toEqual([{ current_catalog_id: stdio.catalog.values.id }])
  const native = new NativeSessionRead(f.pool), owner = identity.parse({ userId: alice.user, username: 'import-alice' })
  expect(await native.list(owner)).toMatchObject({ items: [{ sessionId: alice.session }] })
  expect(await native.after(owner, sessionId.parse(alice.session), -1)).toHaveLength(2)
  const login = await new IdentityService(f.pool, 60000).login('import-alice', 'owned-fixture-password')
  const connections = new StdioConnectionServiceV2(f.pool, stdioLimits, stdioManagement)
  expect(await connections.list(login.token, {})).toMatchObject({ items: [{ connectionId: stdio.connection.values.id,
    catalogId: stdio.catalog.values.id, configuration: stdio.configuration }] })
  const actions = new StdioActionServiceV2(f.pool, { limits: stdioLimits, maxReplyBytes: 131072, maxPageSize: 2 })
  expect(await actions.detail(login.token, { actionId: stdio.task.actionId })).toMatchObject({ state: 'succeeded',
    executionState: 'succeeded', task: stdio.task, outcome: stdio.outcome, noStart: null })
  expect((await f.pool.query("SELECT id FROM pe_stdio_v2_actions WHERE state IN ('queued','preparing','running','blocked')")).rows).toEqual([])
  expect((await f.pool.query('SELECT count(*)::text AS count FROM pe_operations')).rows).toEqual([{ count: '2' }])
}, true))

for (const defect of ['missing catalog', 'wrong revision', 'foreign catalog', 'changed result digest'] as const) {
  test(`a bad STDIO catalog cycle rejects ${defect} before any target write`, () => freshTarget(async (f) => {
    const { bundle, alice, bob } = packet(), stdio = catalogStdio(bundle, alice)
    if (defect === 'missing catalog') stdio.connection.values.current_catalog_id = randomUUID()
    if (defect === 'wrong revision') stdio.catalog.values.config_revision = '6'
    if (defect === 'foreign catalog') stdio.catalog.values.user_id = bob.user
    if (defect === 'changed result digest') {
      const result = records(bundle, 'pe_stdio_v2_results')[0]
      if (!result) throw new Error('Fixture result missing')
      result.values.result_digest = '0'.repeat(64)
    }
    expect(() => planned(bundle, limits, stdio)).toThrow(LegacyImportError)
    expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([])
    await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.storage.bundleRoot, 'payload.bin'))).toEqual(payload)
  }))
}

for (const defect of ['missing instruction', 'changed manifest', 'extra package file', 'missing text skill'] as const) {
  test(`complete retained Skill inventory rejects ${defect} before candidate creation`, () => freshTarget(async (f) => {
    const { bundle, alice } = packet(), skill = packagedSkill(bundle, alice)
    await writeFile(join(f.storage.bundleRoot, 'skill-manifest'), skill.manifest)
    await writeFile(join(f.storage.bundleRoot, 'skill-instruction'), skill.instruction)
    if (defect === 'missing instruction') bundle.files = bundle.files.filter(entry => entry.path !== 'skill/SKILL.md')
    if (defect === 'changed manifest') {
      const version = records(bundle, 'pe_skill_package_versions')[0]
      if (!version) throw new Error('Fixture Skill version missing')
      version.values.manifest = '{}'
    }
    if (defect === 'extra package file') {
      const entry = bundle.files.find(entry => entry.path === 'skill/SKILL.md')
      if (!entry) throw new Error('Fixture Skill instruction missing')
      bundle.files.push({ ...entry, path: 'skill/hidden.sh' })
    }
    if (defect === 'missing text skill') records(bundle, 'pe_user_skills').push(sourceRow('pe_user_skills', {
      user_id: alice.user, kind: 'text', name: 'missing-text', digest: legacyDigest('missing-text'), revision: '1',
    }))
    await expect(verifyLegacyStorage(planned(bundle), f.storage)).rejects.toBeInstanceOf(LegacyImportError)
    await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }))
}

for (const keepArchive of [false, true]) {
  test(`real PG restores the Skill FK cycle and immutable published tree with original archive backup=${keepArchive}`, () => freshTarget(async (f) => {
    const { bundle, alice } = packet(), skill = packagedSkill(bundle, alice)
    await writeFile(join(f.storage.bundleRoot, 'skill-manifest'), skill.manifest)
    await writeFile(join(f.storage.bundleRoot, 'skill-instruction'), skill.instruction)
    if (keepArchive) {
      await writeFile(join(f.storage.bundleRoot, 'skill-archive'), skill.archive)
      bundle.files.push({ area: 'skill-package', owner: alice.user, resource: skill.archiveDigest, path: 'archive.zip', kind: 'file',
        sourcePath: 'skill-archive', bytes: String(skill.archive.length), sha256: skill.archiveDigest, mode: 0o440, uid: 1000, gid: 1000 })
    }
    const result = await writeLegacyImport(f.pool, planned(bundle), { expectedDatabase: f.name, storage: f.storage })
    expect((await f.pool.query('SELECT id::text,package_version_id::text FROM pe_user_skills')).rows)
      .toEqual([{ id: skill.skillId, package_version_id: skill.versionId }])
    expect((await f.pool.query("SELECT conname,convalidated,condeferrable FROM pg_constraint WHERE conname IN ('pe_skill_package_versions_skill_id_user_id_fkey','pe_user_skills_package_version') ORDER BY conname")).rows)
      .toEqual([{ conname: 'pe_skill_package_versions_skill_id_user_id_fkey', convalidated: true, condeferrable: false },
        { conname: 'pe_user_skills_package_version', convalidated: true, condeferrable: false }])
    const published = join(result.storage.roots.skillLibraryRoot, 'skill-packages', alice.user, 'sha256', skill.archiveDigest)
    await verifyPublishedSkillPackage(published, skill.manifest, skill.files)
    await expect(lstat(join(published, 'archive.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (keepArchive) expect(await readFile(join(result.storage.root, 'legacy-backup', 'skill-archives', alice.user, skill.archiveDigest, 'archive.zip')))
      .toEqual(skill.archive)
  }))
}

test('a future source cut rejects against the target PostgreSQL clock before any schema or file writes', () => freshTarget(async (f) => {
  const { bundle } = packet()
  bundle.source.cut = '9999-01-01T00:00:00Z'
  await expect(writeLegacyImport(f.pool, planned(bundle), { expectedDatabase: f.name, storage: f.storage }))
    .rejects.toMatchObject({ code: 'source_cut_in_future' })
  expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([])
  await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
}))

test('real empty PG preserves JSON text, microseconds, users, epochs and files and derives cold projections', () => freshTarget(async (f) => {
  const { bundle, alice, bob } = packet(), plan = planned(bundle)
  const result = await writeLegacyImport(f.pool, plan, { expectedDatabase: f.name, storage: f.storage })
  expect(result).toMatchObject({ family: 'cloud-native', version: 2, sourceCounts: plan.counts })
  const definitions = (await f.pool.query<{
    table_name: string
    column_name: string
    udt_name: string
    is_nullable: string
    is_generated: string
  }>(
    "SELECT table_name,column_name,udt_name,is_nullable,is_generated FROM information_schema.columns WHERE table_schema='public'" )).rows
  expect(definitions).toHaveLength(742)
  const pgTypes: Record<string, string> = { integer: 'int4', bigint: 'int8', boolean: 'bool' }
  for (const column of definitions) {
    const expected = LEGACY_TARGET_LAYOUT[column.table_name]?.[column.column_name]
    expect(expected).toBeDefined()
    expect({ kind: column.udt_name, nullable: column.is_nullable === 'YES', generated: column.is_generated === 'ALWAYS' })
      .toEqual({ kind: pgTypes[expected?.kind ?? ''] ?? expected?.kind, nullable: expected?.nullable, generated: expected?.generated })
  }
  expect(Object.keys(result.tableCounts)).toHaveLength(71)
  expect(result.tableCounts.pe_native_preferences).toBe('2')
  expect(result.tableCounts.pe_native_prompt_inputs).toBe('0')
  expect(result.tableCounts.pe_native_file_receipts).toBe('0')
  const retained = records(bundle, 'pe_events').find(row => row.values.session_id === alice.session && row.values.seq === '1')
  expect((await f.pool.query<{ text: string }>('SELECT event::text AS text FROM pe_events WHERE session_id=$1 AND seq=1', [alice.session])).rows[0]?.text)
    .toBe(retained?.values.event)
  expect((await f.pool.query('SELECT lease_epoch,grant_digest,to_char(created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS created FROM pe_sessions WHERE id=$1',
    [alice.session])).rows[0]).toEqual({ lease_epoch: 13, grant_digest: null, created: time })
  const native = new NativeSessionRead(f.pool)
  const aliceIdentity = identity.parse({ userId: alice.user, username: 'import-alice' })
  const bobIdentity = identity.parse({ userId: bob.user, username: 'import-bob' }), aliceSession = sessionId.parse(alice.session)
  expect(await native.list(aliceIdentity)).toMatchObject({ items: [{ sessionId: alice.session }] })
  const events = await native.after(aliceIdentity, aliceSession, -1)
  expect(events).toHaveLength(2)
  expect(events[0]).toMatchObject({ data: { title: 'Alice old title' } })
  await expect(native.after(bobIdentity, aliceSession, -1))
    .rejects.toMatchObject({ status: 404 })
  const retainedPassword = (await f.pool.query<{ password_hash: string }>('SELECT password_hash FROM pe_users WHERE id=$1', [alice.user])).rows[0]?.password_hash
  expect(retainedPassword).toBe(passwordHash)
  expect(await verifyPassword('owned-fixture-password', retainedPassword ?? '')).toBe(true)
  expect(await verifyPassword('changed-password', retainedPassword ?? '')).toBe(false)
  const restored = join(result.storage.roots.workspaceRoot, alice.workspace, '旧文件.txt')
  expect(await readFile(restored)).toEqual(payload)
  expect((await lstat(restored)).mode & 0o777).toBe(0o640)
  expect(JSON.parse(await readFile(join(result.storage.root, 'legacy-import-receipt.json'), 'utf8'))).toMatchObject({ phase: 'complete', packetSha256: plan.packetSha256 })
  expect(await readFile(join(f.storage.bundleRoot, 'payload.bin'))).toEqual(payload)
  const before = await f.pool.query<{ version: number; family: string }>('SELECT * FROM pe_schema')
  expect(before.rows).toEqual([{ version: 2, family: 'cloud-native' }])
  const tableRows = async (table: string) => (await f.pool.query<{ record: string }>(
    `SELECT row_to_json(t)::text AS record FROM public."${table}" AS t`,
  )).rows.map(row => row.record).sort()
  const retainedTables = Object.keys(LEGACY_TARGET_LAYOUT).filter(table => table !== 'pe_schema')
  expect(retainedTables).toHaveLength(70)
  const beforeRows = new Map<string, readonly string[]>()
  for (const table of retainedTables) beforeRows.set(table, await tableRows(table))
  await initializeDatabase(f.pool)
  expect((await f.pool.query('SELECT * FROM pe_schema')).rows)
    .toEqual(before.rows.map(row => ({ ...row, version: CURRENT_SCHEMA_VERSION })))
  for (const table of retainedTables) expect(await tableRows(table), table).toEqual(beforeRows.get(table))
  const currentTables = Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(
    new URL('../assets/cloud-schema-v' + String(CURRENT_SCHEMA_VERSION) + '.manifest.json', import.meta.url), 'utf8'))))
  const initializedTables = currentTables.filter(table => !Object.hasOwn(LEGACY_TARGET_LAYOUT, table))
  expect((await f.pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'",
  )).rows.map(row => row.tablename).sort()).toEqual(currentTables.sort())
  for (const table of initializedTables) {
    expect((await f.pool.query(`SELECT * FROM public."${table}"`)).rows, table).toEqual([])
  }
  await expect(writeLegacyImport(f.pool, plan, { expectedDatabase: f.name, storage: { ...f.storage, candidateRoot: join(f.root, 'duplicate') } }))
    .rejects.toMatchObject({ code: 'nonempty_target_database' })
  await expect(lstat(join(f.root, 'duplicate'))).rejects.toMatchObject({ code: 'ENOENT' })
}))

for (const object of ['table', 'view', 'function', 'custom schema', 'pg prefix schema', 'preinitialized', 'future schema'] as const) {
  test(`existing target ${object} rejects before touching candidate storage`, () => freshTarget(async (f) => {
    if (object === 'table') await f.pool.query('CREATE TABLE retained_target(id integer)')
    if (object === 'view') await f.pool.query('CREATE VIEW retained_target AS SELECT 1 AS id')
    if (object === 'function') await f.pool.query('CREATE FUNCTION retained_target() RETURNS integer LANGUAGE sql AS \'SELECT 1\'')
    if (object === 'custom schema') await f.pool.query('CREATE SCHEMA retained_target')
    if (object === 'pg prefix schema') await f.pool.query('CREATE SCHEMA pgbusiness')
    if (object === 'preinitialized') await initializeDatabase(f.pool)
    if (object === 'future schema') await f.pool.query("CREATE TABLE pe_schema(version integer,family text); INSERT INTO pe_schema VALUES(99,'cloud-native')")
    const { bundle } = packet()
    await expect(writeLegacyImport(f.pool, planned(bundle), { expectedDatabase: f.name, storage: f.storage }))
      .rejects.toMatchObject({ code: 'nonempty_target_database' })
    await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    if (object === 'future schema') expect((await f.pool.query('SELECT * FROM pe_schema')).rows).toEqual([{ version: 99, family: 'cloud-native' }])
  }))
}
test('real PG constraint rejection rolls back schema and only its owned candidate, retaining the source bytes', () => freshTarget(async (f) => {
  const { bundle } = packet(), user = records(bundle, 'pe_users')[0]
  if (!user) throw new Error('Fixture user missing')
  user.values.role = 'INVALID_ROLE'
  await expect(writeLegacyImport(f.pool, planned(bundle), { expectedDatabase: f.name, storage: f.storage }))
    .rejects.toMatchObject({ code: 'postgres_import_rejected' })
  expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([])
  await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.storage.bundleRoot, 'payload.bin'))).toEqual(payload)
}))
test('independent concurrent imports serialize and leave one complete candidate with no second business writes', () => freshTarget(async (f) => {
  const { bundle } = packet(), plan = planned(bundle)
  const results = await Promise.allSettled([writeLegacyImport(f.pool, plan, { expectedDatabase: f.name, storage: f.storage }),
    writeLegacyImport(f.pool, plan, { expectedDatabase: f.name, storage: { ...f.storage, candidateRoot: join(f.root, 'second') } })])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected')
  expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'nonempty_target_database' } })
  expect((await f.pool.query('SELECT count(*)::text AS count FROM pe_users')).rows).toEqual([{ count: '2' }])
}))
for (const defect of ['bytes', 'missing root', 'missing parent', 'escape', 'wrong owner', 'alias',
  'parent alias', 'surrogate path', 'symlink', 'file limit', 'total bytes'] as const) {
  test(`actual file inventory rejects ${defect} before target schema creation`, () => freshTarget(async (f) => {
    const { bundle } = packet(), file = bundle.files.find(entry => entry.kind === 'file')
    if (!file) throw new Error('Fixture file missing')
    let configuration = limits
    if (defect === 'bytes') await writeFile(join(f.storage.bundleRoot, 'payload.bin'), 'changed')
    if (defect === 'missing root') bundle.files.splice(0, 1)
    if (defect === 'missing parent') file.path = 'absent/旧文件.txt'
    if (defect === 'escape') file.sourcePath = '../escape'
    if (defect === 'wrong owner') file.owner = randomUUID()
    if (defect === 'alias') bundle.files.push({ ...file, path: '旧文件.TXT' })
    if (defect === 'parent alias') {
      for (const path of ['Dir', 'dir']) bundle.files.push({ ...file, kind: 'directory', path, sourcePath: null, bytes: null, sha256: null })
      file.path = 'Dir/旧文件.txt'
      bundle.files.push({ ...file, path: 'dir/other.txt' })
    }
    if (defect === 'surrogate path') file.path = '\uD800'
    if (defect === 'symlink') {
      await symlink(join(f.storage.bundleRoot, 'payload.bin'), join(f.storage.bundleRoot, 'linked'))
      file.sourcePath = 'linked'
    }
    if (defect === 'file limit') configuration = { ...limits, maxFileBytes: 1 }
    if (defect === 'total bytes') configuration = { ...limits, maxStorageBytes: 1 }
    const plan = planned(bundle, configuration)
    await expect(verifyLegacyStorage(plan, f.storage)).rejects.toBeInstanceOf(Error)
    expect((await f.pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows).toEqual([])
    await expect(lstat(f.storage.candidateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }))
}
