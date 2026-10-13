/** Real detached Schema37 capture and official private dsh maintenance Profile. */
import { randomUUID, randomBytes, scryptSync, generateKeyPairSync, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, chmod, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { MaintenanceDrain, MaintenancePg, maintenanceProcessGroup } from './employee5-maintenance-drain.ts'
import { z } from 'zod'
import { zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { nativeFileAttachment } from '../src/native-attachment-contracts.ts'
import { beforeEach, expect, test, vi, type TestContext } from 'vitest'
import { Session, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { MessageId, projectOffloadedImages, offloadedImageText } from '@deepseek-ai/dsh-llm'
import AttachmentLocal, { saveFileStreamVerbatim, storedFilePath } from '@deepseek-ai/dsh-attachment-local'
import { identity, requestId, sessionId, skillSelection, sshSelection, sshCreateTicketRequest, sshExecuteView } from '../src/contracts.ts'
import { LEGACY_SOURCE_LAYOUT, LEGACY_TARGET_LAYOUT, LEGACY_SQL_DIGESTS } from '../src/platform/legacy-import-layout.ts'
import { legacyDigest, legacyRowDigest, type LegacyFileEntry, type LegacyImportLimits } from '../src/platform/legacy-import-codec.ts'
import { captureLegacyMigrationSource, legacyMigrationCatalogDigest, type LegacyMigrationCapture } from '../src/platform/legacy-migration-v2-source.ts'
import { migrateLegacyHistories, type LegacyHistoryStorage } from '../src/platform/legacy-migration-v2-history.ts'
import { planLegacyHistoryFiles, type LegacyMigrationFileSource } from '../src/platform/legacy-migration-v2-attachments.ts'
import { createLegacyMigrationStdioDiscoveryContext, legacyMigrationStdioDiscoveryEvidence,
  validateLegacyMigrationStdioDiscovery } from '../src/platform/legacy-migration-v2-stdio-discovery.ts'
import { StdioOperationAdmissionV2 } from '../src/platform/stdio-v2-operation-admission.ts'
import { StdioCloudWorkerStoreV2 } from '../src/platform/stdio-v2-worker-store.ts'
import { StdioAuthorizationServiceV2 } from '../src/platform/stdio-v2-authorization.ts'
import { stdioStartPermitV2, stdioPreparedV2, stdioActionRequestV2, stdioExecutorOwnerV2 } from '@power-evolve/contracts/stdio-mcp'
import { prepareLegacyMigration } from '../src/platform/legacy-migration-v2-plan.ts'
import { legacyMigrationStoppedCreationEvidence, createLegacyMigrationStoppedCreationContext,
  validateLegacyMigrationStoppedCreation } from '../src/platform/legacy-migration-v2-sandbox-stopped.ts'
import { headerSchema, parseEvents } from '../src/session-records.ts'
import { EventStore } from '../src/platform/events.ts'
import { NativeSessionRead } from '../src/platform/native-session-read.ts'
import { NativeSessionCommands } from '../src/platform/native-session-commands.ts'
import { NativeAttachments } from '../src/platform/native-attachments.ts'
import { nativeAttachmentUsage } from '../src/platform/native-attachment-storage.ts'
import { IdentityService } from '../src/platform/identity.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { transaction } from '../src/platform/database.ts'
import { CURRENT_SCHEMA_VERSION } from '../src/platform/database.ts'
import { FileService } from '../src/platform/files.ts'
import { planLegacyHistoryImages, legacyImageLocation, readLegacyOriginalImage } from '../src/platform/legacy-migration-v2-images.ts'
import { legacyMigrationImageBinding, legacyMigrationImagesInput,
  type LegacyMigrationImagesInput } from '../src/platform/legacy-migration-v2-media-contracts.ts'
import { LegacyMigrationImageReader } from '../src/platform/legacy-migration-v2-image-reader.ts'
import { writeLegacyMigration } from '../src/platform/legacy-migration-v2-write.ts'
import { legacyMigrationImage } from '../src/platform/legacy-migration-v2-media-contracts.ts'
import { LegacyMigrationHostImages } from '../src/platform/legacy-migration-v2-host-images.ts'
import RuntimeScope from '../src/host/scope.ts'
import { accountMutationReceipt, accountUpdateRequest, accountUserId } from '../src/account-contracts.ts'
import { AccountService } from '../src/platform/accounts.ts'
import { AccountSettingsService } from '../src/platform/account-settings.ts'
import { PluginService } from '../src/platform/plugins.ts'
import { bootstrapAccount } from '../src/platform/account-bootstrap.ts'
import { validateLegacyMigrationAccountOwner } from '../src/platform/legacy-migration-v2-account-owners.ts'
import { validateLegacyMigrationFixedMcp, validateLegacyMigrationFixedMcpOperation } from '../src/platform/legacy-migration-v2-fixed-mcp.ts'
import { PersonalMcpService } from '../src/platform/mcp.ts'
import { SkillService } from '../src/platform/skills.ts'
import { extractSkillPackage } from '../src/platform/skill-package-extraction.ts'
import { skillPackageManifest, skillPackageVersion } from '../src/platform/skill-package-manifest.ts'
import { readNativeSkillMetadata } from '../src/platform/skill-metadata.ts'
import { validateLegacyMigrationStorageOwner, validateLegacyMigrationSkillOperation } from '../src/platform/legacy-migration-v2-storage-owners.ts'
import { validateLegacyMigrationPristineMount } from '../src/platform/legacy-migration-v2-mount-free.ts'
import { readLegacyMigrationStdioPreparationApproval,
  readLegacyMigrationStdioDecisionMetadata } from '../src/platform/legacy-migration-v2-stdio-approval.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readJson, sendJson, sendFailure } from '../src/http.ts'
import { McpConnectionService } from '../src/platform/mcp-connections.ts'
import { mcpCatalogId, mcpCheckId, mcpConnectionId, mcpCreateRequest, mcpUpdateRequest, mcpToggleRequest,
  mcpResourceId, mcpDraftRequest, mcpCheckRequest, mcpLeaseOwnerId } from '../src/mcp-contracts.ts'
import { mcpCatalogDigest, mcpCatalogTools } from '../src/platform/mcp-catalog.ts'
import { McpCredentialCipher } from '../src/platform/mcp-credentials.ts'
import { createLegacyMigrationMcpContext, legacyMigrationMcpEvidence, legacyMigrationMcpKey,
  validateLegacyMigrationRemoteMcp } from '../src/platform/legacy-migration-v2-remote-mcp.ts'
import { McpActionStore } from '../src/platform/mcp-actions.ts'
import { mcpActionId, mcpActionReceipt, mcpPermissionId } from '../src/mcp-action-contracts.ts'
import { OfficePreviewService } from '../src/platform/office-previews.ts'
import { officePreviewJobView, officePreviewPrepareRequest, officePreviewCancelRequest } from '@power-evolve/contracts/office-preview'
import { validateLegacyMigrationOffice } from '../src/platform/legacy-migration-v2-office.ts'
import { SshConnectionService } from '../src/platform/ssh.ts'
import { SshCredentialCipher } from '../src/platform/ssh-credentials.ts'
import { sshConnectionValue, sshConnectionUpdateRequest, sshConnectionDeleteRequest,
  sshCredentialTicketRequest } from '../src/ssh-management-contracts.ts'
import { createLegacyMigrationSshContext, legacyMigrationSshKey, validateLegacyMigrationSsh,
  validateLegacyMigrationSshOperation, LEGACY_MIGRATION_SSH_TABLES } from '../src/platform/legacy-migration-v2-ssh.ts'
import { SshCallStore } from '../src/platform/ssh-calls.ts'
import { SshExecuteService, SshActionCipher } from '../src/platform/ssh-execute.ts'
import { SshRunnerOrchestrator } from '../src/platform/ssh-runner.ts'
import { validateLegacyMigrationSshAction } from '../src/platform/legacy-migration-v2-ssh-actions.ts'
import { StdioMcpService } from '../src/platform/stdio-mcp.ts'
import { createLegacyMigrationStdioContext, legacyMigrationStdioEvidence, validateLegacyMigrationStdio,
  validateLegacyMigrationStdioOperation } from '../src/platform/legacy-migration-v2-stdio.ts'
import { StdioConnectionServiceV2 } from '../src/platform/stdio-v2-connections.ts'
import { stdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioManagementLimitsV2, stdioManagementSchemasV2 } from '@power-evolve/contracts/stdio-management'
import { createLegacyMigrationStdioV2Context, legacyMigrationStdioV2Policy,
  validateLegacyMigrationStdioV2Metadata } from '../src/platform/legacy-migration-v2-stdio-management.ts'
import { ConnectorService } from '../src/platform/connectors.ts'
import { validateLegacyMigrationConnector } from '../src/platform/legacy-migration-v2-connectors.ts'
import { createLegacyMigrationBuiltinContext, legacyMigrationBuiltinEvidence,
  validateLegacyMigrationBuiltinSkill } from '../src/platform/legacy-migration-v2-builtin-skills.ts'
import { createLegacyMigrationStdioCallContext, legacyMigrationStdioCallEvidence, legacyMigrationStdioStartedCallEvidence,
  validateLegacyMigrationStdioCall } from '../src/platform/legacy-migration-v2-stdio-calls.ts'
import { createLegacyMigrationCloudCancellationContext, legacyMigrationCloudCancellationEvidence,
  validateLegacyMigrationCloudCancellation } from '../src/platform/legacy-migration-v2-cloud-cancel.ts'
import { createLegacyMigrationStdioNoStartContext, legacyMigrationStdioNoStartEvidence,
  validateLegacyMigrationStdioNoStart } from '../src/platform/legacy-migration-v2-stdio-no-start.ts'
import { StdioActionServiceV2 } from '../src/platform/stdio-v2-actions.ts'
import { StdioAdmissionServiceV2 } from '../src/platform/stdio-v2-admission.ts'
import { stdioCheckRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { ExecutionService } from '../src/platform/executions.ts'
import { SandboxManager } from '../src/platform/sandbox.ts'
import { KubernetesClient } from '../src/platform/kubernetes.ts'
import { legacyMigrationCloudResolutionEvidence } from '../src/platform/legacy-migration-v2-cloud-resolution.ts'
import { CloudExecutionResolutionService } from '../src/platform/cloud-execution-resolution.ts'
import { resolutionExecutionId, resolutionRequestId } from '@power-evolve/contracts/execution-resolution'

const budgets: LegacyImportLimits = { maxBundleBytes: 4_194_304, maxRows: 2000, maxCellBytes: 262144,
  maxJsonDepth: 40, maxJsonNodes: 40000, maxFiles: 100, maxFileBytes: 65536, maxStorageBytes: 262144 }
const repo = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const adminFile = process.env.PE_TEST_DATABASE_URL_FILE
if (!adminFile) throw new Error('Legacy migration v2 requires PE_TEST_DATABASE_URL_FILE')
const adminUrl = new URL((await readFile(adminFile, 'utf8')).trim())
const time = '2025-01-02T03:04:05.123456Z'
const password = 'employee5-owned-migration-password'
const salt = '12'.repeat(16)
const verifier = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
const taskLimits = { maxEventBytes: 262144, leaseMs: 60000, maxPendingPerUser: 8, maxActivePerUser: 1 }
const commandLimits = { ...taskLimits, maxHistoryBytes: 67108864, maxHistoryEvents: 10000,
  searchDeadlineMs: 5000, searchMaxSessions: 256, searchMaxEvents: 100000, searchMaxBytes: 67108864,
  titleMaxBytes: 4096, searchResultLimit: 20, searchSnippetChars: 240 }
const remoteMcpLimits = { maxConnections: 8, maxPendingTickets: 8, maxActiveChecks: 8, maxDrafts: 8,
  maxDraftsPerHour: 8, maxTools: 16, maxCatalogBytes: 65536, maxToolBytes: 8192, ticketLifetimeMs: 30000,
  checkLifetimeMs: 30000, draftLifetimeMs: 60000, retentionMs: 60000, checkLeaseMs: 15000,
  assertEndpoint: (url: string) => { if (url !== 'https://example.invalid/mcp') throw new Error('Owned endpoint mismatch') } }
const stdioV2Limits = stdioLimitsV2.parse({ runtimeMs: 5000, requestMs: 1000, stdinGraceMs: 100, terminateGraceMs: 100,
  killGraceMs: 1000, maxInputBytes: 65536, maxMessageBytes: 65536, maxProtocolBytes: 131072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 10000, maxPages: 10, maxTools: 16, maxCatalogBytes: 65536, maxToolBytes: 8192,
  maxResultBytes: 16384, maxStderrBytes: 8192 })
const stdioV2Management = stdioManagementLimitsV2.parse({ maxNameBytes: 200, pageItems: 8, maxConnections: 8 })
const stdioV2Schemas = stdioManagementSchemasV2(stdioV2Limits, stdioV2Management)
const ids = () => ({ user: randomUUID(), workspace: randomUUID(), session: randomUUID() })
async function* data(text: string): AsyncGenerator<Uint8Array> { yield Buffer.from(text) }
function cellRow(table: string, patch: Record<string, string | null>) {
  const layout = LEGACY_SOURCE_LAYOUT[table]
  if (!layout) throw new Error('Owned source fixture table missing')
  const cells: Record<string, string | null> = {}
  for (const [column, field] of Object.entries(layout)) {
    if (field.nullable) { cells[column] = null; continue }
    switch (field.kind) {
      case 'uuid': cells[column] = randomUUID(); break
      case 'text': cells[column] = ''; break
      case 'json': case 'jsonb': cells[column] = '{}'; break
      case 'integer': case 'bigint': cells[column] = '0'; break
      case 'boolean': cells[column] = 'false'; break
      case 'bytea': cells[column] = '\\x'; break
      case 'timestamptz': cells[column] = time; break
    }
  }
  return { ...cells, ...patch }
}
async function insert(pool: Pool, table: string, patch: Record<string, string | null>) {
  const row = cellRow(table, patch), layout = LEGACY_SOURCE_LAYOUT[table]
  if (!layout) throw new Error('Owned source fixture layout missing')
  const columns = Object.entries(layout).filter(([, field]) => !field.generated)
  await pool.query(`INSERT INTO "${table}"(${columns.map(([name]) => `"${name}"`).join(',')})
    VALUES(${columns.map(([, field], index) => `$${index + 1}::${field.kind}`).join(',')})`, columns.map(([name]) => row[name]))
}
async function privateJson(path: string, value: object) {
  await writeFile(path, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
}

async function seedHistorical(pool: Pool, person: ReturnType<typeof ids>, version: number) {
  const parent = randomUUID(), child = randomUUID()
  const rows = ['code', 'standard', 'code', 'minimal', 'code'].map((agentPreset, seq) => ({
    seq, time: seq + 1, type: 'agent-preset/selected', data: { agentPreset } }))
  const childEvents = version < 2 ? rows : [rows[0], rows[1], { seq: 2, time: 2, type: 'session/end-seed', data: { inherited: true } },
    ...rows.slice(2).map(row => ({ ...row, seq: row.seq + 1 }))]
  for (const item of [{ id: parent, body: rows, seeded: false }, { id: child, body: childEvents, seeded: true }]) {
    const header = { type: 'session', id: item.id, version, createdAt: 1, delegationDepth: 0, cwd: '/owned-old-cwd', agentPreset: 'code',
      ...(item.seeded ? { parentSession: parent } : {}),
      ...(version < 2 ? item.seeded ? { seedLength: 2 } : {} : { isSeeded: item.seeded }) }
    await insert(pool, 'pe_sessions', { id: item.id, user_id: person.user, workspace_id: person.workspace,
      create_request_id: randomUUID(), header: JSON.stringify(header), event_count: String(item.body.length),
      event_bytes: String(item.body.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)) })
    for (const [seq, event] of item.body.entries()) await insert(pool, 'pe_events', { session_id: item.id, seq: String(seq), event: JSON.stringify(event) })
  }
  return { parent, child }
}

async function seedAccountOwners(pool: Pool, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>) {
  const mutationRequestId = randomUUID(), settingsRequestId = randomUUID(), pluginRequestId = randomUUID()
  const input = accountUpdateRequest.parse({ userId: bob.user, requestId: mutationRequestId, expectedRevision: 5,
    displayName: 'Historical Bob', role: 'USER', enabled: true })
  const receipt = accountMutationReceipt.parse({ requestId: mutationRequestId, kind: 'update', completedAt: time,
    account: { userId: bob.user, username: 'migration-bob', displayName: 'Historical Bob', role: 'USER', enabled: true,
      revision: 6, passwordChangeRequired: false, deletedAt: null, createdAt: time, updatedAt: time } })
  await pool.query("UPDATE pe_users SET role='ADMIN' WHERE id=$1", [alice.user])
  await insert(pool, 'pe_account_bootstrap', { singleton: 'true', user_id: alice.user, username: 'migration-alice', mode: 'existing' })
  await insert(pool, 'pe_account_audit', { actor_user_id: alice.user, target_user_id: alice.user, request_id: randomUUID(), kind: 'bootstrap',
    metadata: '{"mode":"existing"}' })
  await insert(pool, 'pe_account_mutations', { actor_user_id: alice.user, target_user_id: bob.user, request_id: mutationRequestId,
    kind: 'update', request_digest: legacyDigest(JSON.stringify(['update', bob.user, 5, 'Historical Bob', 'USER', true])),
    password_verifier: null, receipt: JSON.stringify(receipt) })
  await insert(pool, 'pe_account_audit', { actor_user_id: alice.user, target_user_id: bob.user, request_id: mutationRequestId, kind: 'update',
    metadata: '{"revision":6,"enabled":true,"role":"USER"}' })
  await insert(pool, 'pe_settings_mutations', { user_id: alice.user, request_id: settingsRequestId,
    request_digest: legacyDigest(JSON.stringify([6, 'trial-model', 1000])), result_settings: '{"model":"trial-model","maxTokens":1000,"revision":7}' })
  await insert(pool, 'pe_user_plugins', { user_id: alice.user, plugin_id: 'notes', enabled: 'false', revision: '7' })
  await insert(pool, 'pe_plugin_mutations', { user_id: alice.user, plugin_id: 'notes', request_id: pluginRequestId,
    request_digest: legacyDigest(JSON.stringify({ pluginId: 'notes', expectedRevision: 6, enabled: false })), result_enabled: 'false', result_revision: '7' })
  return { input, receipt, settingsRequestId, pluginRequestId }
}

async function seedFixedMcp(pool: Pool, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>) {
  const connectionId = randomUUID(), request = randomUUID(), bobConnectionId = randomUUID()
  const result = { connectionId, name: 'Original preset', enabled: false, revision: 2,
    toolName: 'mcp__personal__whoami', description: '读取当前账户标识（只读）' }
  await insert(pool, 'pe_mcp_connections', { id: connectionId, user_id: alice.user, install_request_id: connectionId,
    name: result.name, enabled: 'false', revision: '2' })
  await insert(pool, 'pe_mcp_connections', { id: bobConnectionId, user_id: bob.user, install_request_id: bobConnectionId,
    name: 'Bob original preset', enabled: 'true', revision: '1' })
  await insert(pool, 'pe_mcp_updates', { user_id: alice.user, request_id: request, connection_id: connectionId,
    request_digest: legacyDigest(JSON.stringify({ connectionId, baseRevision: 1, enabled: false })), result: JSON.stringify(result) })
  return { connectionId, bobConnectionId, request, result }
}

async function seedNeverStartedMcp(pool: Pool, key: string, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>,
  aliceConnectionId: string, bobConnectionId: string) {
  const service = new McpConnectionService(pool, key, { ...remoteMcpLimits,
    checkLifetimeMs: 2, draftLifetimeMs: 4, checkLeaseMs: 1, retentionMs: 1 })
  const aliceOwner = identity.parse({ userId: alice.user, username: 'migration-alice' })
  const bobOwner = identity.parse({ userId: bob.user, username: 'migration-bob' })
  const prunedInput = mcpCheckRequest.parse({ requestId: randomUUID(), sessionId: bob.session,
    connectionId: bobConnectionId, baseRevision: 1 })
  const prunedCheck = await service.startCheck(bobOwner, prunedInput)
  const pruningDeadline = Date.now() + 5000
  while ((await pool.query<{ expired: boolean }>(`SELECT expires_at<clock_timestamp()-interval '1 millisecond'
    AS expired FROM pe_mcp_checks WHERE id=$1`, [prunedCheck.checkId])).rows[0]?.expired !== true) {
    if (Date.now() > pruningDeadline) throw new Error('Owned pruned MCP source expiration timed out')
    await new Promise<void>(done => setTimeout(done, 1))
  }
  const pruned = await service.pruneChecks(bobOwner)
  if (pruned.checks !== 1 || pruned.drafts !== 0) throw new Error('Owned original MCP public pruning failed')
  const draftInput = mcpDraftRequest.parse({ requestId: randomUUID(), sessionId: alice.session,
    sourceConnectionId: aliceConnectionId, baseRevision: 3, configuration: { displayName: 'Original expired retained draft',
      serverUrl: 'https://example.invalid/mcp', enabled: false, authentication: { kind: 'bearer', action: 'retain' } } })
  const draftCheck = await service.startDraftCheck(aliceOwner, draftInput)
  const savedInput = mcpCheckRequest.parse({ requestId: randomUUID(), sessionId: bob.session,
    connectionId: bobConnectionId, baseRevision: 1 })
  const savedCheck = await service.startCheck(bobOwner, savedInput)
  const cancelInput = mcpCheckRequest.parse({ requestId: randomUUID(), sessionId: alice.session,
    connectionId: aliceConnectionId, baseRevision: 3 })
  const cancelCheck = await service.startCheck(aliceOwner, cancelInput)
  const cancelled = await service.cancelCheck(aliceOwner, cancelCheck.checkId)
  const deadline = Date.now() + 5000
  while (true) {
    const active = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM (
      SELECT expires_at FROM pe_mcp_checks UNION ALL SELECT expires_at FROM pe_mcp_drafts
      ) expiry WHERE expires_at>clock_timestamp()`)).rows[0]!
    if (active.n === '0') break
    if (Date.now() > deadline) throw new Error('Owned never-started MCP source expiration timed out')
    await new Promise<void>(done => setTimeout(done, 1))
  }
  const originalWorker = mcpLeaseOwnerId.parse(randomUUID())
  const claim = await service.claimCheck(originalWorker)
  if (claim !== null) throw new Error('Owned MCP check unexpectedly obtained a worker epoch')
  return { draftInput, draftCheck, savedInput, savedCheck, cancelInput, cancelCheck, cancelled, originalWorker,
    prunedInput, prunedCheck,
    records: [{ purpose: 'check' as const, userId: bob.user, input: prunedInput, sizeBytes: 0 },
      { purpose: 'draft' as const, userId: alice.user, input: draftInput, sizeBytes: 0 },
      { purpose: 'check' as const, userId: bob.user, input: savedInput, sizeBytes: 0 },
      { purpose: 'check' as const, userId: alice.user, input: cancelInput, sizeBytes: 0 }] }
}
async function seedRemoteMcp(pool: Pool, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>, includeNoStart = false) {
  const key = randomBytes(32).toString('base64url'), keyId = `owned-original-mcp-${randomUUID()}`
  const service = new McpConnectionService(pool, key, remoteMcpLimits)
  const createInput = mcpCreateRequest.parse({ requestId: randomUUID(), configuration: { displayName: 'Original Alice remote',
    serverUrl: 'https://example.invalid/mcp', enabled: true, authentication: { kind: 'bearer', action: 'replace' } } })
  const body = JSON.stringify({ formatVersion: 1, bearerToken: 'original-Alice-credential' })
  const ticket = await service.issueTicket({ userId: identity.parse({ userId: alice.user, username: 'migration-alice' }).userId },
    { purpose: 'create', ...createInput, sizeBytes: Buffer.byteLength(body) }, 'http://127.0.0.1')
  const created = await service.upload(ticket.ticket, data(body))
  if (created.kind !== 'connection') throw new Error('Owned original remote connection missing')
  const updateInput = mcpUpdateRequest.parse({ requestId: randomUUID(), connectionId: created.item.connectionId, baseRevision: 1,
    configuration: { ...createInput.configuration, displayName: 'Later Alice remote',
      authentication: { kind: 'bearer', action: 'retain' } } })
  const updated = await service.update({ userId: identity.parse({ userId: alice.user, username: 'migration-alice' }).userId }, updateInput)
  const toggleInput = mcpToggleRequest.parse({ requestId: randomUUID(), connectionId: created.item.connectionId,
    baseRevision: 2, enabled: false })
  const disabled = await service.toggle({ userId: identity.parse({ userId: alice.user, username: 'migration-alice' }).userId }, toggleInput)
  const bobInput = mcpCreateRequest.parse({ requestId: randomUUID().toUpperCase(),
    configuration: { ...createInput.configuration, displayName: 'Bob original remote' } })
  const bobBody = JSON.stringify({ formatVersion: 1, bearerToken: 'original-Bob-credential' })
  const bobTicket = await service.issueTicket({ userId: identity.parse({ userId: bob.user, username: 'migration-bob' }).userId },
    { purpose: 'create', ...bobInput, sizeBytes: Buffer.byteLength(bobBody) }, 'http://127.0.0.1')
  const bobCreated = await service.upload(bobTicket.ticket, data(bobBody))
  if (bobCreated.kind !== 'connection') throw new Error('Owned original Bob remote connection missing')
  const pendingInput = mcpCreateRequest.parse({ ...createInput, requestId: randomUUID() })
  const pending = await service.issueTicket({ userId: identity.parse({ userId: alice.user, username: 'migration-alice' }).userId },
    { purpose: 'create', ...pendingInput, sizeBytes: Buffer.byteLength(body) }, 'http://127.0.0.1')
  await pool.query("UPDATE pe_mcp_credential_tickets SET expires_at=clock_timestamp()-interval '1 microsecond' WHERE request_id=$1",
    [pendingInput.requestId])
  const descriptor = { name: 'original_tool', description: 'Original\0description', inputSchema: { type: 'object', properties: {} },
    _meta: { originalNumber: 1, unknownExtension: { kept: ['original', null] } }, unknownVendorField: { untouched: true } }
  const catalogIds = []
  for (const [person, connection] of [[alice, updated], [bob, bobCreated.item]] as const) {
    const id = randomUUID(), tools = mcpCatalogTools(mcpResourceId.parse(connection.connectionId), [descriptor])
    await insert(pool, 'pe_mcp_catalog_versions', { id, user_id: person.user, connection_id: connection.connectionId,
      configuration_revision: String(connection.configurationRevision), credential_revision: String(connection.credentialRevision),
      catalog_digest: mcpCatalogDigest([descriptor]), tools: JSON.stringify(tools).replace('"originalNumber":1,', '"originalNumber":1e0,'),
      created_at: (await pool.query<{ cut: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cut`)).rows[0]!.cut })
    await pool.query('UPDATE pe_mcp_remote_connections SET current_catalog_id=$2 WHERE id=$1', [connection.connectionId, id])
    catalogIds.push(id)
  }
  const records: Array<{ purpose: z.infer<typeof legacyMigrationMcpEvidence>['requests'][number]['purpose']
    userId: string
    input: { requestId: string }
    sizeBytes: number }> = [
    { purpose: 'create' as const, userId: alice.user, input: createInput, sizeBytes: Buffer.byteLength(body) },
    { purpose: 'update' as const, userId: alice.user, input: updateInput, sizeBytes: 0 },
    { purpose: 'toggle' as const, userId: alice.user, input: toggleInput, sizeBytes: 0 },
    { purpose: 'create' as const, userId: bob.user, input: bobInput, sizeBytes: Buffer.byteLength(bobBody) },
    { purpose: 'create' as const, userId: alice.user, input: pendingInput, sizeBytes: Buffer.byteLength(body) }]
  const noStart = includeNoStart ? await seedNeverStartedMcp(pool, key, alice, bob,
    created.item.connectionId, bobCreated.item.connectionId) : undefined
  if (noStart) records.push(...noStart.records)
  return { key, keyId, created: created.item, updated, disabled, bobCreated: bobCreated.item, createInput, updateInput,
    toggleInput, bobInput, pendingInput, consumedTicket: ticket.ticket, pendingTicket: pending.ticket,
    records, descriptor, catalogIds, noStart }
}

async function seedOriginalMcpActions(root: string, sourceUrl: URL, bob: ReturnType<typeof ids>, key: string) {
  const script = join(root, 'original-mcp-action-owner.mjs'), parameter = join(root, 'original-mcp-action-params.json')
  const resultFile = join(root, 'original-mcp-action-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, key, password, sessionId: bob.session, resultFile,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo })
  await writeFile(script, `import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned original fixture database')
const originalFiles=['platform/tasks.ts','platform/mcp-actions.ts','platform/identity.ts','platform/account-authority.ts',
 'platform/mcp-credentials.ts','platform/mcp-admission.ts','contracts.ts','mcp-contracts.ts','mcp-model-tools.ts',
 'mcp-action-contracts.ts','mcp-operation-contracts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const result={};for(const file of originalFiles)result[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return result}
const before=await hashes()
const load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{TaskStore},{McpActionStore},{IdentityService},{requestId,sessionId}]=await Promise.all([
 load('platform/tasks.ts'),load('platform/mcp-actions.ts'),load('platform/identity.ts'),load('contracts.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:1}),identities=new IdentityService(pool,60000)
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1,
 remoteMcpAdmission:{maxTools:8,maxSnapshotBytes:65536,maxToolBytes:8192,maxDescriptionBytes:8192}})
const limits={maxArgumentBytes:8192,maxResultBytes:32768,maxCallsPerChain:8,maxPendingPerUser:8,
 chainLifetimeMs:60000,approvalLifetimeMs:60000,leaseMs:10000,listLimit:50}
const store=new McpActionStore(tasks,p.key,limits),records=[]
let agent,approval
try{
 agent=await identities.login('migration-bob',p.password)
 approval=await identities.login('migration-bob',p.password,'approval')
 for(const decision of ['reject','persistent','session']){
  await tasks.accept(agent.user,sessionId.parse(p.sessionId),requestId.parse(randomUUID()),'Original metadata-only '+decision,agent.token)
  const grant=await tasks.claim(randomUUID())
  if(!grant||grant.source!=='user'||grant.remoteMcpTools.length!==1)throw new Error('Original fixture admission missing')
  const callKey=randomUUID(),toolName=grant.remoteMcpTools[0].model.name,args={text:'Original\\u0000中文',sessionId:'ordinary argument data'}
  const proposed=await store.propose(grant.token,{callKey,toolName,arguments:args})
  await store.decide(approval.user,proposed.actionId,proposed.fingerprint,decision,approval.token)
  let permissionId=null
  if(decision!=='reject'){
   permissionId=(await pool.query('SELECT permission_id FROM pe_mcp_actions WHERE id=$1',[proposed.actionId])).rows[0].permission_id
   await store.revoke(approval.user,permissionId)
   await store.cancel(approval.user,proposed.actionId)
  }
  const terminal=await store.status(agent.user,proposed.actionId)
  await tasks.finish(grant.token,'failed','owned_metadata_fixture_no_host')
  const continuation=await tasks.claim(randomUUID())
  if(!continuation||continuation.source!=='remote_mcp_result'||continuation.sourceMcpActionId!==proposed.actionId)throw new Error('Original continuation missing')
  await tasks.finish(continuation.token,'failed','owned_metadata_fixture_no_host')
  records.push({decision,permissionId,proposed,terminal,callKey,toolName,arguments:args,
   rootOperationId:grant.operationId,continuationOperationId:continuation.operationId})
 }
 const actions=(await pool.query('SELECT lease_epoch,dispatch_id,lease_owner,lease_until FROM pe_mcp_actions')).rows
 if(actions.some(row=>row.lease_epoch!==0||row.dispatch_id!==null||row.lease_owner!==null||row.lease_until!==null))throw new Error('Original action unexpectedly started')
 const after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original named owner source drifted')
 await writeFile(p.resultFile,JSON.stringify({records,limits,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceInputs:before,sourceInputsAfter:after,sourceScope:'Named original owner source modules; complete build/dependency qualification remains open',
  metadataOnlyFixture:true,hostStarted:false,mcpWorkerClaimed:false,networkDispatchStarted:false,physicalStopReceipt:null})+'\\n',{mode:0o600,flag:'wx'})
}finally{
 if(approval)await identities.logout(approval.token)
 if(agent)await identities.logout(agent.token)
 await pool.end()
}

`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 40000)
  let output = ''
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { done({ code: null, error: error.message }) })
      child.once('close', (code) => { done({ code }) })
    })
    await privateJson(join(root, 'original-mcp-action-process.json'), result)
    await writeFile(join(root, 'original-mcp-action-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0) throw new Error('Original MCP metadata fixture owner failed')
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-action-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-mcp-action-owner.mjs', 'original-mcp-action-process.json',
        'original-mcp-action-owner.log', 'original-mcp-action-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  return z.object({ records: z.array(z.object({ decision: z.enum(['reject', 'persistent', 'session']),
    permissionId: z.uuid().nullable(), proposed: mcpActionReceipt, terminal: mcpActionReceipt.extend({ result: z.json() }),
    callKey: z.string(), toolName: z.string(), arguments: z.record(z.string(), z.json()),
    rootOperationId: z.uuid(), continuationOperationId: z.uuid() })), sourceCodeSha256: z.string(),
  metadataOnlyFixture: z.literal(true), hostStarted: z.literal(false), mcpWorkerClaimed: z.literal(false),
  networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalSshManagement(root: string, sourceUrl: URL, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>,
  includeActions = false) {
  const key = randomBytes(32).toString('base64url'), keyId = `owned-original-ssh-${randomUUID()}`
  const script = join(root, 'original-ssh-management-owner.mjs'), parameter = join(root, 'original-ssh-management-params.json')
  const resultFile = join(root, 'original-ssh-management-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, key, alice: alice.user, bob: bob.user,
    aliceSession: alice.session, bobSession: bob.session, password, resultFile, includeActions,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned original SSH fixture database')
const originalFiles=['platform/ssh.ts','platform/ssh-credentials.ts','platform/account-authority.ts',
 'platform/database.ts','platform/tasks.ts','platform/identity.ts','contracts.ts','ssh-management-contracts.ts']
if(p.includeActions)originalFiles.push('platform/ssh-execute.ts','platform/ssh-calls.ts','platform/ssh-runner.ts','platform/ssh-command.ts')
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const result={};for(const file of originalFiles)
 result[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return result}
const before=await hashes()
const load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{SshConnectionService},{identity,sshCreateTicketRequest,sessionId,requestId},contracts,{TaskStore},{IdentityService}]
 =await Promise.all([load('platform/ssh.ts'),load('contracts.ts'),load('ssh-management-contracts.ts'),
 load('platform/tasks.ts'),load('platform/identity.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:1})
const service=new SshConnectionService(pool,p.key,'legacy.example:22,private.example:2222',{ticketLifetimeMs:10000})
const identities=new IdentityService(pool,60000),tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,
 maxPendingPerUser:8,maxActivePerUser:1,sshEnabled:true}),operations=[]
let aliceLogin,bobLogin,approvalLogin,execute
const actions=[]
const alice=identity.parse({userId:p.alice,username:'migration-alice'}),bob=identity.parse({userId:p.bob,username:'migration-bob'})
async function* bytes(text){yield Buffer.from(text,'utf8')}
async function accepted(login,session){const req=randomUUID(),text='Original SSH metadata-only acceptance'
 const accepted=await tasks.accept(login.user,sessionId.parse(session),requestId.parse(req),text,login.token)
 const grant=await tasks.claim(randomUUID())
 if(!grant||grant.operationId!==accepted.operationId||grant.sshConnections.length!==1)
  throw new Error('Original SSH fixture accepted selection missing')
 await tasks.finish(grant.token,'failed','owned_metadata_fixture_no_host')
 operations.push({operationId:grant.operationId,requestId:req,userId:login.user.userId,sessionId:session,
  input:text,selection:grant.sshConnections})}
const legacyPassword='{"formatVersion":2,"password":"JSON-shaped raw original password"}'
try{
 aliceLogin=await identities.login('migration-alice',p.password)
 bobLogin=await identities.login('migration-bob',p.password)
 const legacyInput=sshCreateTicketRequest.parse({requestId:randomUUID(),displayName:'Original legacy password',
  host:'legacy.example',port:22,username:'original-user',hostKeySha256:'SHA256:'+'A'.repeat(43),
  credentialKind:'password',sizeBytes:Buffer.byteLength(legacyPassword),enabled:true})
 const legacyTicket=await service.issueTicket(alice,legacyInput,'http://127.0.0.1')
 const legacyCreated=(await service.upload(legacyTicket.ticket,bytes(legacyPassword))).item
 await accepted(aliceLogin,p.aliceSession)
 const toggleRequestId=randomUUID()
 const toggled=await service.toggle(alice,legacyCreated.connectionId,toggleRequestId,1,false)
 const oldInput={connectionId:legacyCreated.connectionId,baseRevision:1,enabled:false}
 const oldRequest=(await pool.query('SELECT completed_at::text AS completed_at FROM pe_ssh_management_requests WHERE request_id=$1',
  [toggleRequestId])).rows[0]
 await pool.query('INSERT INTO pe_ssh_updates(user_id,request_id,connection_id,request_digest,result,created_at)'
  +' VALUES($1,$2,$3,$4,$5,$6)',[alice.userId,toggleRequestId,legacyCreated.connectionId,
  hash(JSON.stringify(oldInput)),toggled,oldRequest.completed_at])
 const retainedInput=contracts.sshConnectionUpdateRequest.parse({requestId:randomUUID(),connectionId:legacyCreated.connectionId,
  baseRevision:2,configuration:{displayName:'Retained original raw password',host:'legacy.example',port:22,
  username:'original-user',hostKeySha256:'SHA256:'+'A'.repeat(43),workingDirectory:'/original/remote/path',
  authentication:{kind:'password',password:'retain'},enabled:false}})
 const retained=await service.update(alice,retainedInput)
 const deleteInput=contracts.sshConnectionDeleteRequest.parse({requestId:randomUUID(),connectionId:legacyCreated.connectionId,
  baseRevision:3})
 const deleted=await service.remove(alice,deleteInput)
 const privateInput=contracts.sshCredentialTicketRequest.parse({purpose:'create',requestId:randomUUID(),
  configuration:{displayName:'Original private key',host:'private.example',port:2222,username:'private-user',
  hostKeySha256:'SHA256:'+'B'.repeat(43),workingDirectory:'/original/private/path',
  authentication:{kind:'private_key',privateKey:'replace',passphrase:'replace'},enabled:true},
  sizeBytes:Buffer.byteLength(JSON.stringify({formatVersion:2,privateKey:'original-private-key',passphrase:'original-passphrase'}))})
 const privateBody=JSON.stringify({formatVersion:2,privateKey:'original-private-key',passphrase:'original-passphrase'})
 const privateTicket=await service.issueManagedTicket(bob,privateInput,'http://127.0.0.1')
 const privateCreated=(await service.upload(privateTicket.ticket,bytes(privateBody))).item
 await accepted(bobLogin,p.bobSession)
 const replaceBody=JSON.stringify({formatVersion:2,passphrase:'later-original-passphrase'})
 const replaceInput=contracts.sshCredentialTicketRequest.parse({purpose:'update',requestId:randomUUID(),
  connectionId:privateCreated.connectionId,baseRevision:1,sizeBytes:Buffer.byteLength(replaceBody),
  configuration:{...privateInput.configuration,displayName:'Retained key and replaced passphrase',
   authentication:{kind:'private_key',privateKey:'retain',passphrase:'replace'}}})
 const replaceTicket=await service.issueManagedTicket(bob,replaceInput,'http://127.0.0.1')
 const replaced=(await service.upload(replaceTicket.ticket,bytes(replaceBody))).item
 const clearInput=contracts.sshConnectionUpdateRequest.parse({requestId:randomUUID(),connectionId:privateCreated.connectionId,
  baseRevision:2,configuration:{...replaceInput.configuration,displayName:'Original passphrase cleared',
   authentication:{kind:'private_key',privateKey:'retain',passphrase:'clear'}}})
 const cleared=await service.update(bob,clearInput)
 const bobLegacyInput=sshCreateTicketRequest.parse({...legacyInput,requestId:randomUUID(),displayName:'Bob original raw password'})
 const bobLegacyTicket=await service.issueTicket(bob,bobLegacyInput,'http://127.0.0.1')
 const bobLegacyCreated=(await service.upload(bobLegacyTicket.ticket,bytes(legacyPassword))).item
 if(p.includeActions){
  const [{SshExecuteService},{SshCallStore},{SshRunnerOrchestrator}]=await Promise.all([
   load('platform/ssh-execute.ts'),load('platform/ssh-calls.ts'),load('platform/ssh-runner.ts')])
  const unused=()=>{throw new Error('Never-started original SSH fixture attempted Runner/Kubernetes/DNS access')}
  const runner=new SshRunnerOrchestrator({call:unused,resourcePath:unused,proxyPath:unused},
   {namespace:'owned-offline-ssh',image:'registry.example/owned-ssh@sha256:'+'a'.repeat(64),
    runtimeClassName:'owned-offline-runtime',controlKey:p.key,readyTimeoutMs:1000,
    platformIngressCidrs:['127.0.0.1/32'],forbiddenProbe:{ip:'198.51.100.1',port:8080},proveForbiddenListener:unused})
  execute=new SshExecuteService(tasks,new SshCallStore(pool),service,runner,p.key,randomUUID(),60000,500,unused)
  approvalLogin=await identities.login('migration-bob',p.password,'approval')
  for(const decision of ['reject','cancel-pending','approve-cancel','revoked']){
   const req=randomUUID(),text='Original no-start SSH action '+decision
   await tasks.accept(bobLogin.user,sessionId.parse(p.bobSession),requestId.parse(req),text,bobLogin.token)
   const grant=await tasks.claim(randomUUID())
   if(!grant||grant.source!=='user')throw new Error('Original no-start SSH action grant missing')
   const callKey=randomUUID(),command="printf '%s' 'original command 中文'"
   const proposed=await execute.propose(grant.token,callKey,privateCreated.connectionId,3,3,command)
   const reviewed=(await execute.approvals(approvalLogin.user)).items.find(item=>item.actionId===proposed.actionId)
   if(!reviewed)throw new Error('Original SSH approval command missing')
   if(decision==='reject')await execute.decide(approvalLogin.user,proposed.actionId,proposed.fingerprint,false,approvalLogin.token)
   else if(decision==='cancel-pending')await execute.cancel(approvalLogin.user,proposed.actionId,
    {token:approvalLogin.token,audience:'approval'})
   else{
    if(decision==='revoked')await service.toggleManaged(bob,contracts.sshConnectionToggleRequest.parse({requestId:randomUUID(),
     connectionId:privateCreated.connectionId,baseRevision:3,enabled:false}))
    await execute.decide(approvalLogin.user,proposed.actionId,proposed.fingerprint,true,approvalLogin.token)
    if(decision==='approve-cancel')await execute.cancel(approvalLogin.user,proposed.actionId,
     {token:approvalLogin.token,audience:'approval'})}
   const terminal=await execute.status(bobLogin.user,proposed.actionId)
   await tasks.finish(grant.token,'failed','owned_metadata_fixture_no_host')
   const continuation=await tasks.claim(randomUUID())
   if(!continuation||continuation.source!=='ssh_execute_result'||continuation.sourceSshExecuteActionId!==proposed.actionId)
    throw new Error('Original SSH action continuation missing')
   await tasks.finish(continuation.token,'failed','owned_metadata_fixture_no_host')
   actions.push({decision,proposed,terminal,callKey,command,reviewedCommand:reviewed.command,
    operationId:grant.operationId,continuationOperationId:continuation.operationId})}
  const calls=(await pool.query('SELECT lease_epoch,pod_uid,dispatch_digest FROM pe_ssh_calls')).rows
  if(calls.length!==1||calls.some(item=>item.lease_epoch!==0||item.pod_uid!==null||item.dispatch_digest!==null))
   throw new Error('Original no-start SSH call unexpectedly obtained a worker')}
 const pendingService=new SshConnectionService(pool,p.key,'private.example:2222',{ticketLifetimeMs:1})
 const pendingInput=contracts.sshCredentialTicketRequest.parse({...privateInput,requestId:randomUUID()})
 const pending=await pendingService.issueManagedTicket(alice,pendingInput,'http://127.0.0.1')
 const deadline=Date.now()+15000
 while(true){const active=(await pool.query('SELECT count(*) AS n FROM pe_ssh_upload_intents'
  +' WHERE expires_at>clock_timestamp() OR expires_at>$1',[new Date()])).rows[0]
  if(active.n==='0')break
  if(Date.now()>deadline)throw new Error('Owned original SSH ticket expiry timed out')
  await new Promise(done=>setTimeout(done,10))}
 const after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original named SSH owner source drifted')
 await writeFile(p.resultFile,JSON.stringify({legacyInput,legacyCreated,toggleRequestId,toggled,retainedInput,retained,
  deleteInput,deleted,privateInput,privateCreated,replaceInput,replaced,clearInput,cleared,bobLegacyInput,bobLegacyCreated,
  consumedTicket:legacyTicket.ticket,privateConsumedTicket:privateTicket.ticket,pendingTicket:pending.ticket,
  pendingInput,operations,actions,sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:originalFiles.length+' named original SSH owner source modules; complete source/build/dependency qualification remains open',
  pairedLegacyUpdateFixture:true,pairedLegacyUpdateSource:'Explicit historical metadata fixture using original public toggle result',
  sshWorkerStarted:false,networkDispatchStarted:false,physicalStopReceipt:null})+'\n',{mode:0o600,flag:'wx'})
}finally{
 if(execute)await execute.close()
 if(approvalLogin)await identities.logout(approvalLogin.token)
 if(aliceLogin)await identities.logout(aliceLogin.token)
 if(bobLogin)await identities.logout(bobLogin.token)
 await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 40000)
  let output = ''
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { done({ code: null, error: error.message }) })
      child.once('close', (code) => { done({ code }) })
    })
    await privateJson(join(root, 'original-ssh-management-process.json'), result)
    await writeFile(join(root, 'original-ssh-management-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0) throw new Error('Original SSH management fixture owner failed')
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-ssh-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-ssh-management-owner.mjs', 'original-ssh-management-process.json',
        'original-ssh-management-owner.log', 'original-ssh-management-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  const legacyResult = sshConnectionValue.pick({ connectionId: true, displayName: true, host: true, port: true, username: true,
    hostKeySha256: true, enabled: true, revision: true, credentialRevision: true })
  const result = z.object({ legacyInput: sshCreateTicketRequest, legacyCreated: legacyResult, toggleRequestId: requestId,
    toggled: legacyResult, retainedInput: sshConnectionUpdateRequest, retained: sshConnectionValue,
    deleteInput: sshConnectionDeleteRequest, deleted: sshConnectionValue, privateInput: sshCredentialTicketRequest,
    privateCreated: sshConnectionValue, replaceInput: sshCredentialTicketRequest, replaced: sshConnectionValue,
    clearInput: sshConnectionUpdateRequest, cleared: sshConnectionValue, bobLegacyInput: sshCreateTicketRequest,
    bobLegacyCreated: legacyResult, consumedTicket: z.string(), privateConsumedTicket: z.string(), pendingTicket: z.string(),
    pendingInput: sshCredentialTicketRequest, sourceCodeSha256: z.string(), pairedLegacyUpdateFixture: z.literal(true),
    operations: z.array(z.object({ operationId: z.uuid(), requestId: requestId, userId: z.uuid(), sessionId: z.uuid(),
      input: z.string(), selection: z.array(z.json()) })),
    actions: z.array(z.object({ decision: z.enum(['reject', 'cancel-pending', 'approve-cancel', 'revoked']),
      proposed: sshExecuteView, terminal: sshExecuteView, callKey: z.string(), command: z.string(), reviewedCommand: z.string(),
      operationId: z.uuid(), continuationOperationId: z.uuid() })),
    sshWorkerStarted: z.literal(false), networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
  return { ...result, key, keyId }
}

async function seedOriginalStdioMetadata(root: string, sourceUrl: URL, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>) {
  const script = join(root, 'original-stdio-metadata-owner.mjs'), parameter = join(root, 'original-stdio-metadata-params.json')
  const resultFile = join(root, 'original-stdio-metadata-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, alice: alice.user, bob: bob.user,
    aliceSession: alice.session, bobSession: bob.session, password, resultFile,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned original STDIO fixture database')
const originalFiles=['platform/stdio-mcp.ts','platform/stdio-runner.ts','platform/ssh-runner.ts',
 'platform/account-authority.ts','platform/database.ts','platform/tasks.ts','platform/identity.ts','contracts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const result={};for(const file of originalFiles)
 result[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return result}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{StdioMcpService},{StdioRunnerOrchestrator},{TaskStore},{IdentityService},{identity,sessionId,requestId}]
 =await Promise.all([load('platform/stdio-mcp.ts'),load('platform/stdio-runner.ts'),load('platform/tasks.ts'),
 load('platform/identity.ts'),load('contracts.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:1}),unused=()=>{throw new Error('Original STDIO metadata attempted Runner/Kubernetes access')}
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1,stdioMcpEnabled:true})
const runner=new StdioRunnerOrchestrator({call:unused,resourcePath:unused,proxyPath:unused},
 {namespace:'owned-offline-stdio',image:'registry.example/owned-stdio@sha256:'+'a'.repeat(64),
  runtimeClassName:'owned-offline-runtime',controlKey:'A'.repeat(43),readyTimeoutMs:1000,
  platformIngressCidrs:['127.0.0.1/32'],forbiddenProbe:{ip:'198.51.100.1',port:8080},proveForbiddenListener:unused})
const service=new StdioMcpService(tasks,runner,randomUUID(),60000),identities=new IdentityService(pool,60000)
const alice=identity.parse({userId:p.alice,username:'migration-alice'}),bob=identity.parse({userId:p.bob,username:'migration-bob'})
const records=[],operations=[]
let aliceLogin,bobLogin
async function accepted(login,session){const req=randomUUID(),text='Original STDIO metadata-only acceptance'
 const accepted=await tasks.accept(login.user,sessionId.parse(session),requestId.parse(req),text,login.token)
 const grant=await tasks.claim(randomUUID())
 if(!grant||grant.operationId!==accepted.operationId||grant.stdioMcpConnections.length!==1)
  throw new Error('Original STDIO accepted selection missing')
 await tasks.finish(grant.token,'failed','owned_metadata_fixture_no_host')
 operations.push({operationId:grant.operationId,requestId:req,userId:login.user.userId,sessionId:session,
  input:text,selection:grant.stdioMcpConnections})}
async function toggle(user,input){const req=randomUUID().toUpperCase()
 const result=await service.toggle(user,input.id,req,input.baseRevision,input.enabled)
 records.push({userId:user.userId,requestId:req,input,result});return result}
try{
 aliceLogin=await identities.login('migration-alice',p.password)
 bobLogin=await identities.login('migration-bob',p.password)
 const aliceInstall={requestId:randomUUID(),name:'Original STDIO 中文'},bobInstall={requestId:randomUUID(),name:'Bob original STDIO'}
 const aliceCreated=await service.install(alice,aliceInstall.requestId,aliceInstall.name)
 const bobCreated=await service.install(bob,bobInstall.requestId,bobInstall.name)
 await accepted(aliceLogin,p.aliceSession)
 const disabled=await toggle(alice,{id:aliceCreated.connectionId.toUpperCase(),baseRevision:1,enabled:false})
 const enabled=await toggle(alice,{id:aliceCreated.connectionId,baseRevision:2,enabled:true})
 await accepted(aliceLogin,p.aliceSession)
 const current=await toggle(alice,{id:aliceCreated.connectionId.toUpperCase(),baseRevision:3,enabled:false})
 await accepted(bobLogin,p.bobSession)
 const after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original named STDIO owner source drifted')
 await writeFile(p.resultFile,JSON.stringify({aliceInstall,bobInstall,aliceCreated,bobCreated,disabled,enabled,current,
  records,operations,sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:'Eight named original STDIO metadata owner modules; complete source/build/dependency qualification remains open',
  hostStarted:false,stdioWorkerStarted:false,networkDispatchStarted:false,physicalStopReceipt:null})+'\n',{mode:0o600,flag:'wx'})
}finally{
 await service.close()
 if(aliceLogin)await identities.logout(aliceLogin.token)
 if(bobLogin)await identities.logout(bobLogin.token)
 await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 30000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code) => { done({ code, ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-stdio-metadata-process.json'), result)
    await writeFile(join(root, 'original-stdio-metadata-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0) throw new Error('Original STDIO metadata fixture owner failed')
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-stdio-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-stdio-metadata-owner.mjs', 'original-stdio-metadata-process.json',
        'original-stdio-metadata-owner.log', 'original-stdio-metadata-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  const item = z.object({ connectionId: z.uuid(), name: z.string(), enabled: z.boolean(), revision: z.number().int(),
    toolName: z.literal('mcp__stdio__whoami'), description: z.literal('在隔离进程中读取当前账户标识（只读）') }).strict()
  return z.object({ aliceInstall: z.object({ requestId: z.uuid(), name: z.string() }),
    bobInstall: z.object({ requestId: z.uuid(), name: z.string() }), aliceCreated: item, bobCreated: item,
    disabled: item, enabled: item, current: item, sourceCodeSha256: z.string(),
    records: z.array(z.object({ userId: z.uuid(), requestId: z.uuid(),
      input: legacyMigrationStdioEvidence.shape.requests.element.shape.input,
      result: item })), operations: z.array(z.object({ operationId: z.uuid(), requestId: z.uuid(), userId: z.uuid(),
      sessionId: z.uuid(), input: z.string(), selection: z.array(z.json()) })),
    hostStarted: z.literal(false), stdioWorkerStarted: z.literal(false), networkDispatchStarted: z.literal(false),
    physicalStopReceipt: z.null() }).catchall(z.json()).parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalStdioNoStartCall(root: string, sourceUrl: URL, bob: ReturnType<typeof ids>,
  metadata: Awaited<ReturnType<typeof seedOriginalStdioMetadata>>) {
  const script = join(root, 'original-stdio-call-owner.mjs'), parameter = join(root, 'original-stdio-call-params.json')
  const resultFile = join(root, 'original-stdio-call-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, password, resultFile, root, sessionId: bob.session,
    connectionId: metadata.bobCreated.connectionId, revision: metadata.bobCreated.revision,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo,
    kubeconfig: '/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/k3s-migration-kubeconfig.yaml' })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned STDIO call fixture database')
const files=['platform/stdio-mcp.ts','platform/stdio-runner.ts','platform/ssh-runner.ts','platform/kubernetes.ts',
 'platform/account-authority.ts','platform/database.ts','platform/tasks.ts','platform/identity.ts','contracts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const value={};for(const file of files)
 value[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return value}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{StdioMcpService},{StdioRunnerOrchestrator},{KubernetesClient,KubernetesError},{TaskStore},{IdentityService},contracts]
 =await Promise.all([load('platform/stdio-mcp.ts'),load('platform/stdio-runner.ts'),load('platform/kubernetes.ts'),
 load('platform/tasks.ts'),load('platform/identity.ts'),load('contracts.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:2}),kube=await KubernetesClient.fromFile(p.kubeconfig)
const namespace='pe-e5-stdio-'+randomUUID().replaceAll('-',''),observations=[]
let namespaceUid,creationRequests=0,liveProbeInvocations=0,login,result,service
const pattern=new RegExp('/namespaces/'+namespace+'/(pods|services|secrets|networkpolicies)/([^/]+)$')
const audited={resourcePath:(...args)=>kube.resourcePath(...args),proxyPath:(...args)=>kube.proxyPath(...args),
 async call(method,path,...args){
  if(!path.includes('/namespaces/'+namespace+'/'))throw new Error('Original STDIO attempted unowned namespace')
  if(method==='POST'||method==='PATCH')creationRequests++
  const match=pattern.exec(path)
  try{return await kube.call(method,path,...args)}catch(error){
   if(error instanceof KubernetesError&&error.status===404&&match){
    const time=(await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS cut")).rows[0].cut
    observations.push({method,kind:match[1],namespace,name:decodeURIComponent(match[2]),status:404,observedAt:time})
   }
   throw error
  }
 }}
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1,stdioMcpEnabled:true})
const identities=new IdentityService(pool,60000)
try{
 const ns=await kube.call('POST','/api/v1/namespaces',{apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,
  labels:{'powerevolve.dev/employee5-fixture':'stdio-no-start'}}},undefined,undefined)
 namespaceUid=ns.metadata.uid
 if(!namespaceUid)throw new Error('Owned namespace UID missing')
 const runner=new StdioRunnerOrchestrator(audited,{namespace,image:'registry.example/owned-stdio@sha256:'+'a'.repeat(64),
  runtimeClassName:'owned-unused-runtime',controlKey:'A'.repeat(43),readyTimeoutMs:1000,
  platformIngressCidrs:['127.0.0.1/32'],forbiddenProbe:{ip:'198.51.100.1',port:8080},
  proveForbiddenListener:async()=>{liveProbeInvocations++;return false}})
 service=new StdioMcpService(tasks,runner,randomUUID(),60000,100)
 login=await identities.login('migration-bob',p.password)
 const originalRequest=randomUUID(),input='Original STDIO live-probe refusal with actual resource absence'
 const accepted=await tasks.accept(login.user,contracts.sessionId.parse(p.sessionId),contracts.requestId.parse(originalRequest),input,login.token)
 const grant=await tasks.claim(randomUUID())
 if(!grant||grant.operationId!==accepted.operationId)throw new Error('Original STDIO call grant missing')
 const callKey='original-stdio-'+randomUUID(),acceptedCall=await service.call(grant.token,p.connectionId,p.revision,callKey)
 service.start()
 const until=Date.now()+20000
 let row
 while(Date.now()<until){
  row=(await pool.query('SELECT * FROM pe_stdio_mcp_calls WHERE id=$1',[acceptedCall.callId])).rows[0]
  if(row?.state==='failed'&&row.cleanup_complete)break
  await delay(50)
 }
 if(row?.state!=='failed'||!row.cleanup_complete||row.error_code!=='stdio_mcp_runner_unavailable'
  ||row.pod_uid!==null||row.dispatch_digest!==null||creationRequests||liveProbeInvocations!==1)
  throw new Error('Original STDIO refused preparation or actual cleanup incomplete')
 await tasks.finish(grant.token,'failed','owned_fixture_no_host')
 const continuation=await tasks.claim(randomUUID())
 if(!continuation||continuation.source!=='stdio_mcp_result'||continuation.sourceStdioMcpCallId!==row.id)
  throw new Error('Original STDIO call continuation missing')
 await tasks.finish(continuation.token,'failed','owned_fixture_no_host')
 await service.close()
 const terminal=await service.status(login.user,row.id),after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original STDIO call named source drifted')
 result={userId:login.user.userId,callId:row.id,namespace,namespaceUid,observations,liveProbeInvocations,
  liveProbeAccepted:false,creationRequests,originalRequest,input,operationId:grant.operationId,
  continuationOperationId:continuation.operationId,callKey,acceptedCall,terminal,
  sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:'Nine named original STDIO owner modules and actual dedicated Kubernetes namespace; full source/build remain open',
  stdioWorkerStarted:true,hostStarted:false,runnerPodCreated:false,networkDispatchStarted:false,physicalStopReceipt:null}
}finally{
 try{
  if(service)await service.close();if(login)await identities.logout(login.token)
  if(namespaceUid){
   await kube.call('DELETE','/api/v1/namespaces/'+namespace,{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:namespaceUid}},5000)
   let deleted=false;const until=Date.now()+15000
   while(Date.now()<until){try{await kube.call('GET','/api/v1/namespaces/'+namespace,undefined,5000)}
    catch(error){if(error instanceof KubernetesError&&error.status===404){deleted=true;break}throw error}await delay(100)}
   await writeFile(p.root+'/original-stdio-call-namespace-cleanup.json',JSON.stringify({namespace,namespaceUid,deleted})+'\n',{flag:'wx',mode:0o600})
   if(!deleted)throw new Error('Owned STDIO namespace cleanup unresolved')
   if(result)await writeFile(p.resultFile,JSON.stringify({...result,namespaceDeleted:deleted})+'\n',{flag:'wx',mode:0o600})
  }
 }finally{await pool.end()}
}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 60000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: controller.signal.aborted,
        ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-stdio-call-process.json'), result)
    await writeFile(join(root, 'original-stdio-call-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.error !== undefined) {
      throw new Error('Original STDIO call owner failed')
    }
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-stdio-call-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-stdio-call-owner.mjs', 'original-stdio-call-process.json',
        'original-stdio-call-owner.log', 'original-stdio-call-results.json', 'original-stdio-call-namespace-cleanup.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  return z.object({ userId: z.uuid(), callId: z.uuid(), namespace: z.string(), namespaceUid: z.uuid(),
    liveProbeInvocations: z.literal(1), liveProbeAccepted: z.literal(false), creationRequests: z.literal(0),
    observations: legacyMigrationStdioCallEvidence.shape.requests.element.shape.observations,
    originalRequest: z.uuid(), input: z.string(), operationId: z.uuid(), continuationOperationId: z.uuid(), callKey: z.string(),
    acceptedCall: z.object({ callId: z.uuid(), state: z.literal('accepted') }).strict(),
    terminal: z.object({ callId: z.uuid(), state: z.literal('failed'), errorCode: z.literal('stdio_mcp_runner_unavailable') }).strict(),
    sourceCodeSha256: z.string(), stdioWorkerStarted: z.literal(true), hostStarted: z.literal(false), runnerPodCreated: z.literal(false),
    networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null(), namespaceDeleted: z.literal(true) }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalPristineMount(root: string, sourceUrl: URL, alice: ReturnType<typeof ids>, bob: ReturnType<typeof ids>,
  files: LegacyFileEntry[]) {
  const old = '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud'
  const script = join(root, 'original-pristine-mount-owner.mjs'), parameter = join(root, 'original-pristine-mount-parameters.json')
  const resultFile = join(root, 'original-pristine-mount-results.json')
  await privateJson(parameter, { old, root, sourceUrl: sourceUrl.href, alice, bob, password, resultFile, requestId: randomUUID() })
  await writeFile(script, `import {readFile,writeFile,lstat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
const {Pool}=createRequire('${repo}/products/power-evolve/application/package.json')('pg')
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
const named=['products/power-evolve/application/src/platform/files.ts',
 'products/power-evolve/application/src/platform/safe-posix.ts','products/power-evolve/application/src/platform/safe-posix.py',
 'products/power-evolve/application/src/platform/storage-bindings.ts','products/power-evolve/application/src/platform/workspace-binding-types.ts',
 'products/power-evolve/application/src/platform/database.ts','products/power-evolve/application/src/platform/identity.ts',
 'products/power-evolve/application/src/platform/account-authority.ts','products/power-evolve/application/src/contracts.ts',
 'products/power-evolve/application/src/account-contracts.ts','products/power-evolve/contracts/src/file-download.ts','tsconfig.base.json']
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const hashes=async()=>Object.fromEntries(await Promise.all(named.map(async file=>[file,sha(await readFile(p.old+'/'+file))])))
const before=await hashes(), pool=new Pool({connectionString:p.sourceUrl,max:1})
const [{FileService},{IdentityService}]=await Promise.all([
 import(p.old+'/products/power-evolve/application/src/platform/files.ts'),
 import(p.old+'/products/power-evolve/application/src/platform/identity.ts')])
const identities=new IdentityService(pool,60000), files=new FileService(pool,p.root+'/pristine-source-workspaces')
let bob,alice
try{
 // Restore the Schema37 default free row explicitly; this fixture does not claim that SandboxManager issued it.
 await pool.query("INSERT INTO pe_mount_slots(user_id) VALUES($1)",[p.bob.user])
 await files.init();await files.safe.ensureWorkspace(p.bob.workspace)
 bob=await identities.login('migration-bob',p.password);alice=await identities.login('migration-alice',p.password)
 const bytes=Buffer.from('原始空闲挂载槽文件\\n'), path='pristine-slot.txt'
 const put=await files.put(bob.user,p.requestId,path,null,bytes.toString('base64'),p.bob.workspace)
 const read=await files.read(bob.user,path,p.bob.workspace)
 let foreignDenied=false
 try{await files.put(alice.user,p.requestId,path,null,bytes.toString('base64'),p.bob.workspace)}
 catch(error){if(error.code!=='workspace_not_found')throw error;foreignDenied=true}
 const rows=(await pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1',[p.bob.user])).rows
 if(rows.length!==1||rows[0].state!=='free'||rows[0].generation!=='0'||!foreignDenied)throw new Error('Original free-slot consumer mismatch')
 for(const table of ['pe_sandbox_instances','pe_cloud_executions','pe_stdio_v2_actions','pe_stdio_mcp_calls']){
  if((await pool.query('SELECT count(*)::text AS n FROM '+table+' WHERE user_id=$1',[p.bob.user])).rows[0].n!=='0')throw new Error('Original pristine slot has executor facts')
 }
 const directoryPath=p.root+'/pristine-source-workspaces/'+p.bob.workspace
 const sourcePath=directoryPath+'/'+path,stat=await lstat(sourcePath),directory=await lstat(directoryPath)
 if(!stat.isFile()||stat.isSymbolicLink()||sha(await readFile(sourcePath))!==read.revision)throw new Error('Original file bytes changed')
 const after=await hashes();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original file consumer inputs changed')
 await writeFile(p.resultFile,JSON.stringify({sourceRowProvider:'owned-restored-Schema37-default-free-row',
  sandboxManagerIssuedRow:false,originalFileServiceConsumed:true,namedInputsBefore:before,namedInputsAfter:after,
  userId:p.bob.user,workspaceId:p.bob.workspace,requestId:p.requestId,path,put,read,foreignDenied,
  workspaceDirectory:{mode:directory.mode&4095,uid:directory.uid,gid:directory.gid,inode:String(directory.ino)},
  file:{area:'workspace',owner:p.bob.user,resource:p.bob.workspace,path,kind:'file',sourcePath,
   bytes:String(stat.size),sha256:read.revision,mode:stat.mode&4095,uid:stat.uid,gid:stat.gid},
  executorCreated:false,transportRequests:0,physicalStopReceipt:null})+'\\n',{flag:'wx',mode:384})
}finally{
 try{if(bob)await identities.logout(bob.token);if(alice)await identities.logout(alice.token)}finally{await pool.end()}
}
`, { flag: 'wx', mode: 0o600 })
  const stop = new AbortController(), deadline = setTimeout(() => { stop.abort() }, 30000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo, env: { ...process.env,
      TSX_TSCONFIG_PATH: join(old, 'tsconfig.base.json') }, signal: stop.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: stop.signal.aborted,
        ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-pristine-mount-process.json'), result)
    await writeFile(join(root, 'original-pristine-mount-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.error !== undefined) {
      throw new Error('Original pristine mount file consumer failed')
    }
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const retained = join(evidenceRoot, `original-pristine-mount-source-${randomUUID()}`)
      await mkdir(retained, { mode: 0o700 })
      for (const name of ['original-pristine-mount-owner.mjs', 'original-pristine-mount-process.json',
        'original-pristine-mount-owner.log', 'original-pristine-mount-results.json']) {
        try { await writeFile(join(retained, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
    }
  }
  const result = z.object({ userId: z.uuid(), workspaceId: z.uuid(), requestId: z.uuid(), path: z.string(),
    put: z.object({ path: z.string(), size: z.number(), mime: z.string(), revision: z.string() }).strict(),
    read: z.object({ path: z.string(), size: z.number(), mime: z.string(), revision: z.string(), data: z.string() }).strict(),
    workspaceDirectory: z.object({ mode: z.number(), uid: z.number(), gid: z.number(), inode: z.string() }).strict(),
    file: z.object({ area: z.literal('workspace'), owner: z.uuid(), resource: z.uuid(), path: z.string(), kind: z.literal('file'),
      sourcePath: z.string(), bytes: z.string(), sha256: z.string(), mode: z.number(), uid: z.number(), gid: z.number() }).strict(),
    sandboxManagerIssuedRow: z.literal(false), originalFileServiceConsumed: z.literal(true), foreignDenied: z.literal(true),
    executorCreated: z.literal(false), transportRequests: z.literal(0), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
  const bytes = await readFile(result.file.sourcePath)
  if (legacyDigest(bytes) !== result.file.sha256) throw new Error('Original pristine file changed before bundle copy')
  await writeFile(join(root, 'bundle', result.path), bytes, { flag: 'wx', mode: result.file.mode })
  await chmod(join(root, 'bundle', result.path), result.file.mode)
  const directoryIndex = files.findIndex(file => file.area === 'workspace' && file.owner === bob.user && file.path === '')
  const directory = files[directoryIndex]
  if (!directory) throw new Error('Original pristine Workspace inventory missing')
  files[directoryIndex] = { ...directory, mode: result.workspaceDirectory.mode, uid: result.workspaceDirectory.uid,
    gid: result.workspaceDirectory.gid }
  files.push({ ...result.file, sourcePath: result.path })
  return result
}

async function originalStdioApprovalMetadata() {
  const root = await mkdtemp(join(tmpdir(), 'employee5-stdio-approval-metadata-'))
  await chmod(root, 0o700)
  const old = '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud'
  const script = join(root, 'original-approval-metadata.mjs'), resultFile = join(root, 'result.json')
  const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))
  const parameters = join(root, 'parameters.json'), userId = randomUUID(), sessionId = randomUUID(), executionId = randomUUID()
  const binding = { actionId: randomUUID(), taskDigest: legacyDigest('explicit protocol-only task example'),
    preparedDigest: legacyDigest('explicit protocol-only prepared example'), approvalEpoch: 1,
    expiresAt: '2025-01-02T03:04:05.123Z' }
  await privateJson(parameters, { old, key: key.toString('base64'), binding, resultFile,
    budget: { maxDepth: stdioV2Limits.maxJsonDepth, maxNodes: stdioV2Limits.maxJsonNodes, maxBytes: stdioV2Limits.maxInputBytes } })
  await writeFile(script, `import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
const names=['products/power-evolve/contracts/src/stdio-mcp.ts','products/power-evolve/contracts/src/stdio-mcp-json.ts',
 'products/power-evolve/connector-runner/src/stdio-v2-digest.ts','tsconfig.base.json']
const hashes=async()=>Object.fromEntries(await Promise.all(names.map(async n=>[n,createHash('sha256').update(await readFile(p.old+'/'+n)).digest('hex')])))
const before=await hashes()
const [{stdioApprovalBindingV2},{stdioApprovalFingerprintV2}]=await Promise.all([
 import(p.old+'/products/power-evolve/contracts/src/stdio-mcp.ts'),
 import(p.old+'/products/power-evolve/connector-runner/src/stdio-v2-digest.ts')])
const binding=stdioApprovalBindingV2.parse(p.binding),fingerprint=stdioApprovalFingerprintV2(Buffer.from(p.key,'base64'),binding,p.budget)
const after=await hashes();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original approval parser/signing inputs changed')
await writeFile(p.resultFile,JSON.stringify({binding,fingerprint,namedInputsBefore:before,namedInputsAfter:after,
 sourceOracle:'original SDK approval parser and HMAC only',metadataOnly:true,productionApproval:false,
 databaseRowsCreated:0,executorIdentitiesCreated:0})+'\\n',{flag:'wx',mode:384})
`, { flag: 'wx', mode: 0o600 })
  const stop = new AbortController(), deadline = setTimeout(() => { stop.abort() }, 15000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameters], { cwd: repo, env: { ...process.env,
      TSX_TSCONFIG_PATH: join(old, 'tsconfig.base.json') }, signal: stop.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: stop.signal.aborted,
        ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'process.json'), result)
    await writeFile(join(root, 'owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.error !== undefined) {
      throw new Error('Original approval metadata oracle failed')
    }
    const original = z.object({ binding: z.object({ actionId: z.uuid(), taskDigest: z.string(), preparedDigest: z.string(),
      approvalEpoch: z.literal(1), expiresAt: z.string() }).strict(), fingerprint: z.string(), metadataOnly: z.literal(true),
    productionApproval: z.literal(false), databaseRowsCreated: z.literal(0), executorIdentitiesCreated: z.literal(0) }).catchall(z.json())
      .parse(JSON.parse(await readFile(resultFile, 'utf8')))
    const values = { action_id: binding.actionId, user_id: userId, session_id: sessionId, phase: 'discover',
      execution_target: 'cloud', execution_id: executionId, task_digest: binding.taskDigest, prepared_digest: binding.preparedDigest,
      approval_binding: JSON.stringify(original.binding, null, 2), fingerprint: original.fingerprint, approval_epoch: '1',
      expires_at: '2025-01-02T03:04:05.123000Z', created_at: '2025-01-02T03:04:05.123456Z' }
    const preparation = { table: 'pe_stdio_v2_preparations', sourceTable: 'pe_stdio_v2_preparations',
      sourceSha256: legacyRowDigest('pe_stdio_v2_preparations', values), values }
    const decisions = (['once', 'reject'] as const).map((decision) => {
      const values = { action_id: binding.actionId, user_id: userId, fingerprint: original.fingerprint, decision,
        decided_at: '2025-01-02T03:04:05.120001Z' }
      return { table: 'pe_stdio_v2_decisions', sourceTable: 'pe_stdio_v2_decisions',
        sourceSha256: legacyRowDigest('pe_stdio_v2_decisions', values), values }
    })
    return { key, preparation, decisions, original, cut: '2025-01-02T03:04:05.124000Z' }
  } finally {
    clearTimeout(deadline)
    try {
      const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
      if (evidenceRoot) {
        const retained = join(evidenceRoot, `original-approval-metadata-${randomUUID()}`)
        await mkdir(retained, { mode: 0o700 })
        for (const name of ['original-approval-metadata.mjs', 'result.json', 'process.json', 'owner.log']) {
          try { await writeFile(join(retained, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
          catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        }
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

async function seedOriginalStoppedCreation(root: string, sourceUrl: URL, bob: ReturnType<typeof ids>, files: LegacyFileEntry[]) {
  const environmentFile = process.env.PE_EMPLOYEE5_ORIGINAL_PHYSICAL_ENV
  if (!environmentFile) throw new Error('Original owned physical environment required')
  const environment = z.object({ owner: z.literal('employee5'), ready: z.literal(true), network: z.string(), volume: z.string(),
    networkKubeconfig: z.string(), hostKubeconfig: z.string(), prefix: z.string() }).loose()
    .parse(JSON.parse(await readFile(environmentFile, 'utf8')))
  const script = join(root, 'original-stopped-creation.mjs'), parameter = join(root, 'original-stopped-creation-params.json')
  const resultFile = join(root, 'original-stopped-creation-results.json')
  const sourceRoot = '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud'
  const dockerUrl = new URL(sourceUrl)
  if (['localhost', '127.0.0.1'].includes(dockerUrl.hostname)) dockerUrl.hostname = 'host.docker.internal'
  await privateJson(parameter, { sourceUrl: dockerUrl.href, password, resultFile, root, sourceRoot, targetRoot: repo,
    sessionId: bob.session, workspaceId: bob.workspace, kubeconfig: environment.networkKubeconfig,
    dataRoot: `/owned/source-${randomUUID()}`, sourceUid: process.getuid?.(), sourceGid: process.getgid?.() })
  await writeFile(script, String.raw`import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned source database')
const names=['platform/executions.ts','platform/sandbox.ts','platform/pod-stop-status.ts','platform/kubernetes.ts',
 'platform/files.ts','platform/safe-posix.ts','platform/safe-posix.py','platform/tasks.ts','platform/database.ts',
 'platform/identity.ts','platform/account-authority.ts','platform/execution-file-facts.ts',
 'platform/workspace-binding-types.ts','platform/storage-bindings.ts','platform/cloud-execution-resolution-types.ts','contracts.ts']
const sha=data=>createHash('sha256').update(data).digest('hex')
const hashes=async()=>Object.fromEntries(await Promise.all(names.map(async name=>[name,
 sha(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+name))])))
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{ExecutionService},{SandboxManager},{KubernetesClient,KubernetesError},{FileService},{TaskStore},
 {IdentityService},contracts,{ExecutionFileFactsService},{kubernetesPodStopStatus}]=await Promise.all([
 load('platform/executions.ts'),load('platform/sandbox.ts'),load('platform/kubernetes.ts'),load('platform/files.ts'),
 load('platform/tasks.ts'),load('platform/identity.ts'),load('contracts.ts'),load('platform/execution-file-facts.ts'),load('platform/pod-stop-status.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:4}),kube=await KubernetesClient.fromFile(p.kubeconfig)
const namespace='pe-e5-creation-'+randomUUID().replaceAll('-',''),ns=await kube.call('POST','/api/v1/namespaces',
 {apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,labels:{'powerevolve.dev/fixture':'employee5'}}})
const call=kube.call.bind(kube),observations=[]
kube.call=async(method,path,...args)=>{
 if(!path.startsWith('/api/v1/namespaces/'+namespace+'/')&&!path.startsWith('/apis/agents.x-k8s.io/v1beta1/namespaces/'+namespace+'/'))
  throw new Error('Original consumer attempted an unowned namespace')
 const result=await call(method,path,...args)
 if(method==='GET'&&(path.includes('/pods/')||path.includes('/sandboxes/')))observations.push({path,result:structuredClone(result)})
 return result}
await mkdir(p.dataRoot,{recursive:true,mode:448})
const fileService=new FileService(pool,p.dataRoot+'/workspaces',{uid:p.sourceUid,gid:p.sourceGid});await fileService.init()
await fileService.safe.ensureWorkspace(p.workspaceId)
const manager=new SandboxManager(kube,fileService,pool,'C'.repeat(43),{namespace,image:'pe-dsh-migration-runner:20261009-v3',
 localRoot:p.dataRoot,nodeRoot:p.dataRoot,readyTimeoutMs:5000,
 fileScan:{maxEntries:100,maxHashBytes:1048576,timeoutMs:1000,maxSnapshotBytes:1048576,maxFiles:100}})
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1,executionEnabled:true})
const commandTimeoutMs=5000,service=new ExecutionService(tasks,manager,
 {service:new ExecutionFileFactsService(pool,fileService),timeoutMs:1000},1,100,60000,commandTimeoutMs,90000)
const identities=new IdentityService(pool,60000);let login
try{
 login=await identities.login('migration-bob',p.password)
 const accepted=await tasks.accept(login.user,contracts.sessionId.parse(p.sessionId),contracts.requestId.parse(randomUUID()),
  'Original owned creation cancellation before Runner readiness',login.token)
 const grant=await tasks.claim(randomUUID());if(!grant||grant.operationId!==accepted.operationId)throw new Error('Original grant absent')
 const proposed=await service.propose(grant.token,'creation-'+randomUUID(),'printf original-never-dispatched','')
 service.start();const deadline=Date.now()+35000;let creating
 while(Date.now()<deadline){creating=(await pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1',[p.sessionId])).rows[0]
  const pending=(await pool.query('SELECT state,error_code FROM pe_cloud_executions WHERE id=$1',[proposed.executionId])).rows[0]
  if(pending?.state==='uncertain'&&pending.error_code!=='mount_creation_unconfirmed')break
  if(creating?.pod_uid){const pod=await kube.call('GET',kube.resourcePath(namespace,'pods',creating.name))
   if(pod.metadata.finalizers?.includes('powerevolve.dev/retain-stop-observation'))break}await delay(100)}
 if(!creating?.pod_uid)throw new Error('Original actual Pod UID was not retained: '+JSON.stringify({
  execution:(await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[proposed.executionId])).rows,
  instances:(await pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1',[p.sessionId])).rows,
  slots:(await pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1',[login.user.userId])).rows}))
 const cancellation=await service.cancel(login.user,proposed.executionId);let execution,instance,slot
 while(Date.now()<deadline){execution=(await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[proposed.executionId])).rows[0]
  instance=(await pool.query('SELECT * FROM pe_sandbox_instances WHERE session_id=$1',[p.sessionId])).rows[0]
  slot=(await pool.query('SELECT * FROM pe_mount_slots WHERE user_id=$1',[login.user.userId])).rows[0]
  if(execution?.state==='cancelled'&&execution.lease_owner===null&&instance?.state==='deleted'&&slot?.state==='free')break
  await delay(100)}
 await service.close()
 if(execution?.state!=='cancelled'||instance?.state!=='deleted'||slot?.state!=='free'||slot.generation==='0'
  ||execution.sandbox_name!==null||execution.pod_uid!==null||execution.runner_instance_id!==null||execution.dispatch_request!==null
  ||instance.runner_instance_id!==null||instance.stop_evidence?.status!=='UNSCHEDULED_DELETING')
  throw new Error('Original Manager/execution creation closure incomplete: '+JSON.stringify({execution,instance,slot}))
 const pods=observations.filter(o=>o.path.includes('/pods/')).map(o=>o.result)
 const podBeforeStop=pods.find(pod=>!pod.metadata.deletionTimestamp&&pod.metadata.uid===instance.stop_pod_uid)
 const podDeleting=pods.find(pod=>kubernetesPodStopStatus(pod)==='UNSCHEDULED_DELETING'
  &&pod.metadata.uid===instance.stop_pod_uid&&pod.metadata.finalizers?.includes('powerevolve.dev/retain-stop-observation'))
 const sandboxBeforeStop=observations.filter(o=>o.path.includes('/sandboxes/')).map(o=>o.result)
  .find(sandbox=>!sandbox.metadata.deletionTimestamp&&sandbox.metadata.uid===instance.stop_evidence.sandboxUid)
 if(!podBeforeStop||!podDeleting||!sandboxBeforeStop)throw new Error('Original actual creation stop observations absent')
 for(const resource of ['sandboxes','pods','services','secrets']){
  try{await kube.call('GET',kube.resourcePath(namespace,resource,instance.name));throw new Error('Owned resource remains: '+resource)}
  catch(error){if(!(error instanceof KubernetesError&&error.status===404))throw error}}
 await tasks.finish(grant.token,'failed','owned_fixture_no_host')
 const continuation=await tasks.claim(randomUUID())
 if(!continuation||continuation.sourceExecutionId!==execution.id)throw new Error('Original continuation absent')
 await tasks.finish(continuation.token,'failed','owned_fixture_no_host')
 const requestId=randomUUID(),path='created-after-stop.txt',bytes=Buffer.from('Original FileService after actual creation stop\n')
 const uploaded=await fileService.put(login.user,contracts.requestId.parse(requestId),path,null,bytes.toString('base64'),
  contracts.workspaceId.parse(p.workspaceId))
 const read=await fileService.read(login.user,path,contracts.workspaceId.parse(p.workspaceId))
 const binding=await fileService.bindingForId(login.user.userId,p.workspaceId)
 const workspace=await fileService.workspaceForId(login.user.userId,p.workspaceId)
 const stat=await lstat(workspace.path+'/'+path),workspaceStat=await lstat(workspace.path),home=await lstat(p.dataRoot+'/homes/'+login.user.userId)
 const skills=await lstat(p.dataRoot+'/skill-packages/'+login.user.userId)
 const terminal=await service.cancel(login.user,execution.id),listed=await service.list(login.user)
 const after=await hashes();if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original named source changed')
 await writeFile(p.resultFile,JSON.stringify({userId:login.user.userId,sessionId:p.sessionId,workspaceId:p.workspaceId,
  executionId:execution.id,namespace,namespaceUid:ns.metadata.uid,commandTimeoutMs,podBeforeStop,podDeleting,sandboxBeforeStop,
  originalStopStatus:kubernetesPodStopStatus(podDeleting),resourcesAbsentAfterManagerStop:true,commandDispatched:false,runnerStarted:false,
  terminal,listed,cancellation,sourceInputs:before,sourceInputsAfter:after,sourceCodeScope:'Sixteen named original creation consumer inputs',
  upload:{requestId,path,bytesBase64:bytes.toString('base64'),receipt:uploaded,read,binding,mode:stat.mode&511,uid:stat.uid,gid:stat.gid,
   workspace:{mode:workspaceStat.mode&511,uid:workspaceStat.uid,gid:workspaceStat.gid},
   home:{mode:home.mode&511,uid:home.uid,gid:home.gid},skills:{mode:skills.mode&511,uid:skills.uid,gid:skills.gid}},
  productionSource:false,ownedFixture:true,initialWorkspaceProvider:'Owned restored ready root through original SafePosix.ensureWorkspace'})+'\n',
 {flag:'wx',mode:384})
}finally{await service.close();if(login)await identities.logout(login.token);await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const stop = new AbortController(), deadline = setTimeout(() => { stop.abort() }, 90000)
  let output = ''
  try {
    const args = ['run', '--rm', '--label', 'powerevolve.owner=employee5', '--network', environment.network,
      '--mount', `type=volume,source=${environment.volume},target=/owned`,
      '--mount', `type=bind,source=${sourceRoot},target=${sourceRoot},readonly`,
      '--mount', `type=bind,source=${repo},target=${repo},readonly`, '--mount', `type=bind,source=${root},target=${root}`,
      '--mount', `type=bind,source=${environment.networkKubeconfig},target=${environment.networkKubeconfig},readonly`,
      '--workdir', sourceRoot, '--env', `TSX_TSCONFIG_PATH=${sourceRoot}/tsconfig.base.json`,
      '--env', 'ESBUILD_BINARY_PATH=/build/node_modules/.pnpm/@esbuild+linux-arm64@0.28.1/node_modules/@esbuild/linux-arm64/bin/esbuild',
      '--entrypoint', 'node', 'pe-employee4-deps:52d0c631-4307-4b39-92f4-d02dfaf66942', '--import', 'tsx/esm', script, parameter]
    const outerContext = process.env.PE_EMPLOYEE5_ORIGINAL_DOCKER_CONTEXT
    const child = spawn('docker', outerContext ? ['--context', outerContext, ...args] : args,
      { signal: stop.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    let error: string | undefined
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string; timedOut: boolean }>((done) => {
      child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString() })
      child.stderr.on('data', (bytes: Buffer) => { output += bytes.toString() })
      child.once('error', (failure) => { error = failure.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: stop.signal.aborted,
        ...(error === undefined ? {} : { error }) }) })
    })
    await privateJson(join(root, 'original-stopped-creation-process.json'), result)
    await writeFile(join(root, 'original-stopped-creation.log'), output, { mode: 0o600, flag: 'wx' })
    if (result.code !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) {
      throw new Error(`Original stopped creation failed: ${output}`)
    }
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const retained = await mkdtemp(join(evidenceRoot, 'original-stopped-creation-'))
      for (const name of ['original-stopped-creation.mjs', 'original-stopped-creation-process.json',
        'original-stopped-creation.log', 'original-stopped-creation-results.json']) {
        try { await writeFile(join(retained, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
    }
  }
  const attributes = z.object({ mode: z.number().int(), uid: z.number().int(), gid: z.number().int() }).strict()
  const result = z.object({ userId: z.uuid(), sessionId: z.uuid(), workspaceId: z.uuid(), executionId: z.uuid(),
    namespace: z.string(), namespaceUid: z.uuid(), commandTimeoutMs: z.number().int(),
    podBeforeStop: z.record(z.string(), z.json()), podDeleting: z.record(z.string(), z.json()),
    sandboxBeforeStop: z.record(z.string(), z.json()), originalStopStatus: z.literal('UNSCHEDULED_DELETING'),
    listed: z.json(), terminal: z.json(),
    resourcesAbsentAfterManagerStop: z.literal(true), commandDispatched: z.literal(false), runnerStarted: z.literal(false),
    upload: z.object({ requestId: z.uuid(), path: z.string(), bytesBase64: z.string(), receipt: z.json(), read: z.json(),
      binding: z.object({ rootKey: z.uuid() }).loose(), mode: z.number().int(), uid: z.number().int(), gid: z.number().int(),
      workspace: attributes, home: attributes, skills: attributes }).strict(),
    productionSource: z.literal(false), ownedFixture: z.literal(true) }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
  const { upload } = result, bytes = Buffer.from(upload.bytesBase64, 'base64')
  await writeFile(join(root, 'bundle', 'creation-upload.txt'), bytes, { flag: 'wx', mode: upload.mode })
  await chmod(join(root, 'bundle', 'creation-upload.txt'), upload.mode)
  for (const entry of files) {
    if (entry.owner === bob.user && entry.kind === 'directory' && entry.path === '') {
      const observed = entry.area === 'home' ? upload.home : upload.workspace
      Object.assign(entry, observed)
    }
  }
  files.push({ area: 'workspace', owner: bob.user, resource: upload.binding.rootKey, path: upload.path, kind: 'file',
    sourcePath: 'creation-upload.txt', bytes: String(bytes.length), sha256: legacyDigest(bytes), mode: upload.mode, uid: upload.uid, gid: upload.gid })
  return { ...result, hostKubeconfig: environment.hostKubeconfig }
}

async function seedOriginalCloudCancellation(root: string, sourceUrl: URL, bob: ReturnType<typeof ids>) {
  const script = join(root, 'original-cloud-cancel-owner.mjs'), parameter = join(root, 'original-cloud-cancel-params.json')
  const resultFile = join(root, 'original-cloud-cancel-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, password, resultFile, root, sessionId: bob.session,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo,
    kubeconfig: '/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/k3s-migration-kubeconfig.yaml' })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned cloud cancellation fixture')
const files=['platform/executions.ts','platform/sandbox.ts','platform/cloud-execution-resolution.ts',
 'platform/cloud-execution-resolution-types.ts','platform/cloud-execution-resolution-ownership.ts','platform/pod-stop-status.ts',
 'platform/files.ts','platform/tasks.ts','platform/identity.ts','platform/account-authority.ts','platform/database.ts','contracts.ts',
 'platform/kubernetes.ts','platform/execution-file-facts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const value={};for(const file of files)
 value[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return value}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{ExecutionService},{SandboxManager},{KubernetesClient},{FileService},{TaskStore},{IdentityService},contracts,{ExecutionFileFactsService}]
 =await Promise.all([load('platform/executions.ts'),load('platform/sandbox.ts'),load('platform/kubernetes.ts'),
 load('platform/files.ts'),load('platform/tasks.ts'),load('platform/identity.ts'),load('contracts.ts'),load('platform/execution-file-facts.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:2}),kube=await KubernetesClient.fromFile(p.kubeconfig)
const namespace='pe-e5-cloud-'+randomUUID().replaceAll('-',''),call=kube.call.bind(kube)
let transportRequests=0,login
kube.call=async(method,path,...args)=>{transportRequests++
 if(!path.includes('/namespaces/'+namespace+'/'))throw new Error('Original cloud worker attempted unowned namespace')
 return call(method,path,...args)}
const filesService=new FileService(pool,p.root+'/original-cloud-unused-workspaces');await filesService.init()
const sandboxes=new SandboxManager(kube,filesService,pool,'A'.repeat(43),{namespace,
 image:'registry.example/owned-unused-sandbox@sha256:'+'a'.repeat(64),localRoot:p.root+'/original-cloud-unused-home',
 nodeRoot:p.root+'/original-cloud-unused-node',readyTimeoutMs:1000,maxExecutions:8})
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1,executionEnabled:true})
const commandTimeoutMs=5000,executionFiles=new ExecutionFileFactsService(pool,filesService)
const service=new ExecutionService(tasks,sandboxes,{service:executionFiles,timeoutMs:1000},1,100,60000,commandTimeoutMs,90000)
const identities=new IdentityService(pool,60000)
try{
 login=await identities.login('migration-bob',p.password)
 const originalRequest=randomUUID(),input='Original cloud command cancelled before any executor reservation'
 const accepted=await tasks.accept(login.user,contracts.sessionId.parse(p.sessionId),contracts.requestId.parse(originalRequest),input,login.token)
 const grant=await tasks.claim(randomUUID())
 if(!grant||grant.operationId!==accepted.operationId)throw new Error('Original cloud admission grant missing')
 const callId='original-cloud-'+randomUUID(),command='printf original-cancelled-command',cwd=''
 const proposed=await service.propose(grant.token,callId,command,cwd)
 const cancellation=await service.cancel(login.user,proposed.executionId)
 if(cancellation.state!=='queued')throw new Error('Original cloud cancellation was not before the worker')
 service.start()
 const until=Date.now()+20000
 let row
 while(Date.now()<until){
  row=(await pool.query('SELECT * FROM pe_cloud_executions WHERE id=$1',[proposed.executionId])).rows[0]
  if(row?.state==='cancelled'&&row.lease_owner===null)break
  await delay(50)
 }
 if(row?.state!=='cancelled'||row.sandbox_name!==null||row.pod_uid!==null||row.runner_instance_id!==null
  ||row.dispatch_request!==null||row.attempts!==1||transportRequests)throw new Error('Original cloud executor cancellation incomplete')
 await tasks.finish(grant.token,'failed','owned_fixture_no_host')
 const continuation=await tasks.claim(randomUUID())
 if(!continuation||continuation.source!=='sandbox_result'||continuation.sourceExecutionId!==row.id)
  throw new Error('Original cloud cancellation continuation missing')
 await tasks.finish(continuation.token,'failed','owned_fixture_no_host');await service.close()
 const reservations=(await pool.query('SELECT count(*)::text AS n FROM pe_mount_slots')).rows[0].n
 const instances=(await pool.query('SELECT count(*)::text AS n FROM pe_sandbox_instances')).rows[0].n
 const after=await hashes(),terminal=await service.cancel(login.user,row.id),listed=await service.list(login.user)
 if(reservations!=='0'||instances!=='0'||transportRequests||JSON.stringify(before)!==JSON.stringify(after))
  throw new Error('Original cloud no-executor or named source facts failed')
 await writeFile(p.resultFile,JSON.stringify({userId:login.user.userId,executionId:row.id,originalRequest,input,
  operationId:grant.operationId,continuationOperationId:continuation.operationId,callId,command,cwd,commandTimeoutMs,
  proposed,cancellation,terminal,listed,cancellationBeforeWorker:true,executorReservationCreated:false,transportRequests,
  sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:'Fourteen named original Cloud owner inputs; complete original source/build/dependencies remain open',
  cloudWorkerStarted:true,hostStarted:false,executorCreated:false,networkDispatchStarted:false,physicalStopReceipt:null})+'\n',{flag:'wx',mode:0o600})
}finally{await service.close();if(login)await identities.logout(login.token);await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 45000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: controller.signal.aborted,
        ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-cloud-cancel-process.json'), result)
    await writeFile(join(root, 'original-cloud-cancel-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.error !== undefined) {
      throw new Error('Original cloud cancellation owner failed')
    }
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-cloud-cancel-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-cloud-cancel-owner.mjs', 'original-cloud-cancel-process.json',
        'original-cloud-cancel-owner.log', 'original-cloud-cancel-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  const item = z.object({ executionId: z.uuid(), state: z.enum(['queued', 'cancelled']), command: z.string(), cwd: z.string(),
    result: z.null(), errorCode: z.null() }).strict()
  return z.object({ userId: z.uuid(), executionId: z.uuid(), originalRequest: z.uuid(), input: z.string(), operationId: z.uuid(),
    continuationOperationId: z.uuid(), callId: z.string(), command: z.string(), cwd: z.string(), commandTimeoutMs: z.number().int(),
    proposed: item, cancellation: item, terminal: item, listed: z.object({ items: z.array(item.extend({ createdAt: z.string() })) }),
    cancellationBeforeWorker: z.literal(true), executorReservationCreated: z.literal(false), transportRequests: z.literal(0),
    sourceCodeSha256: z.string(), cloudWorkerStarted: z.literal(true), hostStarted: z.literal(false), executorCreated: z.literal(false),
    networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalStdioV2Metadata(root: string, sourceUrl: URL) {
  const script = join(root, 'original-stdio-v2-metadata-owner.mjs'), parameter = join(root, 'original-stdio-v2-metadata-params.json')
  const resultFile = join(root, 'original-stdio-v2-metadata-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, password, resultFile, limits: stdioV2Limits, management: stdioV2Management,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned original STDIO v2 fixture database')
const sourceFiles=['application/src/platform/stdio-v2-connections.ts','application/src/platform/account-authority.ts',
 'application/src/platform/database.ts','application/src/platform/identity.ts','application/src/contracts.ts',
 'contracts/src/stdio-management.ts','contracts/src/stdio-mcp.ts','contracts/src/stdio-mcp-json.ts',
 'contracts/src/stdio-runtime.ts','connector-runner/src/stdio-v2-digest.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const result={};for(const file of sourceFiles)
 result[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/'+file));return result}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{StdioConnectionServiceV2},{IdentityService}]=await Promise.all([load('platform/stdio-v2-connections.ts'),load('platform/identity.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:1}),identities=new IdentityService(pool,60000)
const service=new StdioConnectionServiceV2(pool,p.limits,p.management)
let alice,bob
try{
 alice=await identities.login('migration-alice',p.password);bob=await identities.login('migration-bob',p.password)
 const aliceCreate={requestId:randomUUID().toUpperCase(),configuration:{name:'Original STDIO v2 中文',
  invocation:{program:'python3',argv:['-c','print("original 中文")','literal $(never executes)'],cwd:'.'}}}
 const created=await service.create(alice.token,aliceCreate)
 const aliceUpdate={requestId:randomUUID(),connectionId:created.connectionId,expectedRevision:1,
  configuration:{name:'Original updated configuration',invocation:{program:'python3',argv:['-c','print("later original")'],cwd:'historical/dir'}}}
 const updated=await service.update(alice.token,aliceUpdate)
 const aliceToggle={requestId:randomUUID(),connectionId:created.connectionId,expectedRevision:2,enabled:false}
 const toggled=await service.toggle(alice.token,aliceToggle)
 const aliceDelete={requestId:randomUUID(),connectionId:created.connectionId,expectedRevision:2}
 const deleted=await service.remove(alice.token,aliceDelete)
 const bobCreate={requestId:randomUUID(),configuration:{name:'Bob original disabled v2',
  invocation:{program:'node',argv:['--version'],cwd:'.'}}}
 const bobCreated=await service.create(bob.token,bobCreate)
 const bobList=await service.list(bob.token,{})
 const after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original named STDIO v2 source drifted')
 await writeFile(p.resultFile,JSON.stringify({aliceCreate,created,aliceUpdate,updated,aliceToggle,toggled,aliceDelete,deleted,
  bobCreate,bobCreated,bobList,limits:p.limits,management:p.management,sourceInputs:before,sourceInputsAfter:after,
  sourceCodeSha256:hash(JSON.stringify(before)),sourceScope:'Ten named original STDIO v2 metadata modules; complete source/build/dependencies remain open',
  programStarted:false,hostStarted:false,workerStarted:false,networkDispatchStarted:false,physicalStopReceipt:null})+'\n',{mode:0o600,flag:'wx'})
}finally{if(alice)await identities.logout(alice.token);if(bob)await identities.logout(bob.token);await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 30000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code) => { done({ code, ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-stdio-v2-metadata-process.json'), result)
    await writeFile(join(root, 'original-stdio-v2-metadata-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0) throw new Error('Original STDIO v2 metadata owner failed')
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-stdio-v2-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-stdio-v2-metadata-owner.mjs', 'original-stdio-v2-metadata-process.json',
        'original-stdio-v2-metadata-owner.log', 'original-stdio-v2-metadata-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  return z.object({ aliceCreate: stdioV2Schemas.create, created: stdioV2Schemas.mutationReceipt,
    aliceUpdate: stdioV2Schemas.update, updated: stdioV2Schemas.mutationReceipt, aliceToggle: stdioV2Schemas.toggle,
    toggled: stdioV2Schemas.mutationReceipt, aliceDelete: stdioV2Schemas.remove, deleted: stdioV2Schemas.mutationReceipt,
    bobCreate: stdioV2Schemas.create, bobCreated: stdioV2Schemas.mutationReceipt, bobList: stdioV2Schemas.list,
    limits: stdioLimitsV2, management: stdioManagementLimitsV2, sourceCodeSha256: z.string(),
    programStarted: z.literal(false), hostStarted: z.literal(false), workerStarted: z.literal(false),
    networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalStdioV2Cancellation(root: string, sourceUrl: URL, bob: ReturnType<typeof ids>,
  metadata: Awaited<ReturnType<typeof seedOriginalStdioV2Metadata>>) {
  const script = join(root, 'original-stdio-v2-cancel-owner.mjs'), parameter = join(root, 'original-stdio-v2-cancel-params.json')
  const resultFile = join(root, 'original-stdio-v2-cancel-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, password, resultFile, root, sessionId: bob.session,
    connectionId: metadata.bobCreated.connectionId, limits: stdioV2Limits, management: stdioV2Management,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo,
    kubeconfig: '/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/k3s-migration-kubeconfig.yaml' })
  await writeFile(script, String.raw`import {readFile,writeFile,lstat,chmod} from 'node:fs/promises'
import {createHash,randomUUID,randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned STDIO v2 cancellation source')
const files=['platform/stdio-v2-services.ts','platform/stdio-v2-platform-config.ts','platform/stdio-v2-admission.ts',
 'platform/stdio-v2-actions.ts','platform/stdio-v2-worker-store.ts','platform/stdio-v2-cloud-worker.ts',
 'platform/stdio-v2-no-start.ts','platform/stdio-v2-connections.ts','platform/stdio-v2-operation-admission.ts',
 'platform/stdio-v2-authorization.ts','platform/stdio-v2-results.ts','platform/stdio-v2-continuations.ts',
 'platform/stdio-v2-cloud-runtime.ts','platform/stdio-v2-cloud-capture.ts','platform/stdio-v2-leases.ts',
 'platform/files.ts','platform/storage-bindings.ts','platform/safe-posix.ts','platform/safe-posix.py',
 'platform/sandbox.ts','platform/kubernetes.ts',
 'platform/tasks.ts','platform/identity.ts','platform/account-authority.ts','platform/database.ts','contracts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const value={};for(const file of files)
 value[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file))
 for(const file of ['tsconfig.base.json','products/power-evolve/contracts/src/account.ts',
  'products/power-evolve/contracts/src/stdio-mcp.ts','products/power-evolve/contracts/src/stdio-management.ts',
  'products/power-evolve/contracts/src/stdio-runtime.ts','products/power-evolve/contracts/src/stdio-mcp-json.ts',
  'products/power-evolve/connector-runner/src/stdio-v2-digest.ts'])value[file]=hash(await readFile(p.sourceRoot+'/'+file))
 return value}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{createStdioCloudServicesV2},{loadStdioPlatformConfigV2},{StdioOperationAdmissionV2},{FileService},
 {SandboxManager},{KubernetesClient},{TaskStore},{IdentityService}]=await Promise.all([
 load('platform/stdio-v2-services.ts'),load('platform/stdio-v2-platform-config.ts'),load('platform/stdio-v2-operation-admission.ts'),
 load('platform/files.ts'),load('platform/sandbox.ts'),load('platform/kubernetes.ts'),load('platform/tasks.ts'),load('platform/identity.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:3}),kube=await KubernetesClient.fromFile(p.kubeconfig)
const namespace='pe-e5-v2-'+randomUUID().replaceAll('-',''),call=kube.call.bind(kube)
let transportRequests=0,login,services,running
const stop=new AbortController()
kube.call=async(method,path,...args)=>{transportRequests++
 if(!path.includes('/namespaces/'+namespace+'/'))throw new Error('Original v2 worker attempted unowned namespace')
 return call(method,path,...args)}
const filesService=new FileService(pool,p.root+'/original-v2-unused-workspaces');await filesService.init()
const pin={kind:'cloud',deploymentId:randomUUID(),protocolVersion:2,platform:{os:'linux',architecture:'arm64'},
 imageReference:'registry.example/owned-unused-stdio@sha256:'+'b'.repeat(64),configImageId:'sha256:'+'c'.repeat(64),
 runtimeImageIds:['containerd://sha256:'+'d'.repeat(64)]}
const approvalKeyFile=p.root+'/original-v2-unused-approval-key',configFile=p.root+'/original-v2-unused-policy.json'
await writeFile(approvalKeyFile,randomBytes(32).toString('hex')+'\n',{flag:'wx',mode:0o600})
const settings={approvalKeyFile,limits:p.limits,management:p.management,
 admission:{maxConnections:8,maxTools:16,maxSnapshotBytes:65536,maxDescriptionBytes:8192},cloudDeployment:pin,
 maxReplyBytes:262144,maxPendingPerUser:8,maxCallsPerChain:8,chainLifetimeMs:60000,approvalLifetimeMs:30000,
 worker:{pollMs:100,renewMs:1000,leaseMs:30000,maxActive:2,maxCandidates:8},
 transport:{requestTimeoutMs:1000,maxTrackedActions:8}}
await writeFile(configFile,JSON.stringify(settings)+'\n',{flag:'wx',mode:0o600})
const config=await loadStdioPlatformConfigV2(configFile)
if(!config)throw new Error('Original v2 configuration missing')
const selection=new StdioOperationAdmissionV2(filesService,{limits:p.limits,admission:settings.admission,
 maxReplyBytes:settings.maxReplyBytes,cloudDeployment:pin})
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1,executionEnabled:true})
const sandboxes=new SandboxManager(kube,filesService,pool,'A'.repeat(43),{namespace,image:pin.imageReference,
 localRoot:p.root+'/original-v2-unused-home',nodeRoot:p.root+'/original-v2-unused-node',readyTimeoutMs:1000,maxExecutions:8})
const identities=new IdentityService(pool,60000)
try{
 services=createStdioCloudServicesV2(pool,tasks,selection,filesService,sandboxes,config,randomUUID())
 login=await identities.login('migration-bob',p.password)
 const directory=(await pool.query('SELECT w.id AS workspace_id,b.space_id,s.root_key,b.root_relative_path'
  +' FROM pe_sessions se JOIN pe_workspaces w ON w.id=se.workspace_id AND w.user_id=se.user_id'
  +' JOIN pe_workspace_bindings b ON b.workspace_id=w.id AND b.user_id=w.user_id'
  +' JOIN pe_storage_spaces s ON s.id=b.space_id AND s.user_id=w.user_id WHERE se.id=$1 AND se.user_id=$2',
  [p.sessionId,login.user.userId])).rows[0]
 if(!directory||directory.root_relative_path!=='')throw new Error('Owned initial source workspace mapping missing')
 await filesService.safe.ensureWorkspace(directory.root_key)
 const directoryPath=filesService.safe.path({rootKey:directory.root_key,rootRelativePath:''})
 await chmod(directoryPath,0o750);const stat=await lstat(directoryPath)
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Owned source workspace directory invalid')
 const sourceWorkspaceDirectory={...directory,mode:stat.mode&0o777,uid:stat.uid,gid:stat.gid,inode:String(stat.ino)}
 const request={requestId:randomUUID(),connectionId:p.connectionId,expectedRevision:1,sessionId:p.sessionId,target:{kind:'cloud'}}
 const accepted=await services.discovery.check(login.token,request)
 const cancellation=await services.actions.cancel(login.token,{actionId:accepted.actionId})
 if(cancellation.state!=='queued'||!cancellation.cancelRequested)throw new Error('Original v2 cancellation not before worker')
 running=services.worker.run(stop.signal)
 const until=Date.now()+20000
 let row
 while(Date.now()<until){row=(await pool.query('SELECT * FROM pe_stdio_v2_actions WHERE id=$1',[accepted.actionId])).rows[0]
  if(row?.state==='cancelled'&&row.lease_owner===null)break;await delay(50)}
 stop.abort();await running;await services.worker.stop()
 const closure=(await pool.query('SELECT * FROM pe_stdio_v2_no_start_closures WHERE action_id=$1',[accepted.actionId])).rows[0]
 if(row?.state!=='cancelled'||row.lease_epoch!=='1'||closure?.receipt?.resource?.kind!=='unallocated'||transportRequests)
  throw new Error('Original v2 no-start closure incomplete')
 const detail=await services.actions.detail(login.token,{actionId:accepted.actionId})
 const listed=await services.actions.list(login.token,{offset:0,limit:8})
 const terminal=await services.actions.cancel(login.token,{actionId:accepted.actionId})
 const retried=await services.discovery.check(login.token,request)
 const names=['pe_sandbox_instances','pe_mount_slots','pe_stdio_v2_preparations','pe_stdio_v2_decisions',
 'pe_stdio_v2_start_permits','pe_stdio_v2_dispatches','pe_stdio_v2_results','pe_stdio_v2_catalogs','pe_stdio_v2_observations']
 const empty={};for(const name of names)empty[name]=(await pool.query('SELECT count(*)::text AS n FROM '+name)).rows[0].n
 empty.stdio_continuations=(await pool.query('SELECT count(*)::text AS n FROM pe_operations'
  +' WHERE source_stdio_v2_action_id=$1 OR source_stdio_v2_no_start_action_id=$1',[accepted.actionId])).rows[0].n
 const after=await hashes()
 if(Object.values(empty).some(n=>n!=='0')||JSON.stringify(before)!==JSON.stringify(after)||transportRequests)
  throw new Error('Original v2 source or unallocated facts failed')
 await writeFile(p.resultFile,JSON.stringify({userId:login.user.userId,request,accepted,retried,detail,listed,terminal,
  sourceWorkspaceDirectory,deploymentPin:pin,limits:p.limits,management:p.management,empty,transportRequests,
  cancellationBeforeWorker:true,workerStarted:true,executorCreated:false,programStarted:false,hostStarted:false,
  preparationCreated:false,approvalIssued:false,networkDispatchStarted:false,physicalStopReceipt:null,
  sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:'Thirty-three named original STDIO v2 application/SDK/resolution inputs; unused descriptor is not OCI qualification; full source/build open'})+'\n',
  {flag:'wx',mode:0o600})
}finally{stop.abort();if(running)await running;if(services)await services.worker.stop();if(login)await identities.logout(login.token);await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 45000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      signal: controller.signal, env: { ...process.env,
        TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: controller.signal.aborted,
        ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-stdio-v2-cancel-process.json'), result)
    await writeFile(join(root, 'original-stdio-v2-cancel-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.error !== undefined) {
      throw new Error('Original STDIO v2 cancellation owner failed')
    }
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-stdio-v2-cancel-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-stdio-v2-cancel-owner.mjs', 'original-stdio-v2-cancel-process.json',
        'original-stdio-v2-cancel-owner.log', 'original-stdio-v2-cancel-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  return z.object({ userId: z.uuid(), request: z.json(), accepted: stdioV2Schemas.checkReceipt, retried: stdioV2Schemas.checkReceipt,
    detail: z.json(), listed: z.json(), terminal: z.json(), deploymentPin: z.json(), transportRequests: z.literal(0),
    cancellationBeforeWorker: z.literal(true), workerStarted: z.literal(true), executorCreated: z.literal(false),
    programStarted: z.literal(false), hostStarted: z.literal(false), preparationCreated: z.literal(false),
    approvalIssued: z.literal(false), networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null(),
    sourceCodeSha256: z.string() }).catchall(z.json()).parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalConnectorRejection(root: string, sourceUrl: URL, bob: ReturnType<typeof ids>) {
  const script = join(root, 'original-connector-owner.mjs'), parameter = join(root, 'original-connector-params.json')
  const resultFile = join(root, 'original-connector-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, password, resultFile, sessionId: bob.session,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned connector fixture database')
const files=['platform/connectors.ts','platform/plugins.ts','platform/tasks.ts','platform/identity.ts',
 'platform/account-authority.ts','platform/database.ts','contracts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const value={};for(const file of files)
 value[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return value}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{ConnectorService},{PluginService},{TaskStore},{IdentityService},{sessionId,requestId}]=await Promise.all([
 load('platform/connectors.ts'),load('platform/plugins.ts'),load('platform/tasks.ts'),load('platform/identity.ts'),load('contracts.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:1}),identities=new IdentityService(pool,60000)
const tasks=new TaskStore(pool,{maxEventBytes:262144,leaseMs:60000,maxPendingPerUser:8,maxActivePerUser:1})
const service=new ConnectorService(tasks,'http://127.0.0.1:9','owned-unused-connector-key',1000,500)
let actor,approval
try{
 await new PluginService(pool).seedUsers(['migration-alice','migration-bob'])
 await service.seedPermissions(['migration-alice','migration-bob'])
 actor=await identities.login('migration-bob',p.password)
 approval=await identities.login('migration-bob',p.password,'approval')
 const originalRequest=randomUUID(),input='Original rejected connector metadata-only acceptance'
 await tasks.accept(actor.user,sessionId.parse(p.sessionId),requestId.parse(originalRequest),input,actor.token)
 const grant=await tasks.claim(randomUUID())
 if(!grant||grant.source!=='user')throw new Error('Original connector parent grant missing')
 const callId=randomUUID(),rawText='  original note 中文\nsecond line  '
 const proposed=await service.prepare(grant.token,callId,rawText)
 const terminal=await service.decide(approval.user,proposed.actionId,proposed.fingerprint,false,approval.token)
 await tasks.finish(grant.token,'failed','owned_metadata_fixture_no_host')
 const continuation=await tasks.claim(randomUUID())
 if(!continuation||continuation.source!=='platform_action'||continuation.sourceActionId!==proposed.actionId)
  throw new Error('Original rejected connector continuation missing')
 await tasks.finish(continuation.token,'failed','owned_metadata_fixture_no_host')
 await service.setPermission(actor.user,'trial_note_append',false)
 await service.setPermission(actor.user,'trial_note_query',false)
 const permissions=await service.permissions(actor.user),after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Original connector named source drifted')
 await writeFile(p.resultFile,JSON.stringify({originalRequest,input,operationId:grant.operationId,
  continuationOperationId:continuation.operationId,callId,rawText,proposed,terminal,permissions,
  sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:'Seven named original connector owner modules; complete source/build/dependencies remain open',
  connectorWorkerStarted:false,hostStarted:false,networkDispatchStarted:false,physicalStopReceipt:null})+'\n',{mode:0o600,flag:'wx'})
}finally{await service.close();if(actor)await identities.logout(actor.token);if(approval)await identities.logout(approval.token);await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 30000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code) => { done({ code, ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-connector-process.json'), result)
    await writeFile(join(root, 'original-connector-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0) throw new Error('Original connector metadata owner failed')
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-connector-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-connector-owner.mjs', 'original-connector-process.json',
        'original-connector-owner.log', 'original-connector-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  const receipt = z.object({ actionId: z.uuid(), state: z.enum(['pending', 'rejected']), action: z.literal('trial_note_append'),
    text: z.string(), fingerprint: z.string(), result: z.null(), errorCode: z.null() }).strict()
  return z.object({ originalRequest: z.uuid(), input: z.string(), operationId: z.uuid(), continuationOperationId: z.uuid(),
    callId: z.string(), rawText: z.string(), proposed: receipt, terminal: receipt,
    permissions: z.object({ items: z.array(z.object({ capability: z.enum(['trial_note_append', 'trial_note_query']), enabled: z.boolean() })) }),
    sourceCodeSha256: z.string(), connectorWorkerStarted: z.literal(false), hostStarted: z.literal(false),
    networkDispatchStarted: z.literal(false), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
}

async function seedOriginalBuiltinSkills(root: string, sourceUrl: URL, files: LegacyFileEntry[]) {
  const script = join(root, 'original-builtin-owner.mjs'), parameter = join(root, 'original-builtin-params.json')
  const resultFile = join(root, 'original-builtin-results.json')
  await privateJson(parameter, { sourceUrl: sourceUrl.href, password, resultFile, root,
    sourceRoot: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud', targetRoot: repo })
  await writeFile(script, String.raw`import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
const p=JSON.parse(await readFile(process.argv[2],'utf8'))
if(!new URL(p.sourceUrl).pathname.startsWith('/pe_employee5_v2_source_'))throw new Error('Unowned builtin fixture database')
const files=['platform/skills.ts','platform/builtin-skills.ts','platform/skill-package-extraction.ts',
 'platform/skill-package-manifest.ts','platform/skill-metadata.ts','platform/account-authority.ts',
 'platform/database.ts','platform/identity.ts','contracts.ts']
const hash=data=>createHash('sha256').update(data).digest('hex')
async function hashes(){const value={};for(const file of files)
 value[file]=hash(await readFile(p.sourceRoot+'/products/power-evolve/application/src/'+file));return value}
const before=await hashes(),load=file=>import(pathToFileURL(p.sourceRoot+'/products/power-evolve/application/src/'+file).href)
const [{SkillService},{BuiltinSkillCatalog,builtinSkillAssetRoot},{IdentityService}]=await Promise.all([
 load('platform/skills.ts'),load('platform/builtin-skills.ts'),load('platform/identity.ts')])
const {Pool}=createRequire(p.targetRoot+'/products/power-evolve/application/package.json')('pg')
const pool=new Pool({connectionString:p.sourceUrl,max:1}),identities=new IdentityService(pool,60000)
const skills=new SkillService(pool,p.root+'/bundle/source-builtin-workspaces',p.root+'/bundle/source-builtin-library',64)
let alice,bob
try{
 await skills.init();alice=await identities.login('migration-alice',p.password);bob=await identities.login('migration-bob',p.password)
 const catalogId='builtin.pdf',version='1.0.0',release=await new BuiltinSkillCatalog().get(catalogId,version)
 if(!release)throw new Error('Original builtin PDF release missing')
 const assetRoot=builtinSkillAssetRoot(),catalogText=await readFile(assetRoot+'/catalog.json','utf8')
 const manifestText=await readFile(assetRoot+'/extensions/'+catalogId+'/'+version+'.manifest.json','utf8')
 const archiveBase64=release.archive.toString('base64'),catalogSha256=hash(catalogText)
 const records=[]
 for(const actor of [alice,alice,bob]){
  const requestId=randomUUID(),item=await skills.installBuiltin(actor.user,requestId,catalogId,version)
  records.push({userId:actor.user.userId,requestId,item})
 }
 await skills.toggle(alice.user,records[0].requestId,false)
 const aliceRead=await skills.read(alice.user,records[0].requestId),bobRead=await skills.read(bob.user,records[2].requestId)
 const after=await hashes()
 if(JSON.stringify(before)!==JSON.stringify(after)||hash(await readFile(assetRoot+'/catalog.json'))!==catalogSha256
  ||(await readFile(assetRoot+'/extensions/'+catalogId+'/'+version+'.manifest.json','utf8'))!==manifestText
  ||hash(release.archive)!==hash(await readFile(assetRoot+'/extensions/'+catalogId+'/'+version+'.zip')))
  throw new Error('Original builtin named source or assets drifted')
 await writeFile(p.resultFile,JSON.stringify({catalogId,version,catalogText,catalogSha256,manifestText,archiveBase64,
  records,aliceRead,bobRead,sourceInputs:before,sourceInputsAfter:after,sourceCodeSha256:hash(JSON.stringify(before)),
  sourceScope:'Nine named original Skill owner modules and selected catalog/manifest/ZIP; complete source/build/dependencies remain open',
  hostStarted:false,packageScriptsExecuted:false,physicalStopReceipt:null})+'\n',{flag:'wx',mode:0o600})
}finally{if(alice)await identities.logout(alice.token);if(bob)await identities.logout(bob.token);await pool.end()}
`, { flag: 'wx', mode: 0o600 })
  const controller = new AbortController(), deadline = setTimeout(() => { controller.abort() }, 30000)
  let output = '', processError: string | undefined
  try {
    const child = spawn('node', ['--import', 'tsx/esm', script, parameter], { cwd: repo,
      env: { ...process.env, TSX_TSCONFIG_PATH: '/Users/jingchao/agent_work/main_agent/power-evolve-native-cloud/tsconfig.base.json' },
      signal: controller.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; error?: string }>((done) => {
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => { processError = error.message })
      child.once('close', (code, signal) => { done({ code, signal, timedOut: controller.signal.aborted,
        ...(processError === undefined ? {} : { error: processError }) }) })
    })
    await privateJson(join(root, 'original-builtin-process.json'), result)
    await writeFile(join(root, 'original-builtin-owner.log'), output, { flag: 'wx', mode: 0o600 })
    if (result.code !== 0 || result.signal !== null || result.timedOut || result.error !== undefined) {
      throw new Error('Original built-in Skill owner failed')
    }
  } finally {
    clearTimeout(deadline)
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const evidence = join(evidenceRoot, `original-builtin-source-${randomUUID()}`)
      await mkdir(evidence, { mode: 0o700 })
      for (const name of ['original-builtin-owner.mjs', 'original-builtin-process.json',
        'original-builtin-owner.log', 'original-builtin-results.json']) {
        try { await writeFile(join(evidence, name), await readFile(join(root, name)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error }
      }
    }
  }
  const result = z.object({ catalogId: z.string(), version: z.string(), catalogText: z.string(), catalogSha256: z.string(),
    manifestText: z.string(), archiveBase64: z.string(), sourceCodeSha256: z.string(),
    records: z.array(z.object({ userId: z.uuid(), requestId: z.uuid(), item: z.record(z.string(), z.json()) })).length(3),
    aliceRead: z.record(z.string(), z.json()), bobRead: z.record(z.string(), z.json()),
    hostStarted: z.literal(false), packageScriptsExecuted: z.literal(false), physicalStopReceipt: z.null() }).catchall(z.json())
    .parse(JSON.parse(await readFile(resultFile, 'utf8')))
  const archiveDigest = legacyDigest(Buffer.from(result.archiveBase64, 'base64'))
  for (const userId of new Set(result.records.map(record => record.userId))) {
    const packageRoot = join(root, 'bundle', 'source-builtin-library', 'skill-packages', userId, 'sha256', archiveDigest)
    const walk = async (path: string): Promise<void> => {
      const original = join(packageRoot, path), stat = await lstat(original)
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw new Error('Original Skill tree entry invalid')
      const body = stat.isFile() ? await readFile(original) : null
      files.push({ area: 'skill-package', owner: userId, resource: archiveDigest, path,
        kind: body === null ? 'directory' : 'file', sourcePath: body === null ? null : relative(join(root, 'bundle'), original),
        bytes: body === null ? null : String(body.length), sha256: body === null ? null : legacyDigest(body),
        mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid })
      if (body === null) for (const name of await readdir(original)) await walk(path ? `${path}/${name}` : name)
    }
    await walk('')
  }
  return result
}

function ownedOfficeService(pool: Pool, root: string, imageDigest: string) {
  return new OfficePreviewService(pool, {
    bindingForId: async () => { throw new Error('Cancellation tombstone attempted a storage binding read') },
    readInWorkspace: async () => { throw new Error('Cancellation tombstone attempted a source file read') },
  }, {
    call: async () => { throw new Error('Cancellation tombstone attempted Kubernetes IO') },
    resourcePath: () => { throw new Error('Cancellation tombstone attempted a Pod resource path') },
  }, { namespace: 'owned-original-office', runtimeClassName: 'owned-offline-runtime',
    image: `registry.example/owned-office@sha256:${imageDigest}`, volumeClaimName: 'owned-office-cache', volumeSubPath: 'jobs',
    kubernetesTimeoutMs: 5000, terminationGraceSeconds: 5, cpuMilliCores: 1000, memoryMiB: 2048, temporaryMiB: 256,
    localRoot: root, fontPolicyDigest: 'b'.repeat(64), maxConcurrentParsers: 1, maxRetainedJobsPerUser: 8,
    leaseMs: 30000, jobDeadlineMs: 60000, limits: { inputBytes: 65536, outputBytes: 65536, timeoutMs: 20000,
      archiveEntries: 1000, uncompressedBytes: 67108864, fontLoadedBytes: 134217728, pages: 100, fontFiles: 100,
      fontFileBytes: 134217728, fontResolutionEntries: 1000, imageResolution: 150 } })
}
async function seedOfficeTombstone(pool: Pool, root: string) {
  const identities = new IdentityService(pool, 60000), actor = await identities.login('migration-alice', password)
  const service = ownedOfficeService(pool, join(root, 'owned-original-office'), 'a'.repeat(64))
  try {
    const generation = (await service.generation(actor.token)).generation
    const requestId = officePreviewPrepareRequest.shape.requestId.parse(`original-office-${randomUUID()}`)
    const result = await service.cancel(actor.token, { requestId, generation })
    return { requestId, generation, result }
  } finally { await identities.logout(actor.token) }
}

async function seedStorageOwners(pool: Pool, root: string, alice: ReturnType<typeof ids>, files: LegacyFileEntry[]) {
  const uploadRequest = randomUUID(), textSkill = randomUUID(), packageSkill = randomUUID(), expiredRequest = randomUUID()
  const text = 'Original text instructions.', uploadBytes = Buffer.from('Old successful upload, before the later file edit.\n')
  await insert(pool, 'pe_file_mutations', { user_id: alice.user, request_id: uploadRequest, workspace_id: alice.workspace,
    path: 'original.txt', digest: legacyDigest(uploadBytes), base_digest: null, mime: 'text/plain',
    size: String(uploadBytes.length), binding_generation: '9' })
  const textPath = join(root, 'bundle', 'text-skill.md')
  await writeFile(textPath, text, { flag: 'wx', mode: 0o600 })
  const textStat = await lstat(textPath)
  files.push({ area: 'skill-text', owner: alice.user, resource: textSkill, path: '', kind: 'file', sourcePath: 'text-skill.md',
    bytes: String(Buffer.byteLength(text)), sha256: legacyDigest(text), mode: textStat.mode & 0o777, uid: textStat.uid, gid: textStat.gid })
  await insert(pool, 'pe_user_skills', { id: textSkill, user_id: alice.user, name: 'Old text skill', description: 'Original private text',
    digest: legacyDigest(text), kind: 'text', enabled: 'false', revision: '3' })
  const instructions = Buffer.from('---\nname: employee-five-original\ndescription: "Original YAML: 中文"\n---\nOriginal package body.\n')
  const resource = Buffer.from('Original package resource\n'), authoredVersion = '1.2.3-legacy.1'
  const zip = Buffer.from(zipSync({ 'SKILL.md': instructions, 'resource.txt': resource,
    'skill-package.json': Buffer.from(JSON.stringify({ schemaVersion: 1, version: authoredVersion })) }, { level: 6 }))
  const archive = join(root, 'source-package.zip'), packageRoot = join(root, 'bundle', 'package-original')
  await writeFile(archive, zip, { flag: 'wx', mode: 0o600 }); await mkdir(packageRoot, { mode: 0o750 })
  const extracted = await extractSkillPackage(archive, packageRoot), archiveDigest = legacyDigest(zip)
  const metadata = await readNativeSkillMetadata(join(packageRoot, 'skill'))
  const version = await skillPackageVersion(join(packageRoot, 'skill'), archiveDigest, extracted)
  const manifest = skillPackageManifest(archiveDigest, extracted)
  await writeFile(join(packageRoot, 'manifest.json'), manifest, { flag: 'wx', mode: 0o444 })
  await chmod(join(packageRoot, 'manifest.json'), 0o444)
  await insert(pool, 'pe_user_skills', { id: packageSkill, user_id: alice.user, name: metadata.name, description: metadata.description,
    digest: legacyDigest(instructions), kind: 'package', enabled: 'false', revision: '5', revoked_at: time })
  await insert(pool, 'pe_skill_package_versions', { id: packageSkill, user_id: alice.user, skill_id: packageSkill,
    name: metadata.name, description: metadata.description, version, archive_digest: archiveDigest, archive_size: String(zip.length),
    instruction_digest: legacyDigest(instructions), manifest_digest: legacyDigest(manifest), manifest })
  await pool.query('UPDATE pe_user_skills SET package_version_id=$2 WHERE id=$1', [packageSkill, packageSkill])
  const consumedTicket = randomUUID(), expiredTicket = randomUUID()
  for (const item of [{ request: packageSkill, ticket: consumedTicket, consumed: time },
    { request: expiredRequest, ticket: expiredTicket, consumed: null }]) {
    await insert(pool, 'pe_skill_upload_intents', { request_id: item.request, user_id: alice.user, size_bytes: String(zip.length),
      archive_digest: archiveDigest, token_digest: legacyDigest(item.ticket), expires_at: time, consumed_at: item.consumed })
  }
  const walk = async (relative: string): Promise<void> => {
    const path = join(packageRoot, relative), stat = await lstat(path)
    const file = stat.isFile(), body = file ? await readFile(path) : null
    files.push({ area: 'skill-package', owner: alice.user, resource: archiveDigest, path: relative,
      kind: file ? 'file' : 'directory', sourcePath: file ? `package-original/${relative}` : null,
      bytes: body === null ? null : String(body.length), sha256: body === null ? null : legacyDigest(body),
      mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid })
    if (!file) for (const name of await readdir(path)) await walk(relative ? `${relative}/${name}` : name)
  }
  await walk('')
  return { uploadRequest, uploadBytes, textSkill, text, packageSkill, instructions, resource, archiveDigest, zip,
    version, metadata, consumedTicket, expiredTicket, expiredRequest }
}

/** Allocate and close only new uniquely named databases, roles and file roots. */
async function fixture(run: (value: {
  root: string
  source: Pool
  readonly: Pool
  target: Pool
  capture: LegacyMigrationCapture
  sourceUrl: URL
  targetUrl: URL
  catalog: string
  alice: ReturnType<typeof ids>
  bob: ReturnType<typeof ids>
  child: string
  histories: LegacyHistoryStorage[]
  attachmentSources: LegacyMigrationFileSource[]
  attachmentRoots: Record<string, string>
  files: LegacyFileEntry[]
  images?: LegacyMigrationImagesInput
  originalImages: StoredImageAttachment[]
  accountOwners?: Awaited<ReturnType<typeof seedAccountOwners>>
  fixedMcp?: Awaited<ReturnType<typeof seedFixedMcp>>
  storageOwners?: Awaited<ReturnType<typeof seedStorageOwners>>
  remoteMcp?: Awaited<ReturnType<typeof seedRemoteMcp>>
  mcpEvidence?: z.infer<typeof legacyMigrationMcpEvidence>
  mcpActions?: Awaited<ReturnType<typeof seedOriginalMcpActions>>
  office?: Awaited<ReturnType<typeof seedOfficeTombstone>>
  ssh?: Awaited<ReturnType<typeof seedOriginalSshManagement>>
  sshEvidence?: z.infer<typeof legacyMigrationSshKey>
  stdio?: Awaited<ReturnType<typeof seedOriginalStdioMetadata>>
  stdioEvidence?: z.infer<typeof legacyMigrationStdioEvidence>
  stdioV2?: Awaited<ReturnType<typeof seedOriginalStdioV2Metadata>>
  stdioV2Policy?: z.infer<typeof legacyMigrationStdioV2Policy>
  connector?: Awaited<ReturnType<typeof seedOriginalConnectorRejection>>
  builtin?: Awaited<ReturnType<typeof seedOriginalBuiltinSkills>>
  builtinEvidence?: z.infer<typeof legacyMigrationBuiltinEvidence>
  stdioCall?: Awaited<ReturnType<typeof seedOriginalStdioNoStartCall>>
  stdioCallEvidence?: z.infer<typeof legacyMigrationStdioCallEvidence>
  cloudCancellation?: Awaited<ReturnType<typeof seedOriginalCloudCancellation>>
  cloudCancellationEvidence?: z.infer<typeof legacyMigrationCloudCancellationEvidence>
  stdioV2Cancellation?: Awaited<ReturnType<typeof seedOriginalStdioV2Cancellation>>
  stdioNoStartEvidence?: z.infer<typeof legacyMigrationStdioNoStartEvidence>
  pristineMount?: Awaited<ReturnType<typeof seedOriginalPristineMount>>
  stoppedCreation?: Awaited<ReturnType<typeof seedOriginalStoppedCreation>>
  stoppedCreationEvidence?: z.infer<typeof legacyMigrationStoppedCreationEvidence>
}) => Promise<void>, includeHistorical = false, includeImages = false, includeAccountOwners = false,
includeFixedMcp = false, includeStorageOwners = false, includeRemoteMcp = false, includeNoStartMcp = false,
includeMcpActions = false, includeOffice = false, includeSsh = false, includeSshActions = false, includeStdio = false,
includeStdioV2 = false, includeConnector = false, includeAttachmentAliases = false, includeBuiltin = false,
includeStdioCall = false, includeCloudCancellation = false, includeStdioV2Cancellation = false, includePristineMount = false,
includeStoppedCreation = false) {
  const suffix = randomUUID().replaceAll('-', '')
  const sourceName = `pe_employee5_v2_source_${suffix}`, targetName = `pe_employee5_v2_target_${suffix}`
  const readRole = `pe_employee5_v2_read_${suffix}`, targetRole = `pe_employee5_v2_owner_${suffix}`
  const readPassword = randomUUID(), targetPassword = randomUUID()
  const root = await mkdtemp(join(tmpdir(), 'employee5-legacy-v2-'))
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 })
  const sourceUrl = new URL(adminUrl), targetUrl = new URL(adminUrl), readUrl = new URL(adminUrl)
  sourceUrl.pathname = `/${sourceName}`; readUrl.pathname = `/${sourceName}`; targetUrl.pathname = `/${targetName}`
  readUrl.username = readRole; readUrl.password = readPassword
  targetUrl.username = targetRole; targetUrl.password = targetPassword
  const source = new Pool({ connectionString: sourceUrl.href, max: 1 })
  const readonly = new Pool({ connectionString: readUrl.href, max: 1 })
  const target = new Pool({ connectionString: targetUrl.href, max: 2 })
  const acquired: {
    databases: string[]
    roles: string[]
  } = { databases: [], roles: [] }
  try {
    await admin.query(`CREATE ROLE "${readRole}" LOGIN PASSWORD '${readPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    acquired.roles.push(readRole)
    await admin.query(`CREATE ROLE "${targetRole}" LOGIN PASSWORD '${targetPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    acquired.roles.push(targetRole)
    await admin.query(`CREATE DATABASE "${sourceName}"`); acquired.databases.push(sourceName)
    await admin.query(`CREATE DATABASE "${targetName}" OWNER "${targetRole}"`); acquired.databases.push(targetName)
    await source.query(await readFile(new URL('./fixtures/employee5-legacy-migration-source37.sql', import.meta.url), 'utf8'))
    const alice = ids(), bob = ids(), child = randomUUID(), histories: LegacyHistoryStorage[] = []
    const files: LegacyFileEntry[] = [], attachmentSources: LegacyMigrationFileSource[] = [], attachmentRoots: Record<string, string> = {}
    const images: LegacyMigrationImagesInput = { sources: [], sourceHomes: {}, maxImagePixels: 16 }
    const originalImages: StoredImageAttachment[] = []
    const uid = process.getuid?.(), gid = process.getgid?.()
    if (uid === undefined || gid === undefined) throw new Error('Owned source fixture needs POSIX file ownership')
    await mkdir(join(root, 'bundle'), { mode: 0o700 }); await mkdir(join(root, 'source-files'), { mode: 0o700 })
    const refs = []
    for (const [index, person] of [alice, bob].entries()) {
      await insert(source, 'pe_users', { id: person.user, username: index ? 'migration-bob' : 'migration-alice', password_hash: verifier,
        settings: '{ "model": "trial-model", "maxTokens": 1000, "revision": 7 }', display_name: index ? 'Bob' : 'Alice',
        role: 'USER', enabled: 'true', account_revision: '7', credential_version: '3', password_change_required: 'false' })
      await insert(source, 'pe_user_models', { user_id: person.user, model_id: 'trial-model', label: 'Trial', max_tokens: '1000', enabled: 'true' })
      await insert(source, 'pe_workspaces', { id: person.workspace, user_id: person.user, title: 'Old workspace', is_default: 'true',
        create_request_id: randomUUID(), binding_generation: '9', binding_state: 'ready' })
      await insert(source, 'pe_storage_spaces', { id: person.workspace, user_id: person.user, root_key: person.workspace,
        title: 'Owned old root', is_default: 'true', root_state: 'ready' })
      await insert(source, 'pe_workspace_bindings', { workspace_id: person.workspace, user_id: person.user, space_id: person.workspace,
        root_relative_path: '' })
      await insert(source, 'pe_credentials', { user_id: person.user, digest: legacyDigest(`expired:${person.user}`),
        audience: 'agent', expires_at: time, credential_version: '3' })
      for (const area of ['workspace', 'home'] as const) files.push({ area, owner: person.user,
        resource: area === 'workspace' ? person.workspace : person.user, path: '', kind: 'directory', sourcePath: null,
        bytes: null, sha256: null, mode: 0o750, uid, gid })
      const attachmentRoot = join(root, 'source-files', person.session)
      await mkdir(attachmentRoot, { mode: 0o700 }); attachmentRoots[person.session] = attachmentRoot
      refs.push(await saveFileStreamVerbatim(attachmentRoot, { name: index ? 'bob.txt' : 'first.txt',
        data: data(index ? 'Bob original\n' : 'First original\n第二行\n'), signal: new AbortController().signal }))
    }
    const first = refs[0], secondOwner = refs[1]
    if (!first || !secondOwner) throw new Error('Owned file fixture missing')
    const alias = includeAttachmentAliases ? await saveFileStreamVerbatim(attachmentRoots[alice.session] ?? '', {
      name: 'same-bytes-other-name.txt', data: data('First original\n第二行\n'), signal: new AbortController().signal }) : undefined
    const late = await saveFileStreamVerbatim(attachmentRoots[alice.session] ?? '', { name: 'late.txt', data: data('outside fork prefix\n'),
      signal: new AbortController().signal })
    if (includeImages) {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
      const red = await readFile(join(repo, 'packages/llm/llm-deepseek/tests/fixtures/red.png'))
      for (const [person, bytes, name] of [[alice, png, 'first-image.png'], [alice, red, 'later-image.png'], [bob, png, 'bob-image.png']] as const) {
        const home = join(root, 'source-images', person.session)
        await mkdir(home, { recursive: true, mode: 0o700 }); images.sourceHomes[person.session] = home
        const context = new Context()
        try {
          const store = new AttachmentLocal(context, { dshHome: home, maxImageBytes: 65536, maxImagePixels: 4096,
            maxImageDimension: 4096, normalizedImageMaxPixels: 16, normalizedImageMaxDimension: 4, normalizedImageMaxBytes: 1024 })
          const ref = await store.saveImage({ data: bytes, mediaType: 'image/png', name })
          originalImages.push(await store.readImage(ref))
        } finally { await context.fiber.dispose() }
      }
    }
    const parentHeader = { id: SessionId(alice.session), version: 4 as const, createdAt: 1, isSeeded: false }
    const parent = Session.create(parentHeader.id, undefined, parentHeader, undefined, [imageOffloadProjection])
    for (const [index, ref] of [first, late].entries()) {
      parent.append('turn/start', { turn: index + 1 })
      parent.append('user/message', { id: MessageId(randomUUID()), role: 'user',
        content: [{ type: 'text', text: index ? 'later content' : '旧记录\0\uD800' }, { type: 'file', attachment: ref },
          ...(index === 0 && alias ? [{ type: 'file' as const, attachment: alias }] : []),
          ...(originalImages[index] ? [{ type: 'image' as const, attachment: originalImages[index].ref }] : [])],
        source: { kind: 'user' } }, { surfaceOp: 'append' })
      if (includeImages && index === 0) parent.append('image/offload', { targets: [{ seq: SessionSeq(1), imageIndexes: [0] }] })
      parent.append('turn/end', { turn: index + 1, reason: { kind: 'completed' } })
    }
    parent.append('session/title', { title: '旧标题\0\uD800', messageSeqs: [], source: { kind: 'user' } })
    const events = parent.snapshotEvents().map((event, index) => ({ ...event, time: index + 1 }))
    const childHeader = { id: SessionId(child), version: 4 as const, createdAt: 1, isSeeded: true, parentSession: parentHeader.id }
    const seeded = buildForkSeed(events, SessionSeq(includeImages ? 3 : 2))
    const bobHeader = { id: SessionId(bob.session), version: 4 as const, createdAt: 1, isSeeded: false }
    const bobSession = Session.create(bobHeader.id, undefined, bobHeader)
    bobSession.append('turn/start', { turn: 1 })
    bobSession.append('user/message', { id: MessageId(randomUUID()), role: 'user', content: [{ type: 'file', attachment: secondOwner },
      ...(originalImages[2] ? [{ type: 'image' as const, attachment: originalImages[2].ref }] : [])],
    source: { kind: 'user' } }, { surfaceOp: 'append' })
    bobSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (const item of [ { person: alice, id: alice.session, header: parentHeader, events },
      { person: alice, id: child, header: childHeader, events: seeded },
      { person: bob, id: bob.session, header: bobHeader,
        events: bobSession.snapshotEvents().map((event, index) => ({ ...event, time: index + 1 })) } ]) {
      await insert(source, 'pe_sessions', { id: item.id, user_id: item.person.user, workspace_id: item.person.workspace,
        create_request_id: randomUUID(), header: JSON.stringify(item.header), event_count: String(item.events.length),
        event_bytes: String(item.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)), lease_epoch: '13' })
      for (const event of item.events) await insert(source, 'pe_events', { session_id: item.id, seq: String(event.seq),
        event: JSON.stringify(event).replace('"time":1,', '"time":1e0,') })
      histories.push({ sessionId: item.id, encoding: 'pg-logical' })
    }
    if (includeHistorical) for (const version of [0, 1, 2, 3]) {
      const { parent, child: historicalChild } = await seedHistorical(source, alice, version)
      histories.push({ sessionId: parent, encoding: 'released-physical' }, { sessionId: historicalChild, encoding: 'released-physical' })
    }
    const accountOwners = includeAccountOwners ? await seedAccountOwners(source, alice, bob) : undefined
    const fixedMcp = includeFixedMcp ? await seedFixedMcp(source, alice, bob) : undefined
    const storageOwners = includeStorageOwners ? await seedStorageOwners(source, root, alice, files) : undefined
    const remoteMcp = includeRemoteMcp ? await seedRemoteMcp(source, alice, bob, includeNoStartMcp) : undefined
    const mcpActions = includeMcpActions && remoteMcp
      ? await seedOriginalMcpActions(root, sourceUrl, bob, remoteMcp.key) : undefined
    const office = includeOffice ? await seedOfficeTombstone(source, root) : undefined
    const ssh = includeSsh ? await seedOriginalSshManagement(root, sourceUrl, alice, bob, includeSshActions) : undefined
    const stdio = includeStdio ? await seedOriginalStdioMetadata(root, sourceUrl, alice, bob) : undefined
    const stdioCall = includeStdioCall && stdio ? await seedOriginalStdioNoStartCall(root, sourceUrl, bob, stdio) : undefined
    const cloudCancellation = includeCloudCancellation ? await seedOriginalCloudCancellation(root, sourceUrl, bob) : undefined
    const stdioV2 = includeStdioV2 ? await seedOriginalStdioV2Metadata(root, sourceUrl) : undefined
    const stdioV2Cancellation = includeStdioV2Cancellation && stdioV2
      ? await seedOriginalStdioV2Cancellation(root, sourceUrl, bob, stdioV2) : undefined
    const connector = includeConnector ? await seedOriginalConnectorRejection(root, sourceUrl, bob) : undefined
    const builtin = includeBuiltin ? await seedOriginalBuiltinSkills(root, sourceUrl, files) : undefined
    const pristineMount = includePristineMount ? await seedOriginalPristineMount(root, sourceUrl, alice, bob, files) : undefined
    const stoppedCreation = includeStoppedCreation ? await seedOriginalStoppedCreation(root, sourceUrl, bob, files) : undefined
    await source.query(`GRANT USAGE ON SCHEMA public TO "${readRole}"`)
    await source.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${readRole}"`)
    const client = await source.connect()
    let catalog: string
    try { catalog = await legacyMigrationCatalogDigest(client) } finally { client.release() }
    const sourceCut = includeRemoteMcp || includeOffice || includeSsh || includeStdio || includeStdioV2 || includeConnector
      || includeBuiltin || includeStdioCall || includeCloudCancellation || includeStdioV2Cancellation
      || includePristineMount || includeStoppedCreation
      ? (await source.query<{ cut: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cut`)).rows[0]!.cut : time
    const sourceIdentity = { schema: 37 as const, ddlSha256: LEGACY_SQL_DIGESTS.source37, snapshotId: randomUUID(),
      codeId: 'employee5-source37-owned-fixture', stoppedAt: sourceCut, cut: sourceCut }
    const capture = await captureLegacyMigrationSource(readonly, sourceIdentity, { purpose: 'offline-readonly-export',
      expectedDatabase: sourceName, expectedCatalogSha256: catalog, batchRows: 2, statementTimeoutMs: 5000, limits: budgets },
    new AbortController().signal)
    const stoppedCreationEvidence = stoppedCreation === undefined ? undefined : legacyMigrationStoppedCreationEvidence.parse({
      format: 'power-evolve-legacy-stopped-creation', version: 1, sourceCodeId: sourceIdentity.codeId,
      commandTimeoutMs: stoppedCreation.commandTimeoutMs,
      requests: [{ userId: stoppedCreation.userId, sessionId: stoppedCreation.sessionId, workspaceId: stoppedCreation.workspaceId,
        executionId: stoppedCreation.executionId, namespace: stoppedCreation.namespace, namespaceUid: stoppedCreation.namespaceUid,
        instanceSha256: legacyRowDigest('pe_sandbox_instances', capture.tables.pe_sandbox_instances!
          .find(row => row.session_id === stoppedCreation.sessionId)!),
        slotSha256: legacyRowDigest('pe_mount_slots', capture.tables.pe_mount_slots!.find(row => row.user_id === stoppedCreation.userId)!),
        executionSha256: legacyRowDigest('pe_cloud_executions', capture.tables.pe_cloud_executions!
          .find(row => row.id === stoppedCreation.executionId)!),
        podBeforeStop: stoppedCreation.podBeforeStop, podDeleting: stoppedCreation.podDeleting,
        sandboxBeforeStop: stoppedCreation.sandboxBeforeStop, originalStopStatus: stoppedCreation.originalStopStatus,
        resourcesAbsentAfterManagerStop: stoppedCreation.resourcesAbsentAfterManagerStop,
        commandDispatched: stoppedCreation.commandDispatched, runnerStarted: stoppedCreation.runnerStarted }] })
    if (stoppedCreationEvidence !== undefined) {
      await privateJson(join(root, 'stopped-creation-evidence.json'), stoppedCreationEvidence)
      await privateJson(join(root, 'stopped-creation-capture.json'), capture)
    }
    const stdioNoStartEvidence = stdioV2Cancellation === undefined ? undefined : legacyMigrationStdioNoStartEvidence.parse({
      format: 'power-evolve-legacy-stdio-v2-no-start', version: 1, sourceCodeId: sourceIdentity.codeId,
      limits: stdioV2Limits, management: stdioV2Management, deploymentPin: stdioV2Cancellation.deploymentPin,
      requests: [{ userId: stdioV2Cancellation.userId, actionId: stdioV2Cancellation.accepted.actionId,
        executionId: stdioV2Cancellation.accepted.executionRef.executionId, requestId: stdioV2Cancellation.accepted.requestId,
        actionSha256: legacyRowDigest('pe_stdio_v2_actions', capture.tables.pe_stdio_v2_actions![0]!),
        executionSha256: legacyRowDigest('pe_cloud_executions', capture.tables.pe_cloud_executions!
          .find(row => row.id === stdioV2Cancellation.accepted.executionRef.executionId)!),
        requestSha256: legacyRowDigest('pe_stdio_v2_management_requests', capture.tables.pe_stdio_v2_management_requests!
          .find(row => row.request_id === stdioV2Cancellation.accepted.requestId)!),
        closureSha256: legacyRowDigest('pe_stdio_v2_no_start_closures', capture.tables.pe_stdio_v2_no_start_closures![0]!),
        cancellationBeforeWorker: stdioV2Cancellation.cancellationBeforeWorker,
        preparationCreated: stdioV2Cancellation.preparationCreated, approvalIssued: stdioV2Cancellation.approvalIssued,
        transportRequests: stdioV2Cancellation.transportRequests }] })
    if (stdioNoStartEvidence !== undefined) {
      await privateJson(join(root, 'stdio-v2-no-start-original-evidence.json'), stdioNoStartEvidence)
      await privateJson(join(root, 'stdio-v2-no-start-source-capture.json'), capture)
    }
    const mcpEvidence = remoteMcp === undefined ? undefined : legacyMigrationMcpEvidence.parse({
      format: 'power-evolve-legacy-mcp-inputs', version: 1, keyId: remoteMcp.keyId, sourceCodeId: sourceIdentity.codeId,
      requests: remoteMcp.records.map((record) => {
        const row = capture.tables.pe_mcp_management_requests?.find(item => item.user_id === record.userId
          && item.request_id === record.input.requestId.toLowerCase())
        if (!row) throw new Error('Owned original MCP input row missing')
        return { ...record, requestId: row.request_id, sourceRowSha256: legacyRowDigest('pe_mcp_management_requests', row) }
      }) })
    if (remoteMcp !== undefined && mcpEvidence !== undefined) {
      await privateJson(join(root, 'mcp-original-key.json'), { format: 'power-evolve-legacy-mcp-key', version: 1,
        keyId: remoteMcp.keyId, key: remoteMcp.key })
      await privateJson(join(root, 'mcp-original-inputs.json'), mcpEvidence)
      await privateJson(join(root, 'mcp-source-capture.json'), capture)
    }
    const stdioCallEvidence = stdioCall === undefined ? undefined : legacyMigrationStdioCallEvidence.parse({
      format: 'power-evolve-legacy-stdio-no-start', version: 1, sourceCodeId: sourceIdentity.codeId,
      requests: [{ userId: stdioCall.userId, callId: stdioCall.callId,
        sourceRowSha256: legacyRowDigest('pe_stdio_mcp_calls', capture.tables.pe_stdio_mcp_calls!.find(row => row.id === stdioCall.callId)!),
        namespace: stdioCall.namespace, namespaceUid: stdioCall.namespaceUid, liveProbeInvocations: stdioCall.liveProbeInvocations,
        liveProbeAccepted: stdioCall.liveProbeAccepted, creationRequests: stdioCall.creationRequests,
        observations: stdioCall.observations }] })
    if (stdioCallEvidence !== undefined) {
      await privateJson(join(root, 'stdio-call-original-evidence.json'), stdioCallEvidence)
      await privateJson(join(root, 'stdio-call-source-capture.json'), capture)
    }
    const cloudCancellationEvidence = cloudCancellation === undefined ? undefined : legacyMigrationCloudCancellationEvidence.parse({
      format: 'power-evolve-legacy-cloud-cancellation', version: 1, sourceCodeId: sourceIdentity.codeId,
      commandTimeoutMs: cloudCancellation.commandTimeoutMs, requests: [{ userId: cloudCancellation.userId,
        executionId: cloudCancellation.executionId, sourceRowSha256: legacyRowDigest('pe_cloud_executions',
          capture.tables.pe_cloud_executions!.find(row => row.id === cloudCancellation.executionId)!),
        cancellationBeforeWorker: cloudCancellation.cancellationBeforeWorker,
        executorReservationCreated: cloudCancellation.executorReservationCreated,
        transportRequests: cloudCancellation.transportRequests }] })
    if (cloudCancellationEvidence !== undefined) {
      await privateJson(join(root, 'cloud-cancel-original-evidence.json'), cloudCancellationEvidence)
      await privateJson(join(root, 'cloud-cancel-source-capture.json'), capture)
    }
    if (office !== undefined) await privateJson(join(root, 'office-source-capture.json'), capture)
    const sshEvidence = ssh === undefined ? undefined : legacyMigrationSshKey.parse({
      format: 'power-evolve-legacy-ssh-key', version: 1, keyId: ssh.keyId, key: ssh.key, sourceCodeId: sourceIdentity.codeId })
    if (sshEvidence !== undefined) {
      await privateJson(join(root, 'ssh-original-key.json'), sshEvidence)
      await privateJson(join(root, 'ssh-source-capture.json'), capture)
    }
    const stdioEvidence = stdio === undefined ? undefined : legacyMigrationStdioEvidence.parse({
      format: 'power-evolve-legacy-stdio-inputs', version: 1, sourceCodeId: sourceIdentity.codeId,
      requests: stdio.records.map((record) => {
        const row = capture.tables.pe_stdio_mcp_updates?.find(item => item.user_id === record.userId
          && item.request_id === record.requestId.toLowerCase())
        if (!row) throw new Error('Owned original STDIO input row missing')
        return { userId: record.userId, requestId: row.request_id, input: record.input,
          sourceRowSha256: legacyRowDigest('pe_stdio_mcp_updates', row) }
      }) })
    if (stdioEvidence !== undefined) {
      await privateJson(join(root, 'stdio-original-inputs.json'), stdioEvidence)
      await privateJson(join(root, 'stdio-source-capture.json'), capture)
    }
    const stdioV2Policy = stdioV2 === undefined ? undefined : legacyMigrationStdioV2Policy.parse({
      format: 'power-evolve-legacy-stdio-v2-policy', version: 1, sourceCodeId: sourceIdentity.codeId,
      limits: stdioV2.limits, management: stdioV2.management })
    if (stdioV2Policy !== undefined) {
      await privateJson(join(root, 'stdio-v2-original-policy.json'), stdioV2Policy)
      await privateJson(join(root, 'stdio-v2-source-capture.json'), capture)
    }
    if (connector !== undefined) await privateJson(join(root, 'connector-source-capture.json'), capture)
    if (pristineMount !== undefined) await privateJson(join(root, 'pristine-mount-source-capture.json'), capture)
    const builtinEvidence = builtin === undefined ? undefined : legacyMigrationBuiltinEvidence.parse({
      format: 'power-evolve-legacy-builtin-skills', version: 1, sourceCodeId: sourceIdentity.codeId,
      catalogText: builtin.catalogText, catalogSha256: builtin.catalogSha256,
      releases: [{ catalogId: builtin.catalogId, version: builtin.version, manifestText: builtin.manifestText,
        archiveBase64: builtin.archiveBase64 }], requests: builtin.records.map((record) => {
        const row = capture.tables.pe_builtin_skill_install_requests?.find(item => item.user_id === record.userId
          && item.request_id === record.requestId)
        if (!row) throw new Error('Original built-in Skill install row missing')
        return { userId: record.userId, requestId: record.requestId,
          sourceRowSha256: legacyRowDigest('pe_builtin_skill_install_requests', row) }
      }) })
    if (builtinEvidence !== undefined) {
      await privateJson(join(root, 'builtin-original-evidence.json'), builtinEvidence)
      await privateJson(join(root, 'builtin-source-capture.json'), capture)
    }
    for (const [person, ref, seq] of [[alice, first, 1], [alice, late, includeImages ? 5 : 4], [bob, secondOwner, 1]] as const) {
      const row = capture.tables.pe_events?.find(row => row.session_id === person.session && row.seq === String(seq))
      if (!row) throw new Error('Owned original attachment event missing')
      attachmentSources.push({ userId: person.user, originSessionId: person.session, rootId: person.session,
        sourceRowSha256: legacyRowDigest('pe_events', row), file: ref })
    }
    if (alias !== undefined) {
      const row = capture.tables.pe_events?.find(item => item.session_id === alice.session && item.seq === '1')
      if (!row) throw new Error('Owned original aliased attachment event missing')
      attachmentSources.push({ userId: alice.user, originSessionId: alice.session, rootId: alice.session,
        sourceRowSha256: legacyRowDigest('pe_events', row), file: alias })
    }
    if (includeImages) for (const [index, person, seq] of [[0, alice, 1], [1, alice, 5], [2, bob, 1]] as const) {
      const row = capture.tables.pe_events?.find(row => row.session_id === person.session && row.seq === String(seq))
      const original = originalImages[index]
      if (!row || !original) throw new Error('Owned original image event missing')
      images.sources.push({ kind: 'image', userId: person.user, originSessionId: person.session,
        rootId: person.session, sourceRowSha256: legacyRowDigest('pe_events', row), imageIndex: 0, image: original.ref })
    }
    await writeFile(join(root, 'bundle', 'original.txt'), '原文件\0bytes\n', { flag: 'wx', mode: 0o640 })
    await chmod(join(root, 'bundle', 'original.txt'), 0o640)
    const original = await readFile(join(root, 'bundle', 'original.txt'))
    files.push({ area: 'workspace', owner: alice.user, resource: alice.workspace, path: 'original.txt', kind: 'file',
      sourcePath: 'original.txt', bytes: String(original.length), sha256: legacyDigest(original), mode: 0o640, uid, gid })
    await run({ root, source, readonly, target, capture, sourceUrl: readUrl, targetUrl, catalog, alice, bob, child,
      histories, attachmentSources, attachmentRoots, files,
      ...(includeImages ? { images: legacyMigrationImagesInput.parse(images) } : {}), originalImages,
      ...(accountOwners === undefined ? {} : { accountOwners }), ...(fixedMcp === undefined ? {} : { fixedMcp }),
      ...(storageOwners === undefined ? {} : { storageOwners }),
      ...(remoteMcp === undefined ? {} : { remoteMcp }), ...(mcpEvidence === undefined ? {} : { mcpEvidence }),
      ...(mcpActions === undefined ? {} : { mcpActions }), ...(office === undefined ? {} : { office }),
      ...(ssh === undefined ? {} : { ssh }), ...(sshEvidence === undefined ? {} : { sshEvidence }),
      ...(stdio === undefined ? {} : { stdio }), ...(stdioEvidence === undefined ? {} : { stdioEvidence }),
      ...(stdioV2 === undefined ? {} : { stdioV2 }), ...(stdioV2Policy === undefined ? {} : { stdioV2Policy }),
      ...(connector === undefined ? {} : { connector }), ...(builtin === undefined ? {} : { builtin }),
      ...(builtinEvidence === undefined ? {} : { builtinEvidence }), ...(stdioCall === undefined ? {} : { stdioCall }),
      ...(stdioCallEvidence === undefined ? {} : { stdioCallEvidence }),
      ...(cloudCancellation === undefined ? {} : { cloudCancellation }),
      ...(cloudCancellationEvidence === undefined ? {} : { cloudCancellationEvidence }),
      ...(stdioV2Cancellation === undefined ? {} : { stdioV2Cancellation }),
      ...(stdioNoStartEvidence === undefined ? {} : { stdioNoStartEvidence }),
      ...(pristineMount === undefined ? {} : { pristineMount }),
      ...(stoppedCreation === undefined ? {} : { stoppedCreation }),
      ...(stoppedCreationEvidence === undefined ? {} : { stoppedCreationEvidence }) })
  } finally {
    const pools = await Promise.allSettled([source.end(), readonly.end(), target.end()])
    try {
      if (pools.some(result => result.status === 'rejected')) throw new Error('Owned pools did not close')
      for (const database of acquired.databases.reverse()) await admin.query(`DROP DATABASE "${database}"`)
      for (const role of acquired.roles.reverse()) await admin.query(`DROP ROLE "${role}"`)
    } finally {
      await admin.end()
      const writableDirectories = async (path: string): Promise<void> => {
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) return
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await writableDirectories(join(path, name))
      }
      await writableDirectories(root)
      await rm(root, { recursive: true, force: true })
    }
  }
}

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

interface OwnedMaintenanceTask {
  signal: AbortSignal
  drain: MaintenanceDrain
  postgres?: MaintenancePg
  profile?: ReturnType<typeof maintenanceProcessGroup>
  profileStopped: boolean
  confirmCleanup: () => void
}

async function launch(root: string, request: object, outputName: string, expectedCode = 0, owner?: OwnedMaintenanceTask) {
  const ownerSignal = owner?.signal
  ownerSignal?.throwIfAborted()
  const moduleEntry = pathToFileURL(join(repo, 'products/power-evolve/application/src/platform/legacy-migration-v2-maintenance.ts')).href
  const override = process.env.PE_EMPLOYEE5_MAINTENANCE_ENTRY
  if (override !== undefined && override !== moduleEntry) throw new Error('Source maintenance cases require the current source entry')
  const coverageEnvironment = sourceSubprocessEnvironment()
  const environment = { ...process.env, ...coverageEnvironment }
  const home = join(root, `home-${outputName}`), profile = `employee5-${randomUUID()}`, directory = join(home, 'profiles', profile)
  const cli = ['dsh', '--profile', profile]
  if (coverageEnvironment.NODE_OPTIONS !== undefined) {
    cli.unshift(`--config.node-options=${coverageEnvironment.NODE_OPTIONS}`)
    delete environment.NODE_OPTIONS
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await privateJson(join(directory, 'package.json'), { name: `dsh-profile-${profile}`, private: true, type: 'module',
    dsh: { profile: { bundles: [] } }, dependencies: { '@power-evolve/application': `file:${join(repo, 'products/power-evolve/application')}` } })
  await mkdir(join(directory, 'node_modules', '@power-evolve'), { recursive: true, mode: 0o700 })
  await symlink(join(repo, 'products/power-evolve/application'), join(directory, 'node_modules', '@power-evolve', 'application'))
  const requestFile = join(root, `${outputName}-request.json`)
  await privateJson(requestFile, request)
  const processFile = join(root, `${outputName}-source-process.json`), witnessFile = join(directory, 'source-process-witness.mjs')
  await writeFile(witnessFile, `import {writeFileSync} from 'node:fs'\nimport {threadId} from 'node:worker_threads'\nexport const name='employee5-source-process-witness'\nexport function apply(){writeFileSync(${JSON.stringify(processFile)},JSON.stringify({pid:process.pid,threadId}),{flag:'wx',mode:0o600})}\n`, { mode: 0o600 })
  await writeFile(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: employee5-source-process\n      name: '${pathToFileURL(witnessFile).href}'\n    - id: employee5-maintenance\n      name: '${moduleEntry}'\n      config:\n        requestFile: '${requestFile}'\n        maxRequestBytes: 1048576\n        maxEvidenceBytes: 1048576\n        maxKeyBytes: 65536\n`, { mode: 0o600 })
  const stop = new AbortController(), deadline = setTimeout(() => { stop.abort() }, 60000)
  let output = '', processError: Error | undefined
  const cancelOwner = () => { stop.abort() }
  try {
    ownerSignal?.throwIfAborted()
    const child = spawn('pnpm', cli, { cwd: repo, env: { ...environment, DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1', npm_config_verify_deps_before_run: 'error' }, signal: stop.signal,
    detached: ownerSignal !== undefined, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('error', (error) => { processError = error })
    if (owner !== undefined) {
      owner.profileStopped = false
      owner.profile = maintenanceProcessGroup(child, stop.signal, owner.drain)
      ownerSignal!.addEventListener('abort', cancelOwner, { once: true })
      if (ownerSignal!.aborted) cancelOwner()
    }
    const result = owner !== undefined ? await owner.profile!.result : await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((done) => { child.once('close', (code, signal) => { done({ code, signal }) }) })
    if (owner !== undefined) owner.profileStopped = owner.profile!.stopped()
    let sourceProcess: z.infer<typeof sourceProcessSchema> | null = null
    let loadedSource: Awaited<ReturnType<typeof sourceLoadedWitness>> = null
    let sourceEvidenceError: unknown
    try {
      sourceProcess = sourceProcessSchema.parse(JSON.parse(await readFile(processFile, 'utf8')))
      loadedSource = await sourceLoadedWitness(coverageEnvironment, sourceProcess, moduleEntry)
    } catch (error) { sourceEvidenceError = error }
    const evidenceRoot = process.env.PE_EMPLOYEE5_PROFILE_EVIDENCE_DIR
    if (evidenceRoot) {
      const stat = await lstat(evidenceRoot)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error('Profile test evidence root must be an owned private directory')
      }
      const retained = await mkdtemp(join(evidenceRoot, `profile-${outputName}-`))
      await writeFile(join(retained, 'request.json'), await readFile(requestFile), { flag: 'wx', mode: 0o600 })
      await writeFile(join(retained, 'loader-output.log'), output, { flag: 'wx', mode: 0o600 })
      try {
        for (const name of await readdir(join(home, 'logs'))) if (name.startsWith('startup-') && name.endsWith('.log')) {
          await writeFile(join(retained, name), await readFile(join(home, 'logs', name)), { flag: 'wx', mode: 0o600 })
        }
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      let resultSha256: string | null = null
      try {
        const resultBytes = await readFile(join(root, `${outputName}-output.json`))
        resultSha256 = legacyDigest(resultBytes)
        await writeFile(join(retained, 'output.json'), resultBytes, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      for (const file of ['keys.json', 'cut.json', 'mcp-original-key.json', 'mcp-original-inputs.json',
        'mcp-source-capture.json', 'office-source-capture.json', 'ssh-original-key.json', 'ssh-source-capture.json',
        'stdio-original-inputs.json', 'stdio-source-capture.json', 'stdio-v2-original-policy.json', 'stdio-v2-source-capture.json',
        'connector-source-capture.json', 'builtin-original-evidence.json', 'builtin-source-capture.json',
        'stdio-call-original-evidence.json', 'stdio-call-source-capture.json',
        'cloud-cancel-original-evidence.json', 'cloud-cancel-source-capture.json',
        'stdio-v2-no-start-original-evidence.json', 'stdio-v2-no-start-source-capture.json',
        'pristine-mount-source-capture.json', 'original-pristine-mount-results.json',
        'stopped-creation-evidence.json', 'stopped-creation-capture.json', 'original-stopped-creation-results.json']) {
        try { await writeFile(join(retained, file), await readFile(join(root, file)), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
      let failureEvidence: unknown
      try {
        const bytes = await readFile(join(root, `${outputName}-failure.json`))
        failureEvidence = JSON.parse(bytes.toString())
        await writeFile(join(retained, 'failure.json'), bytes, { flag: 'wx', mode: 0o600 })
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      await privateJson(join(retained, 'launch.json'), { plane: 'source', cli: ['pnpm', ...cli], moduleEntry,
        childPid: child.pid ?? null,
        sourceProcess, loadedSource, sourceEvidenceFailed: sourceEvidenceError !== undefined,
        expectedCode, exitCode: result.code, signal: result.signal, timedOut: stop.signal.aborted, resultSha256,
        lockSha256: legacyDigest(await readFile(join(repo, 'pnpm-lock.yaml'))), requestSha256: legacyDigest(await readFile(requestFile)), failureEvidence })
    }
    expect(stop.signal.aborted, 'Profile exceeded its owned completion deadline').toBe(false)
    expect(child.pid, 'Source Profile must have an actual child PID').toBeGreaterThan(0)
    expect(result.signal, output).toBeNull()
    expect(processError, output).toBeUndefined()
    expect(result.code, output).toBe(expectedCode)
    if (sourceEvidenceError !== undefined) throw sourceEvidenceError
    if (expectedCode !== 0) return { exitCode: result.code, output }
    let completed: string
    try { completed = await readFile(join(root, `${outputName}-output.json`), 'utf8') }
    catch (error) { throw new Error(`Private Profile exited without its durable ${outputName} result: ${output}`, { cause: error }) }
    const body: unknown = JSON.parse(completed)
    return body
  } finally {
    clearTimeout(deadline)
    if (owner !== undefined && owner.profile !== undefined && !owner.profile.stopped()) {
      owner.drain.begin()
      await owner.drain.attempt('Profile cleanup join', 10000, () => owner.profile!.join())
      owner.profileStopped = owner.profile.stopped()
    }
    if (owner === undefined || owner.profileStopped) ownerSignal?.removeEventListener('abort', cancelOwner)
  }
}

function cutFor(f: {
  capture: LegacyMigrationCapture
  files: LegacyFileEntry[]
  attachmentSources: LegacyMigrationFileSource[]
  attachmentRoots: Record<string, string>
  images?: LegacyMigrationImagesInput
  mcpEvidence?: z.infer<typeof legacyMigrationMcpEvidence>
  sshEvidence?: z.infer<typeof legacyMigrationSshKey>
  stdioEvidence?: z.infer<typeof legacyMigrationStdioEvidence>
  stdioV2Policy?: z.infer<typeof legacyMigrationStdioV2Policy>
  builtinEvidence?: z.infer<typeof legacyMigrationBuiltinEvidence>
  stdioCallEvidence?: z.infer<typeof legacyMigrationStdioCallEvidence>
  cloudCancellationEvidence?: z.infer<typeof legacyMigrationCloudCancellationEvidence>
  stdioNoStartEvidence?: z.infer<typeof legacyMigrationStdioNoStartEvidence>
  stoppedCreationEvidence?: z.infer<typeof legacyMigrationStoppedCreationEvidence>
}) {
  return { version: 2 as const, snapshotId: f.capture.source.snapshotId, codeId: f.capture.source.codeId,
    stoppedAt: f.capture.source.stoppedAt, cut: f.capture.source.cut, catalogSha256: f.capture.catalogSha256,
    tablesSha256: legacyDigest(JSON.stringify(f.capture.tables)),
    filesSha256: legacyDigest(JSON.stringify({ files: f.files, attachmentSources: f.attachmentSources,
      attachmentSourceRoots: f.attachmentRoots, ...(f.images === undefined ? {} : { images: f.images }),
      ...(f.mcpEvidence === undefined ? {} : { mcpEvidenceSha256: legacyDigest(JSON.stringify(f.mcpEvidence)) }),
      ...(f.sshEvidence === undefined ? {} : { sshEvidenceSha256:
        createLegacyMigrationSshContext(f.sshEvidence, f.capture.source.codeId).evidenceSha256 }),
      ...(f.stdioEvidence === undefined ? {} : { stdioEvidenceSha256:
        createLegacyMigrationStdioContext(f.stdioEvidence, f.capture.source.codeId, budgets).evidenceSha256 }),
      ...(f.stdioV2Policy === undefined ? {} : { stdioV2EvidenceSha256:
        createLegacyMigrationStdioV2Context(f.stdioV2Policy, f.capture.source.codeId).evidenceSha256 }),
      ...(f.builtinEvidence === undefined ? {} : { builtinEvidenceSha256: legacyDigest(JSON.stringify(f.builtinEvidence)) }),
      ...(f.stdioCallEvidence === undefined ? {} : { stdioCallEvidenceSha256: legacyDigest(JSON.stringify(f.stdioCallEvidence)) }),
      ...(f.cloudCancellationEvidence === undefined ? {} : { cloudCancellationEvidenceSha256:
        legacyDigest(JSON.stringify(f.cloudCancellationEvidence)) }),
      ...(f.stdioNoStartEvidence === undefined ? {} : { stdioNoStartEvidenceSha256:
        legacyDigest(JSON.stringify(f.stdioNoStartEvidence)) }),
      ...(f.stoppedCreationEvidence === undefined ? {} : { stoppedCreationEvidenceSha256:
        legacyDigest(JSON.stringify(f.stoppedCreationEvidence)) }) })), kind: 'owned-fixture' as const }
}

async function migrateFixtureCurrent(f: Parameters<Parameters<typeof fixture>[0]>[0], outputName: string, expectedCode = 0,
  limits: LegacyImportLimits = budgets) {
  const request = { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits,
    phaseTimeoutMs: 30000, source: { purpose: 'offline-readonly-export', urlFile: join(f.root, 'source-url'),
      expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, identity: f.capture.source,
      batchRows: 2, statementTimeoutMs: 5000 }, mode: 'migrate', outputFile: join(f.root, `${outputName}-output.json`),
    failureEvidenceFile: join(f.root, `${outputName}-failure.json`), evidenceFile: join(f.root, 'cut.json'),
    trustedEvidenceKeysFile: join(f.root, 'keys.json'), histories: f.histories, attachmentSources: f.attachmentSources,
    attachmentSourceRoots: f.attachmentRoots, files: f.files, initializeCurrent: true,
    ...(f.remoteMcp === undefined ? {} : { mcp: { keyFile: join(f.root, 'mcp-original-key.json'),
      requestEvidenceFile: join(f.root, 'mcp-original-inputs.json') } }),
    ...(f.ssh === undefined ? {} : { ssh: { keyFile: join(f.root, 'ssh-original-key.json') } }),
    ...(f.stdio === undefined ? {} : { stdio: { requestEvidenceFile: join(f.root, 'stdio-original-inputs.json') } }),
    ...(f.stdioV2 === undefined ? {} : { stdioV2: { policyFile: join(f.root, 'stdio-v2-original-policy.json') } }),
    ...(f.builtin === undefined ? {} : { builtinSkills: { evidenceFile: join(f.root, 'builtin-original-evidence.json') } }),
    ...(f.stdioCall === undefined ? {} : { stdioCalls: { evidenceFile: join(f.root, 'stdio-call-original-evidence.json') } }),
    ...(f.cloudCancellation === undefined ? {} : { cloudCancellation: { evidenceFile: join(f.root, 'cloud-cancel-original-evidence.json') } }),
    ...(f.stdioV2Cancellation === undefined ? {} : { stdioNoStart: { evidenceFile: join(f.root, 'stdio-v2-no-start-original-evidence.json') } }),
    ...(f.stoppedCreation === undefined ? {} : { stoppedCreation: { evidenceFile: join(f.root, 'stopped-creation-evidence.json') } }),
    target: { urlFile: join(f.root, 'target-url'), expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000 },
    storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'), sourceUid: process.getuid?.(),
      ...(f.stoppedCreation === undefined ? {} : { sourceOwners: [{ uid: process.getuid?.(), gid: process.getgid?.() },
        { uid: f.stoppedCreation.upload.home.uid, gid: f.stoppedCreation.upload.home.gid }] }),
      sourceGid: process.getgid?.(), targetUid: process.getuid?.(), targetGid: process.getgid?.() } }
  await writeFile(join(f.root, 'source-url'), f.sourceUrl.href, { flag: 'wx', mode: 0o600 })
  await writeFile(join(f.root, 'target-url'), f.targetUrl.href, { flag: 'wx', mode: 0o600 })
  const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cutFor(f))
  await privateJson(join(f.root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixture-key',
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
  await privateJson(join(f.root, 'cut.json'), { keyId: 'owned-fixture-key', payload,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
  return launch(f.root, request, outputName, expectedCode)
}

async function verifyAttachmentBackup(root: string, original: string, restored: string, imagePaths: readonly string[]) {
  const script = join(root, 'owned-attachment-backup.mjs')
  await writeFile(script, `import { inventoryTree, copyTree } from ${JSON.stringify(
    pathToFileURL(join(repo, 'products/power-evolve/deploy/backup-tree.mjs')).href)}
const original = process.argv[2], restored = process.argv[3]
const inventory = await inventoryTree(original, true)
await copyTree(original, restored, inventory)
const copy = await inventoryTree(restored, true)
if (JSON.stringify(copy) !== JSON.stringify(inventory)) throw new Error('Restored attachment inventory changed')
const imagePaths = new Set(JSON.parse(process.argv[4]))
if ([...imagePaths].some(path => !inventory.some(entry => entry.path === path && entry.kind === 'file')))
  throw new Error('Original SDK image object missing from attachment backup')
console.log(JSON.stringify({ images: imagePaths.size,
  hardlinks: inventory.filter(entry => entry.kind === 'hardlink').length, entries: inventory.length }))
`, { flag: 'wx', mode: 0o600 })
  let output = '', errors = ''
  const child = spawn('node', [script, original, restored, JSON.stringify(imagePaths)], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
  expect(code, errors).toBe(0)
  return z.object({ images: z.number().int(), hardlinks: z.number().int(), entries: z.number().int() }).strict().parse(JSON.parse(output))
}

test('readonly Schema37 capture retains raw JSON, forks and complete original inventory', async () => {
  await fixture(async (f) => {
    expect(Object.keys(f.capture.tables)).toHaveLength(77)
    expect(f.capture.tables.pe_events?.some(row => row.event?.includes('1e0'))).toBe(true)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    expect(receipts).toHaveLength(4)
    expect(receipts.filter(receipt => receipt.sessionId === f.child)).toMatchObject([{ storageSessionId: f.alice.session,
      authority: 'verified-history-migration', referencedEventSeqs: [1] }])
    const cut = cutFor(f)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets)
    expect(plan.rows.find(row => row.table === 'pe_events')?.sourceSha256).toBe(
      legacyRowDigest('pe_sessions', f.capture.tables.pe_sessions?.find(row => row.id === plan.rows.find(row => row.table === 'pe_events')?.values.session_id) ?? {}))
    await expect(captureLegacyMigrationSource(f.source, f.capture.source, { purpose: 'offline-readonly-export', expectedDatabase: f.sourceUrl.pathname.slice(1),
      expectedCatalogSha256: f.catalog, batchRows: 2, statementTimeoutMs: 5000, limits: budgets },
    new AbortController().signal))
      .rejects.toMatchObject({ code: 'capture_source_identity' })
    expect((await f.target.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0]?.count).toBe('0')
  })
})

test('actual private dsh Profile captures then migrates schema2 to current and ordinary services read preserved history/files', async () => {
  await fixture(async (f) => {
    await writeFile(join(f.root, 'source-url'), f.sourceUrl.href, { flag: 'wx', mode: 0o600 })
    await writeFile(join(f.root, 'target-url'), f.targetUrl.href, { flag: 'wx', mode: 0o600 })
    const common = { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
      phaseTimeoutMs: 30000, source: { purpose: 'offline-readonly-export', urlFile: join(f.root, 'source-url'),
        expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, identity: f.capture.source,
        batchRows: 2, statementTimeoutMs: 5000 } }
    const captured = await launch(f.root, { ...common, mode: 'capture', outputFile: join(f.root, 'capture-output.json') }, 'capture')
    expect(captured).toMatchObject({ phase: 'captured', systemMigrationComplete: false, capture: { tables: f.capture.tables } })
    expect((await f.target.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0]?.count).toBe('0')
    const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cutFor(f))
    await privateJson(join(f.root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixture-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(f.root, 'cut.json'), { keyId: 'owned-fixture-key', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    const uid = process.getuid?.(), gid = process.getgid?.()
    const result = await launch(f.root, { ...common, mode: 'migrate', outputFile: join(f.root, 'migrate-output.json'),
      evidenceFile: join(f.root, 'cut.json'), trustedEvidenceKeysFile: join(f.root, 'keys.json'), histories: f.histories,
      attachmentSources: f.attachmentSources, attachmentSourceRoots: f.attachmentRoots, files: f.files, initializeCurrent: true,
      target: { urlFile: join(f.root, 'target-url'), expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'), sourceUid: uid, sourceGid: gid,
        targetUid: uid, targetGid: gid } }, 'migrate')
    const imported = z.object({
      receipts: z.array(z.object({ sessionId: z.uuid(), file: nativeFileAttachment }).loose()),
    }).loose().parse(result)
    expect(imported).toMatchObject({ phase: 'current-schema-initialized', family: 'cloud-native', version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect((await f.target.query('SELECT family,version FROM pe_schema')).rows)
      .toEqual([{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
    expect((await f.target.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_file_receipts')).rows[0]?.count).toBe('4')
    expect((await f.target.query<{ count: string }>('SELECT count(*)::text AS count FROM pe_native_presentation_entries')).rows[0]?.count).toBe('0')
    expect((await readFile(join(f.root, 'candidate', 'migration-source-v2.json'), 'utf8')).includes('1e0')).toBe(true)
    expect((await lstat(join(f.root, 'candidate', 'migration-source-v2.json'))).mode & 0o077).toBe(0)
    const identities = new IdentityService(f.target, 60000)
    const alice = await identities.login('migration-alice', password), bob = await identities.login('migration-bob', password)
    expect(alice.user).toEqual(identity.parse({ userId: f.alice.user, username: 'migration-alice' }))
    const reads = new NativeSessionRead(f.target)
    expect((await reads.list(alice.user)).items.map(item => item.sessionId).sort())
      .toEqual(f.histories.filter(item => item.sessionId !== f.bob.session).map(item => item.sessionId).sort())
    const frame = await reads.snapshot(alice.user, { address: { kind: 'session', sessionId: sessionId.parse(f.alice.session) }, maxMessages: 10 })
    expect(frame.cursor).toBe(6)
    const page = await reads.page(alice.user, { address: { kind: 'session', sessionId: sessionId.parse(f.alice.session) },
      throughSeq: frame.cursor, maxMessages: 1 })
    expect(page.hasMore).toBe(true)
    expect(page.records.some(record => record.event.seq === 4 && record.event.type === 'user/message')).toBe(true)
    expect(await reads.after(alice.user, sessionId.parse(f.alice.session), -1)).toHaveLength(7)
    await expect(reads.after(bob.user, sessionId.parse(f.alice.session), -1)).rejects.toMatchObject({ code: 'session_not_found' })
    const commands = new NativeSessionCommands(f.target, commandLimits)
    const tasks = new TaskStore(f.target, taskLimits), events = new EventStore(tasks, commandLimits), files = new FileService(f.target, join(f.root, 'candidate', 'workspaces'))
    await files.init()
    const attachments = new NativeAttachments(f.target, tasks, files, { root: join(f.root, 'candidate', 'attachments'),
      maxFilesPerSession: 100, maxFilesPerUser: 100, maxBytesPerUser: 262144 }); await attachments.init()
    const childReceipt = imported.receipts.find((receipt: { sessionId: string }) => receipt.sessionId === f.child)
    if (!childReceipt) throw new Error('Migration child authority missing')
    for (const id of [f.alice.session, f.child]) {
      const request = requestId.parse(randomUUID())
      await tasks.accept(alice.user, sessionId.parse(id), request, 'read old file', alice.token)
      const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('New current operation missing')
      expect(grant.attachments).toContainEqual(childReceipt.file)
      expect(await attachments.readText(grant.token, childReceipt.file, 1, 1)).toMatchObject({ text: 'First original' })
      await attachments.copy(grant.token, childReceipt.file, randomUUID(), `copy-${id}.txt`)
      expect(Buffer.from((await files.read(alice.user, `copy-${id}.txt`)).data, 'base64').toString()).toBe('First original\n第二行\n')
      const past = await reads.after(alice.user, sessionId.parse(id), -1)
      const header = headerSchema.parse((await f.target.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [id])).rows[0]?.header)
      const inherited = header.isSeeded ? past.findLastIndex(event => event.type === 'session/end-seed' && event.data.inherited) : 0
      const restored = Session.fromRestore(header.id, past, header, SessionLogOffset(inherited), 'detached')
      const turn = past.reduce((maximum, event) => event.type === 'turn/start' ? Math.max(maximum, event.data.turn) : maximum, 0) + 1
      restored.append('turn/start', { turn })
      restored.append('user/message', { id: MessageId(request), role: 'user', content: [{ type: 'text', text: grant.text }],
        source: { kind: 'user' } }, { surfaceOp: 'append' })
      restored.append('turn/end', { turn, reason: { kind: 'completed' } })
      const suffix = restored.snapshotEvents().slice(past.length)
      const expectedTypes = past.at(-1)?.type === 'session/end-seed'
        ? ['turn/start', 'user/message', 'turn/end'] : ['session/end-seed', 'turn/start', 'user/message', 'turn/end']
      expect(suffix.map(event => event.type)).toEqual(expectedTypes)
      expect(suffix.map(event => event.seq)).toEqual(expectedTypes.map((_, index) => past.length + index))
      expect(await events.append(grant.token, suffix)).toEqual({ eventCount: past.length + expectedTypes.length })
      expect(await reads.after(alice.user, sessionId.parse(id), past.length - 1)).toEqual(suffix)
      await tasks.finish(grant.token, 'completed', null)
    }
    await tasks.accept(bob.user, sessionId.parse(f.bob.session), requestId.parse(randomUUID()), 'foreign file', bob.token)
    const bobGrant = await tasks.claim(randomUUID()); if (!bobGrant) throw new Error('New current Bob operation missing')
    await expect(attachments.readText(bobGrant.token, childReceipt.file, 1, 1)).rejects.toMatchObject({ code: 'attachment_not_found' })
    await tasks.finish(bobGrant.token, 'completed', null)
    expect(await readFile(storedFilePath(join(f.root, 'candidate', 'attachments', f.alice.user, f.alice.session), childReceipt.file)))
      .toEqual(Buffer.from('First original\n第二行\n'))
    expect(await readFile(join(f.root, 'candidate', 'workspaces', f.alice.workspace, 'original.txt'))).toEqual(Buffer.from('原文件\0bytes\n'))
    expect((await commands.search(alice.user, '旧记录')).items.length).toBe(2)
  }, true)
}, 120000)

test.each([0, 1, 2, 3])('real Schema37 physical v%i parent/seed history uses maintained adjacent migrations', async (version) => {
  await fixture(async (f) => {
    const { parent, child } = await seedHistorical(f.source, f.alice, version)
    const captured = await captureLegacyMigrationSource(f.readonly, f.capture.source, { purpose: 'offline-readonly-export',
      expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, batchRows: 2, statementTimeoutMs: 5000,
      limits: budgets },
    new AbortController().signal)
    const declaration: LegacyHistoryStorage[] = [...f.histories, { sessionId: parent, encoding: 'released-physical' },
      { sessionId: child, encoding: 'released-physical' }]
    const original = JSON.stringify(captured)
    const migrated = migrateLegacyHistories(captured, declaration, budgets)
    const seeded = migrated.find(history => history.sessionId === child), ordinary = migrated.find(history => history.sessionId === parent)
    expect(seeded?.header).toMatchObject({ version: 4, isSeeded: true, parentSession: parent, cwd: '/owned-old-cwd',
      agentPreset: version < 3 ? 'ptc' : 'code' })
    expect(seeded?.inheritedEventCount).toBe(2)
    expect(seeded?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(seeded?.events.filter(event => event.type === 'agent-preset/selected').map(event => event.data))
      .toEqual((version < 3 ? ['ptc', 'standard', 'ptc', 'minimal', 'ptc'] : ['code', 'standard', 'code', 'minimal', 'code'])
        .map(agentPreset => ({ agentPreset })))
    expect(seeded?.events.slice(0, 2)).toEqual(ordinary?.events.slice(0, 2))
    expect(seeded?.coordinates.some(coordinate => coordinate.stage === `decode-v${version}`)).toBe(true)
    expect(JSON.stringify(captured)).toBe(original)
    expect(() => migrateLegacyHistories(captured, declaration, { ...budgets, maxRows: 2 })).toThrow('history_target_event_budget')
  })
})

test('a nonempty retained table without its current owner adapter rejects before target writes', async () => {
  await fixture(async (f) => {
    await insert(f.source, 'pe_connector_permissions', { user_id: f.alice.user, capability: 'trial_note_query', enabled: 'true' })
    const captured = await captureLegacyMigrationSource(f.readonly, f.capture.source, { purpose: 'offline-readonly-export',
      expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, batchRows: 2, statementTimeoutMs: 5000,
      limits: budgets },
    new AbortController().signal)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(captured, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const cut = cutFor({ ...f, capture: captured })
    const retained = prepareLegacyMigration(migrationId, captured, histories, receipts, f.files, cut.filesSha256, cut, budgets)
    expect(retained.rows.find(row => row.table === 'pe_connector_permissions')?.values)
      .toEqual(captured.tables.pe_connector_permissions?.[0])
    // The default connector owner retains this row; simulate its absence only during synchronous planning.
    const connectorOwner = vi.spyOn(await import('../src/platform/legacy-migration-v2-connectors.ts'), 'validateLegacyMigrationConnector')
      .mockReturnValue(false)
    try {
      expect(() => prepareLegacyMigration(migrationId, captured, histories, receipts, f.files, cut.filesSha256, cut, budgets))
        .toThrow('migration_row_owner_adapter_missing: pe_connector_permissions')
    } finally {
      connectorOwner.mockRestore()
    }
    expect(captured.tables.pe_connector_permissions).toHaveLength(1)
    expect((await f.target.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0]?.count).toBe('0')
  })
})

test('the actual maintenance Profile rejects an unsigned cut with exit1 and leaves target and candidate absent', async () => {
  await fixture(async (f) => {
    await writeFile(join(f.root, 'source-url'), f.sourceUrl.href, { flag: 'wx', mode: 0o600 })
    await writeFile(join(f.root, 'target-url'), f.targetUrl.href, { flag: 'wx', mode: 0o600 })
    const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cutFor(f))
    await privateJson(join(f.root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixture-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(f.root, 'cut.json'), { keyId: 'owned-fixture-key', payload, signature: Buffer.alloc(64).toString('base64') })
    const outcome = await launch(f.root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(),
      mode: 'migrate', limits: budgets, phaseTimeoutMs: 30000, outputFile: join(f.root, 'unsigned-output.json'),
      source: { purpose: 'offline-readonly-export', urlFile: join(f.root, 'source-url'), expectedDatabase: f.sourceUrl.pathname.slice(1),
        expectedCatalogSha256: f.catalog, identity: f.capture.source, batchRows: 2, statementTimeoutMs: 5000 },
      evidenceFile: join(f.root, 'cut.json'), trustedEvidenceKeysFile: join(f.root, 'keys.json'), histories: f.histories,
      attachmentSources: f.attachmentSources, attachmentSourceRoots: f.attachmentRoots, files: f.files, initializeCurrent: true,
      target: { urlFile: join(f.root, 'target-url'), expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'), sourceUid: process.getuid?.(),
        sourceGid: process.getgid?.(), targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'unsigned', 1)
    expect(outcome).toMatchObject({ exitCode: 1 })
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(f.root, 'unsigned-output.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.target.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0]?.count).toBe('0')
  })
})

test('capture rejects a changed catalog and missing session representation without target publication', async () => {
  await fixture(async (f) => {
    await expect(captureLegacyMigrationSource(f.readonly, f.capture.source, { purpose: 'offline-readonly-export',
      expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: '0'.repeat(64), batchRows: 2,
      statementTimeoutMs: 5000, limits: budgets }, new AbortController().signal)).rejects.toMatchObject({ code: 'capture_source_catalog' })
    expect(() => migrateLegacyHistories(f.capture, f.histories.slice(1), budgets)).toThrow('history_storage_inventory')
    const cancelled = new AbortController(); cancelled.abort()
    await expect(captureLegacyMigrationSource(f.readonly, f.capture.source, { purpose: 'offline-readonly-export',
      expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, batchRows: 2,
      statementTimeoutMs: 5000, limits: budgets }, cancelled.signal)).rejects.toHaveProperty('name', 'AbortError')
  })
})

test('the public maintenance Profile preserves original images and offload decisions for lease-fenced SDK consumers', async () => {
  await fixture(async (f) => {
    if (!f.images) throw new Error('Owned image inventory missing')
    const first = f.originalImages[0], later = f.originalImages[1], foreign = f.originalImages[2]
    if (!first || !later || !foreign) throw new Error('Owned original images missing')
    const sourceDigests = f.originalImages.map(stored => legacyDigest(stored.data))
    await writeFile(join(f.root, 'source-url'), f.sourceUrl.href, { flag: 'wx', mode: 0o600 })
    await writeFile(join(f.root, 'target-url'), f.targetUrl.href, { flag: 'wx', mode: 0o600 })
    const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cutFor(f))
    await privateJson(join(f.root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixture-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(f.root, 'cut.json'), { keyId: 'owned-fixture-key', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    const result = await launch(f.root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(),
      limits: budgets, phaseTimeoutMs: 30000, source: { purpose: 'offline-readonly-export', urlFile: join(f.root, 'source-url'),
        expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, identity: f.capture.source,
        batchRows: 2, statementTimeoutMs: 5000 }, mode: 'migrate', outputFile: join(f.root, 'images-output.json'),
      failureEvidenceFile: join(f.root, 'images-failure.json'),
      evidenceFile: join(f.root, 'cut.json'), trustedEvidenceKeysFile: join(f.root, 'keys.json'), histories: f.histories,
      attachmentSources: f.attachmentSources, attachmentSourceRoots: f.attachmentRoots, files: f.files, images: f.images,
      initializeCurrent: true, target: { urlFile: join(f.root, 'target-url'), expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'), sourceUid: process.getuid?.(), sourceGid: process.getgid?.(),
        targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'images')
    const imported = z.object({ images: z.array(legacyMigrationImageBinding) }).loose().parse(result)
    expect(imported).toMatchObject({ phase: 'current-schema-initialized', family: 'cloud-native', version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(imported.images).toHaveLength(4)
    expect(imported.images.filter(binding => binding.sessionId === f.child))
      .toMatchObject([{ image: first.ref, occurrences: [{ seq: 1, imageIndex: 0 }] }])
    expect(imported.images.every(binding => !('requestId' in binding) && !('receiptId' in binding))).toBe(true)
    expect((await f.target.query('SELECT family,version FROM pe_schema')).rows)
      .toEqual([{ family: 'cloud-native', version: CURRENT_SCHEMA_VERSION }])
    const identities = new IdentityService(f.target, 60000)
    const alice = await identities.login('migration-alice', password), bob = await identities.login('migration-bob', password)
    const tasks = new TaskStore(f.target, taskLimits), reads = new NativeSessionRead(f.target)
    const originalRoot = join(f.root, 'candidate', 'attachments'), restoredRoot = join(f.root, 'restored-attachments')
    const usage = await nativeAttachmentUsage(originalRoot, alice.user.userId, budgets.maxFiles, new AbortController().signal)
    expect(usage.files).toBe(4)
    expect(usage.bytes).toBe([...f.attachmentSources.filter(source => source.userId === f.alice.user).map(source => source.file.bytes),
      first.ref.bytes, later.ref.bytes].reduce((sum, bytes) => sum + bytes, 0))
    const imagePaths = await Promise.all(f.images.sources.map(async source => relative(originalRoot, (await legacyImageLocation(
      join(originalRoot, source.userId, source.originSessionId), source.image)).path)))
    expect(await verifyAttachmentBackup(f.root, originalRoot, restoredRoot, imagePaths)).toMatchObject({ images: 3, hardlinks: 3 })
    await expect(lstat(join(f.root, 'candidate', 'legacy-images'))).rejects.toMatchObject({ code: 'ENOENT' })
    const reader = new LegacyMigrationImageReader(f.target, tasks, { root: originalRoot,
      maxImageBytes: budgets.maxFileBytes, maxImagePixels: 16, maxLedgerBytes: budgets.maxCellBytes })
    const restoredReader = new LegacyMigrationImageReader(f.target, tasks, { root: restoredRoot,
      maxImageBytes: budgets.maxFileBytes, maxImagePixels: 16, maxLedgerBytes: budgets.maxCellBytes })
    const rootCtx = new Context()
    const respond = async (req: IncomingMessage, res: ServerResponse) => {
      const signal = new AbortController()
      res.on('close', () => { signal.abort() })
      try {
        if (req.method !== 'POST' || req.url !== '/runtime/attachments/image') throw new Error('Unexpected owned runtime endpoint')
        const input = z.object({ image: legacyMigrationImage }).strict().parse(await readJson(req, 4096))
        const stored = await reader.read((req.headers.authorization ?? '').slice('Bearer '.length), input.image, signal.signal)
        sendJson(res, { image: stored.ref, data: Buffer.from(stored.data).toString('base64') })
      } catch (error) { sendFailure(res, error) }
    }
    const server = createServer((req, res) => { void respond(req, res) })
    await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Owned runtime listener missing')
    const runtime = new RuntimeScope(rootCtx, { platformUrl: `http://127.0.0.1:${address.port}`, workerTokenFile: join(f.root, 'unused-worker-token'),
      workerId: randomUUID(),
      timeoutMs: 5000, maxResponseBytes: 262144, nativePublicationMaxQueueItems: 16, nativePublicationMaxQueueBytes: 262144,
      nativePublicationMaxBatchItems: 16, nativePublicationMaxBatchBytes: 262144, nativePublicationMaxItemBytes: 65536,
      nativeIntentReconcileLimit: 32, nativeIntentMaxLocalReceipts: 65536 })
    const host = new LegacyMigrationHostImages(rootCtx, runtime, { cacheRoot: join(f.root, 'request-images'), imageLimits: {
      maxImageBytes: 65536, maxImagesPerMessage: 4, maxMessageImageBytes: 262144, maxImagePixels: 16,
      maxImageDimension: 4, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } })
    try {
      await expect(rootCtx.attachments.readImage(first.ref)).rejects.toMatchObject({ code: 'session_not_leased' })
      for (const id of [f.alice.session, f.child]) {
        const past = await reads.after(alice.user, sessionId.parse(id), -1)
        expect(past.some(event => event.type === 'image/offload')).toBe(true)
        const header = headerSchema.parse((await f.target.query<{ header: unknown }>('SELECT header FROM pe_sessions WHERE id=$1', [id])).rows[0]?.header)
        const inherited = header.isSeeded ? past.findIndex(event => event.type === 'session/end-seed') : 0
        const restored = Session.fromRestore(header.id, past, header, SessionLogOffset(inherited), 'detached', [imageOffloadProjection])
        const originalMessage = past.find(event => event.seq === 1)
        if (originalMessage?.type !== 'user/message') throw new Error('Original image message missing')
        expect(originalMessage.data.content.find(block => block.type === 'image')).toEqual({ type: 'image', attachment: first.ref })
        const messages = restored.deriveMessages(), offloaded = messages.flatMap(message => message.content).find(block => block.type === 'image' && block.offloaded)
        expect(offloaded).toEqual({ type: 'image', attachment: first.ref, offloaded: true })
        expect(projectOffloadedImages(messages, offloadedImageText).flatMap(message => message.content))
          .toContainEqual({ type: 'text', text: offloadedImageText(first.ref) })
        await tasks.accept(alice.user, sessionId.parse(id), requestId.parse(randomUUID()), 'read migrated image', alice.token)
        const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Owned image grant missing')
        runtime.grants.set(grant.sessionId, grant)
        const scope = createScope(rootCtx, {})
        host.bind(scope.ctx, grant)
        try {
          const stored = await scope.ctx.attachments.readImage(first.ref)
          expect(stored.ref).toEqual(first.ref); expect(Buffer.from(stored.data)).toEqual(Buffer.from(first.data))
          expect(await reader.read(grant.token, { ...first.ref }, new AbortController().signal)).toEqual(first)
          expect(await restoredReader.read(grant.token, first.ref, new AbortController().signal)).toEqual(first)
          await expect(scope.ctx.attachments.readImage(foreign.ref)).rejects.toMatchObject({ code: 'legacy_image_not_found' })
          if (id === f.child) await expect(scope.ctx.attachments.readImage(later.ref)).rejects.toMatchObject({ code: 'legacy_image_not_found' })
          else expect(Buffer.from((await scope.ctx.attachments.readImage(later.ref)).data)).toEqual(Buffer.from(later.data))
          const target = { width: 1, height: 1, maxBytes: 1024 }
          const variant = await scope.ctx.attachments.readImageRequest(first.ref, target)
          expect(variant.attachment).toEqual(first.ref)
          expect(await scope.ctx.attachments.readImageRequest(first.ref, target)).toEqual(variant)
          await expect(scope.ctx.attachments.readImageRequest(first.ref, { ...target, width: 5 })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
          await tasks.finish(grant.token, 'completed', null)
          await expect(reader.read(grant.token, first.ref, new AbortController().signal)).rejects.toMatchObject({ code: 'lease_lost' })
          runtime.grants.delete(grant.sessionId)
          await expect(scope.ctx.attachments.readImage(first.ref)).rejects.toMatchObject({ code: 'lease_lost' })
          await tasks.accept(alice.user, sessionId.parse(id), requestId.parse(randomUUID()), 'successor image grant', alice.token)
          const successorGrant = await tasks.claim(randomUUID())
          if (!successorGrant) throw new Error('Owned successor image grant missing')
          runtime.grants.set(successorGrant.sessionId, successorGrant)
          const successor = createScope(rootCtx, {})
          host.bind(successor.ctx, successorGrant)
          try {
            await expect(scope.ctx.attachments.readImageRequest(first.ref, target)).rejects.toMatchObject({ code: 'lease_lost' })
            expect(Buffer.from((await successor.ctx.attachments.readImage(first.ref)).data)).toEqual(Buffer.from(first.data))
            await tasks.finish(successorGrant.token, 'completed', null)
          } finally { runtime.grants.delete(successorGrant.sessionId); await successor.dispose() }
        } finally { runtime.grants.delete(grant.sessionId); await scope.dispose() }
      }
      await tasks.accept(bob.user, sessionId.parse(f.bob.session), requestId.parse(randomUUID()), 'own image', bob.token)
      const grant = await tasks.claim(randomUUID()); if (!grant) throw new Error('Owned Bob image grant missing')
      expect(Buffer.from((await reader.read(grant.token, foreign.ref, new AbortController().signal)).data))
        .toEqual(Buffer.from(foreign.data))
      await expect(reader.read(grant.token, first.ref, new AbortController().signal)).rejects.toMatchObject({ code: 'legacy_image_not_found' })
      await tasks.finish(grant.token, 'completed', null)
      const fork = await new NativeSessionCommands(f.target, commandLimits).fork(alice.user, alice.token,
        { sessionId: sessionId.parse(f.alice.session), atSeq: SessionSeq(3) }, requestId.parse(randomUUID()))
      const inherited = await f.target.query<{ value: unknown }>('SELECT value FROM pe_native_preferences WHERE user_id=$1 AND namespace=$2',
        [alice.user.userId, `legacy-migration-v2-images:${fork.sessionId}`])
      expect(inherited.rowCount, 'Ordinary NativeSessionCommands.fork must copy only its image prefix permissions').toBe(1)
      await tasks.accept(alice.user, fork.sessionId, requestId.parse(randomUUID()), 'inherited image', alice.token)
      const forkGrant = await tasks.claim(randomUUID()); if (!forkGrant) throw new Error('Owned new fork grant missing')
      expect(Buffer.from((await reader.read(forkGrant.token, first.ref, new AbortController().signal)).data))
        .toEqual(Buffer.from(first.data))
      await expect(reader.read(forkGrant.token, later.ref, new AbortController().signal)).rejects.toMatchObject({ code: 'legacy_image_not_found' })
      await tasks.finish(forkGrant.token, 'completed', null)
      for (const source of f.images.sources) {
        const location = await legacyImageLocation(f.images.sourceHomes[source.rootId] ?? '', source.image)
        expect(legacyDigest(await readFile(location.path))).toBe(sourceDigests[f.images.sources.indexOf(source)])
      }
    } finally {
      await rootCtx.fiber.dispose()
      await new Promise<void>((done, reject) => { server.close((error) => { if (error) reject(error); else done() }) })
    }
  }, false, true)
})

test('image declarations require original owner, ancestor prefix, row and occurrence; invalid offload decisions refuse history', async () => {
  await fixture(async (f) => {
    if (!f.images) throw new Error('Owned image inventory missing')
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), sources = f.images.sources
    expect(() => planLegacyHistoryImages(randomUUID(), histories, [])).toThrow('history_image_source_unqualified')
    expect(() => planLegacyHistoryImages(randomUUID(), histories, [...sources, ...sources])).toThrow('history_image_source_unqualified')
    expect(() => planLegacyHistoryImages(randomUUID(), histories, sources.map((source, index) => index === 0
      ? { ...source, userId: f.bob.user } : source))).toThrow('history_image_source_unqualified')
    expect(() => planLegacyHistoryImages(randomUUID(), histories, sources.map((source, index) => index === 0
      ? { ...source, imageIndex: 1 } : source))).toThrow('history_image_source_unqualified')
    const parent = histories.find(history => history.sessionId === f.alice.session)
    if (!parent) throw new Error('Owned image parent missing')
    const events = parseEvents(parent.header, parent.events).map(event => event.type === 'image/offload'
      ? { ...event, data: { targets: [{ seq: SessionSeq(1), imageIndexes: [0, 0] }] } } : event)
    expect(() => Session.fromRestore(parent.header.id, events, parent.header, SessionLogOffset(0), 'detached', [imageOffloadProjection]))
      .toThrow('strictly increasing')
  }, false, true)
})

test('original image bytes and metadata are bounded and verified before candidate publication', async () => {
  await fixture(async (f) => {
    if (!f.images) throw new Error('Owned image inventory missing')
    const image = f.originalImages[0]?.ref
    if (!image) throw new Error('Owned original image missing')
    const home = f.images.sourceHomes[f.alice.session]
    if (!home) throw new Error('Owned source home missing')
    const signal = new AbortController().signal, destination = join(f.root, 'candidate')
    await expect(readLegacyOriginalImage(home, { ...image, bytes: budgets.maxFileBytes + 1 }, destination, budgets, signal))
      .rejects.toMatchObject({ code: 'history_image_budget' })
    await expect(readLegacyOriginalImage(home, { ...image, width: image.width + 1 }, destination, budgets, signal))
      .rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    const location = await legacyImageLocation(home, image), original = await readFile(location.path)
    await chmod(location.path, 0o600)
    await writeFile(location.path, Buffer.alloc(original.length, 1))
    await expect(readLegacyOriginalImage(home, image, destination, budgets, signal)).rejects.toMatchObject({ code: 'history_image_digest' })
    await writeFile(location.path, original)
    await chmod(location.path, 0o400)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const bindings = planLegacyHistoryImages(migrationId, histories, f.images.sources)
    const narrow = { ...budgets, maxStorageBytes: f.originalImages.reduce((sum, stored) => sum + stored.ref.bytes, 0) }
    const cut = cutFor(f)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, narrow, bindings)
    await expect(writeLegacyMigration(f.target, plan, { expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000,
      attachmentSourceRoots: f.attachmentRoots, imageSourceHomes: f.images.sourceHomes, maxImagePixels: 16,
      storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: destination, sourceUid: process.getuid?.() ?? -1,
        sourceGid: process.getgid?.() ?? -1, targetUid: process.getuid?.() ?? -1, targetGid: process.getgid?.() ?? -1 } }, signal))
      .rejects.toMatchObject({ code: 'migration_storage_budget' })
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.target.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rowCount).toBe(0)
  }, false, true)
})

test('schema4 maintenance preserves nonempty account owners and ordinary services replay only their original metadata', async () => {
  await fixture(async (f) => {
    const owned = f.accountOwners
    if (!owned) throw new Error('Owned account mutation inventory missing')
    const request = { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
      phaseTimeoutMs: 30000, source: { purpose: 'offline-readonly-export', urlFile: join(f.root, 'source-url'),
        expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, identity: f.capture.source,
        batchRows: 2, statementTimeoutMs: 5000 }, mode: 'migrate', outputFile: join(f.root, 'accounts-output.json'),
      failureEvidenceFile: join(f.root, 'accounts-failure.json'), evidenceFile: join(f.root, 'cut.json'),
      trustedEvidenceKeysFile: join(f.root, 'keys.json'), histories: f.histories, attachmentSources: f.attachmentSources,
      attachmentSourceRoots: f.attachmentRoots, files: f.files, initializeCurrent: true,
      target: { urlFile: join(f.root, 'target-url'), expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'), sourceUid: process.getuid?.(),
        sourceGid: process.getgid?.(), targetUid: process.getuid?.(), targetGid: process.getgid?.() } }
    await writeFile(join(f.root, 'source-url'), f.sourceUrl.href, { flag: 'wx', mode: 0o600 })
    await writeFile(join(f.root, 'target-url'), f.targetUrl.href, { flag: 'wx', mode: 0o600 })
    const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cutFor(f))
    await privateJson(join(f.root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixture-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(f.root, 'cut.json'), { keyId: 'owned-fixture-key', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    expect(await launch(f.root, request, 'accounts')).toMatchObject({ version: CURRENT_SCHEMA_VERSION, phase: 'current-schema-initialized', systemMigrationComplete: false })
    const identities = new IdentityService(f.target, 60000), management = { maxUsers: 100,
      models: [{ id: 'trial-model', label: 'Trial', maxTokens: 1000 }], initialSettings: { model: 'trial-model', maxTokens: 1000 } }
    let revocations = 0
    const accounts = new AccountService(f.target, identities, { platformOrigin: 'http://127.0.0.1:12345',
      workspaceRoot: join(f.root, 'candidate', 'workspaces'), management,
      revokeExecutions: async () => { revocations++; throw new Error('A replay must never revoke an execution') } })
    const alice = await accounts.login('migration-alice', password), bob = await accounts.login('migration-bob', password)
    const before = (await f.target.query('SELECT id,password_hash,settings,role,enabled,account_revision,credential_version FROM pe_users ORDER BY id')).rows
    const mutations = (await f.target.query('SELECT * FROM pe_account_mutations ORDER BY actor_user_id,request_id')).rows
    const audit = (await f.target.query('SELECT * FROM pe_account_audit ORDER BY id')).rows
    expect(await accounts.receipt(alice.token, owned.input.requestId)).toEqual({ receipt: owned.receipt })
    expect(await accounts.receipt(bob.token, owned.input.requestId)).toEqual({ receipt: null })
    expect(await accounts.update(alice.token, owned.input)).toEqual({ replay: true, receipt: owned.receipt })
    await expect(accounts.update(alice.token, { ...owned.input, displayName: 'Conflicting retry' }))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    const agent = await identities.login('migration-alice', password)
    const settingsService = new AccountSettingsService(f.target)
    expect(await settingsService.update(agent.user, { requestId: requestId.parse(owned.settingsRequestId),
      expectedRevision: 6, model: 'trial-model', maxTokens: 1000 }, agent.token))
      .toEqual({ model: 'trial-model', maxTokens: 1000, revision: 7 })
    await expect(settingsService.update(agent.user, { requestId: requestId.parse(owned.settingsRequestId),
      expectedRevision: 6, model: 'trial-model', maxTokens: 999 }, agent.token)).rejects.toMatchObject({ code: 'request_id_conflict' })
    const plugins = new PluginService(f.target)
    expect(await plugins.notesSetEnabled(agent.user, { requestId: owned.pluginRequestId, expectedRevision: 6, enabled: false }))
      .toMatchObject({ enabled: false, revision: 7 })
    await expect(plugins.notesSetEnabled(agent.user, { requestId: owned.pluginRequestId, expectedRevision: 6, enabled: true }))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    await bootstrapAccount(f.target, { mode: 'existing', userId: accountUserId.parse(f.alice.user), username: 'migration-alice' }, management)
    expect(revocations).toBe(0)
    expect((await f.target.query('SELECT id,password_hash,settings,role,enabled,account_revision,credential_version FROM pe_users ORDER BY id')).rows)
      .toEqual(before)
    expect((await f.target.query('SELECT * FROM pe_account_mutations ORDER BY actor_user_id,request_id')).rows).toEqual(mutations)
    expect((await f.target.query('SELECT * FROM pe_account_audit ORDER BY id')).rows).toEqual(audit)
    expect((await f.target.query('SELECT * FROM pe_native_writers')).rowCount).toBe(0)
  }, false, false, true)
})

test('nonempty account owners reject changed receipt identities, mismatched audits, verifiers and historical retry digests', async () => {
  await fixture(async (f) => {
    const owned = f.accountOwners
    if (!owned) throw new Error('Owned account inventory missing')
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const files = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources), cut = cutFor(f)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, files, f.files, cut.filesSha256, cut, budgets)
    const mutation = plan.rows.find(row => row.table === 'pe_account_mutations')
    const audit = plan.rows.find(row => row.table === 'pe_account_audit' && row.values.kind === 'update')
    const bootstrap = plan.rows.find(row => row.table === 'pe_account_bootstrap')
    const settingsMutation = plan.rows.find(row => row.table === 'pe_settings_mutations')
    const pluginMutation = plan.rows.find(row => row.table === 'pe_plugin_mutations')
    if (!mutation || !audit || !bootstrap || !settingsMutation || !pluginMutation) throw new Error('Nonempty account owners missing')
    const validate = (row: typeof mutation, rows = plan.rows) => validateLegacyMigrationAccountOwner(row, rows, budgets, cut.cut)
    expect(validate(mutation)).toBe(true)
    expect(() => validate({ ...mutation, values: { ...mutation.values,
      receipt: JSON.stringify({ ...owned.receipt, requestId: randomUUID() }) } }))
      .toThrow('migration_account_receipt_identity')
    expect(() => validate({ ...mutation, values: { ...mutation.values, receipt: JSON.stringify({ ...owned.receipt,
      account: { ...owned.receipt.account, userId: f.alice.user } }) } })).toThrow('migration_account_receipt_identity')
    expect(() => validate({ ...mutation, values: { ...mutation.values, password_verifier: verifier } }))
      .toThrow('migration_account_password_receipt')
    const changedAudit = { ...audit, values: { ...audit.values, metadata: '{"revision":7,"enabled":true,"role":"USER"}' } }
    expect(() => validate(mutation, plan.rows.map(row => row === audit ? changedAudit : row))).toThrow('migration_account_audit_receipt_mismatch')
    expect(() => validate(mutation, plan.rows.filter(row => row !== audit))).toThrow('migration_account_mutation_audit_missing')
    expect(() => validate({ ...bootstrap, values: { ...bootstrap.values, username: 'Wrong stopped-source identity' } }))
      .toThrow('migration_account_bootstrap_invalid')
    expect(() => validate({ ...settingsMutation, values: { ...settingsMutation.values, request_digest: '0'.repeat(64) } }))
      .toThrow('migration_settings_mutation_invalid')
    expect(() => validate({ ...pluginMutation, values: { ...pluginMutation.values, result_enabled: 'true' } }))
      .toThrow('migration_plugin_mutation_invalid')
    expect(validateLegacyMigrationAccountOwner({ ...mutation, table: 'pe_mcp_connections' }, plan.rows, budgets, cut.cut)).toBe(false)
    expect((await f.target.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rowCount).toBe(0)
  }, false, false, true)
})

test('schema4 maintenance preserves fixed MCP owners and ordinary consumers recover disabled state and original receipts', async () => {
  await fixture(async (f) => {
    const owned = f.fixedMcp
    if (!owned) throw new Error('Owned fixed MCP inventory missing')
    const request = { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
      phaseTimeoutMs: 30000, source: { purpose: 'offline-readonly-export', urlFile: join(f.root, 'source-url'),
        expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog, identity: f.capture.source,
        batchRows: 2, statementTimeoutMs: 5000 }, mode: 'migrate', outputFile: join(f.root, 'fixed-mcp-output.json'),
      failureEvidenceFile: join(f.root, 'fixed-mcp-failure.json'), evidenceFile: join(f.root, 'cut.json'),
      trustedEvidenceKeysFile: join(f.root, 'keys.json'), histories: f.histories, attachmentSources: f.attachmentSources,
      attachmentSourceRoots: f.attachmentRoots, files: f.files, initializeCurrent: true,
      target: { urlFile: join(f.root, 'target-url'), expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'), sourceUid: process.getuid?.(),
        sourceGid: process.getgid?.(), targetUid: process.getuid?.(), targetGid: process.getgid?.() } }
    await writeFile(join(f.root, 'source-url'), f.sourceUrl.href, { flag: 'wx', mode: 0o600 })
    await writeFile(join(f.root, 'target-url'), f.targetUrl.href, { flag: 'wx', mode: 0o600 })
    const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cutFor(f))
    await privateJson(join(f.root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixture-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(f.root, 'cut.json'), { keyId: 'owned-fixture-key', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    expect(await launch(f.root, request, 'fixed-mcp')).toMatchObject({ version: CURRENT_SCHEMA_VERSION, phase: 'current-schema-initialized',
      systemMigrationComplete: false })
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const service = new PersonalMcpService(new TaskStore(f.target, taskLimits), '', '', 5000)
    const connections = (await f.target.query('SELECT * FROM pe_mcp_connections ORDER BY id')).rows
    const updates = (await f.target.query('SELECT * FROM pe_mcp_updates ORDER BY user_id,request_id')).rows
    expect(await service.list(alice.user)).toMatchObject({ available: false, items: [owned.result] })
    expect((await service.list(bob.user)).items).toMatchObject([{ connectionId: owned.bobConnectionId, enabled: true, revision: 1 }])
    expect(await service.install(alice.user, owned.connectionId, owned.result.name))
      .toEqual({ ...owned.result, enabled: true, revision: 1 })
    expect(await service.toggle(alice.user, owned.connectionId, owned.request, 1, false)).toEqual(owned.result)
    await expect(service.toggle(alice.user, owned.connectionId, owned.request, 1, true))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    await expect(service.toggle(bob.user, owned.connectionId, randomUUID(), 2, false))
      .rejects.toMatchObject({ code: 'mcp_connection_not_found' })
    await expect(service.install(alice.user, owned.connectionId, 'Changed install retry')).rejects.toMatchObject({ code: 'request_id_conflict' })
    await expect(service.check(alice.user, owned.connectionId)).rejects.toMatchObject({ code: 'mcp_unavailable' })
    expect((await f.target.query('SELECT * FROM pe_mcp_connections ORDER BY id')).rows).toEqual(connections)
    expect((await f.target.query('SELECT * FROM pe_mcp_updates ORDER BY user_id,request_id')).rows).toEqual(updates)
    const recaptured = await captureLegacyMigrationSource(f.readonly, f.capture.source, { purpose: 'offline-readonly-export',
      expectedDatabase: f.sourceUrl.pathname.slice(1), expectedCatalogSha256: f.catalog,
      batchRows: 2, statementTimeoutMs: 5000, limits: budgets },
    new AbortController().signal)
    expect(recaptured.tables).toEqual(f.capture.tables)
  }, false, false, false, true)
})

test('fixed MCP migration rejects foreign results, changed original digests and incomplete toggle revision chains', async () => {
  await fixture(async (f) => {
    const owned = f.fixedMcp
    if (!owned) throw new Error('Owned fixed MCP inventory missing')
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts,
      f.files, cut.filesSha256, cut, budgets)
    const connection = plan.rows.find(row => row.table === 'pe_mcp_connections' && row.values.id === owned.connectionId)
    const update = plan.rows.find(row => row.table === 'pe_mcp_updates')
    if (!connection || !update) throw new Error('Fixed MCP retained rows missing')
    const validate = (row: typeof connection, rows = plan.rows) => validateLegacyMigrationFixedMcp(row, rows, budgets, cut.cut)
    expect(validate(connection)).toBe(true)
    expect(() => validate({ ...update, values: { ...update.values, result: JSON.stringify({ ...owned.result,
      connectionId: owned.bobConnectionId }) } })).toThrow('migration_fixed_mcp_receipt_invalid')
    expect(() => validate({ ...update, values: { ...update.values, user_id: f.bob.user } })).toThrow('migration_fixed_mcp_owner_missing')
    expect(() => validate({ ...update, values: { ...update.values, request_digest: '0'.repeat(64) } }))
      .toThrow('migration_fixed_mcp_receipt_invalid')
    expect(() => validate(connection, plan.rows.filter(row => row !== update))).toThrow('migration_fixed_mcp_toggle_chain')
    expect(() => validate({ ...connection, values: { ...connection.values, enabled: 'true' } })).toThrow('migration_fixed_mcp_toggle_chain')
    expect(() => validate({ ...connection, values: { ...connection.values, install_request_id: randomUUID() } }))
      .toThrow('migration_fixed_mcp_connection_invalid')
    expect(() => validate({ ...update, values: { ...update.values, created_at: '2026-01-01T00:00:00Z' } }))
      .toThrow('migration_fixed_mcp_future')
    expect(validateLegacyMigrationFixedMcp({ ...update, table: 'pe_mcp_credential_versions' }, plan.rows, budgets, cut.cut)).toBe(false)
    expect((await f.target.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rowCount).toBe(0)
  }, false, false, false, true)
})

test('schema4 maintenance preserves historical file uploads and disabled or revoked Skill bytes for ordinary consumers', async () => {
  await fixture(async (f) => {
    const owned = f.storageOwners
    if (!owned) throw new Error('Owned storage metadata inventory missing')
    expect(await migrateFixtureCurrent(f, 'storage-owners')).toMatchObject({ version: CURRENT_SCHEMA_VERSION, phase: 'current-schema-initialized',
      systemMigrationComplete: false })
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const files = new FileService(f.target, join(f.root, 'candidate', 'workspaces')); await files.init()
    const originalCurrent = await files.read(alice.user, 'original.txt', f.alice.workspace)
    expect(originalCurrent.revision).not.toBe(legacyDigest(owned.uploadBytes))
    expect(await files.put(alice.user, owned.uploadRequest, 'original.txt', owned.uploadBytes.toString('base64'), f.alice.workspace))
      .toEqual({ path: 'original.txt', size: owned.uploadBytes.length, mime: 'text/plain', revision: legacyDigest(owned.uploadBytes) })
    await expect(files.put(alice.user, owned.uploadRequest, 'original.txt', Buffer.from('Changed retry').toString('base64'), f.alice.workspace))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    await expect(files.put(bob.user, owned.uploadRequest, 'original.txt', owned.uploadBytes.toString('base64'), f.alice.workspace))
      .rejects.toMatchObject({ code: 'workspace_not_found' })
    expect(await files.read(alice.user, 'original.txt', f.alice.workspace)).toEqual(originalCurrent)
    const skills = new SkillService(f.target, join(f.root, 'candidate', 'workspaces'), join(f.root, 'candidate', 'skills'), 64)
    await skills.init()
    const rowsBefore = (await f.target.query('SELECT * FROM pe_user_skills ORDER BY id')).rows
    const versionsBefore = (await f.target.query<{ id: string; manifest_digest: string }>(
      'SELECT * FROM pe_skill_package_versions ORDER BY id')).rows
    const intentsBefore = (await f.target.query('SELECT * FROM pe_skill_upload_intents ORDER BY request_id')).rows
    expect(await skills.read(alice.user, owned.textSkill)).toMatchObject({ instructions: owned.text, enabled: false, observedState: 'ready' })
    expect(await skills.read(alice.user, owned.packageSkill)).toMatchObject({ instructions: owned.instructions.toString('utf8'),
      digest: legacyDigest(owned.instructions), packageDigest: owned.archiveDigest, version: owned.version, enabled: false, observedState: 'revoked' })
    await expect(skills.read(bob.user, owned.packageSkill)).rejects.toMatchObject({ code: 'skill_not_found' })
    expect(await skills.issueUploadTicket(alice.user, owned.packageSkill, owned.zip.length, owned.archiveDigest, 'http://127.0.0.1:12345'))
      .toMatchObject({ state: 'ready', item: { skillId: owned.packageSkill, enabled: false, observedState: 'revoked' } })
    const versionRow = versionsBefore.find(row => row.id === owned.packageSkill)
    if (!versionRow) throw new Error('Owned original package version missing')
    const selected = skillSelection.parse({ skillId: owned.packageSkill, ...owned.metadata, kind: 'package',
      digest: legacyDigest(owned.instructions), revision: 5, version: owned.version,
      packageDigest: owned.archiveDigest, manifestDigest: versionRow.manifest_digest })
    await expect(skills.readSelected(alice.user.userId, selected, owned.packageSkill)).rejects.toMatchObject({ code: 'skill_revoked' })
    const server = createServer((request, response) => {
      const ticket = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1]
      if (!ticket) { response.writeHead(401).end(); return }
      void skills.upload(ticket, request).then((value) => { sendJson(response, value) },
        (error: unknown) => { sendFailure(response, error) })
    })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Owned upload HTTP port missing')
      for (const ticket of [owned.consumedTicket, owned.expiredTicket]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/skills/upload`, { method: 'POST',
          headers: { authorization: `Bearer ${ticket}` }, signal: AbortSignal.timeout(5000) })
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error: 'invalid_upload_ticket' })
      }
    } finally {
      await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() }))
    }
    expect((await f.target.query('SELECT * FROM pe_user_skills ORDER BY id')).rows).toEqual(rowsBefore)
    expect((await f.target.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows).toEqual(versionsBefore)
    expect((await f.target.query('SELECT * FROM pe_skill_upload_intents ORDER BY request_id')).rows).toEqual(intentsBefore)
  }, false, false, false, false, true)
})

test('storage owner migration rejects missing Skill inventories, changed package metadata, active tickets and foreign file receipts', async () => {
  await fixture(async (f) => {
    const owned = f.storageOwners
    if (!owned) throw new Error('Owned storage metadata inventory missing')
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets)
    const text = plan.rows.find(row => row.table === 'pe_user_skills' && row.values.id === owned.textSkill)
    const version = plan.rows.find(row => row.table === 'pe_skill_package_versions')
    const intent = plan.rows.find(row => row.table === 'pe_skill_upload_intents' && row.values.request_id === owned.expiredRequest)
    const consumed = plan.rows.find(row => row.table === 'pe_skill_upload_intents' && row.values.request_id === owned.packageSkill)
    const upload = plan.rows.find(row => row.table === 'pe_file_uploads')
    if (!text || !version || !intent || !consumed || !upload) throw new Error('Retained storage owners missing')
    const validate = (row: typeof text, files = f.files) => validateLegacyMigrationStorageOwner(row, plan.rows, files, budgets, cut.cut)
    expect(() => validate(text, f.files.filter(file => file.area !== 'skill-text'))).toThrow('migration_text_skill_inventory')
    expect(() => validate(version, f.files.filter(file => file.path !== 'skill/resource.txt'))).toThrow('migration_skill_inventory_invalid')
    expect(() => validate({ ...version, values: { ...version.values, manifest_digest: '0'.repeat(64) } }))
      .toThrow('migration_skill_manifest_invalid')
    expect(() => validate({ ...intent, values: { ...intent.values, expires_at: '2026-01-01T00:00:00Z' } }))
      .toThrow('migration_skill_upload_active')
    expect(() => validate({ ...consumed, values: { ...consumed.values, archive_digest: '0'.repeat(64) } }))
      .toThrow('migration_skill_upload_receipt')
    expect(() => validate({ ...upload, values: { ...upload.values, user_id: f.bob.user } })).toThrow('migration_file_upload_identity')
    expect((await f.target.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rowCount).toBe(0)
  }, false, false, false, false, true)
})

test('schema4 maintenance preserves original remote MCP ciphertext, historical HMAC receipts and unknown catalog fields', async () => {
  await fixture(async (f) => {
    const owned = f.remoteMcp
    if (!owned || !f.mcpEvidence) throw new Error('Owned original remote MCP inventory missing')
    const before = JSON.stringify(f.capture.tables)
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string().regex(/^\d+$/u)) })
      .parse(await migrateFixtureCurrent(f, 'remote-mcp'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    for (const table of ['pe_mcp_remote_connections', 'pe_mcp_configuration_versions', 'pe_mcp_credential_versions',
      'pe_mcp_management_requests', 'pe_mcp_credential_tickets', 'pe_mcp_catalog_versions']) {
      expect(output.tableCounts[table]).toBe(String(f.capture.tables[table]?.length))
      expect(Number(output.tableCounts[table])).toBeGreaterThan(0)
    }
    const identities = new IdentityService(f.target, 60000), alice = (await identities.login('migration-alice', password)).user
    const bob = (await identities.login('migration-bob', password)).user
    const service = new McpConnectionService(f.target, owned.key, { ...remoteMcpLimits,
      assertEndpoint: () => { throw new Error('Historical replay attempted new endpoint admission') } })
    const rowsBefore = (await f.target.query('SELECT * FROM pe_mcp_remote_connections ORDER BY id')).rows
    const requestsBefore = (await f.target.query('SELECT * FROM pe_mcp_management_requests ORDER BY user_id,request_id')).rows
    const ciphertextBefore = (await f.target.query<{ connection_id: string; configuration_revision: number; sealed: string }>(
      'SELECT connection_id,configuration_revision,sealed::text AS sealed FROM pe_mcp_credential_versions ORDER BY connection_id,configuration_revision')).rows
    for (const row of ciphertextBefore) expect(row.sealed).toBe(f.capture.tables.pe_mcp_credential_versions?.find(item =>
      item.connection_id === row.connection_id && item.configuration_revision === String(row.configuration_revision))?.sealed)
    expect(await service.receipt(alice, owned.createInput.requestId)).toEqual({ result: { kind: 'connection', item: owned.created } })
    expect(await service.update(alice, owned.updateInput)).toEqual(owned.updated)
    expect(await service.toggle(alice, owned.toggleInput)).toEqual(owned.disabled)
    expect(await service.get(alice, owned.created.connectionId)).toMatchObject({ enabled: false, revision: 3, configurationRevision: 2 })
    await expect(service.update(alice, { ...owned.updateInput, configuration: { ...owned.updateInput.configuration, displayName: 'Changed retry' } }))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    await expect(service.get(bob, owned.created.connectionId)).rejects.toMatchObject({ code: 'mcp_connection_not_found' })
    const aliceCatalogId = mcpCatalogId.parse(owned.catalogIds[0]), bobCatalogId = mcpCatalogId.parse(owned.catalogIds[1])
    expect((await service.getCatalog(alice, aliceCatalogId)).tools[0]?.raw).toEqual(owned.descriptor)
    await expect(service.getCatalog(bob, aliceCatalogId)).rejects.toMatchObject({ code: 'mcp_catalog_not_found' })
    await transaction(f.target, async (client) => {
      const pinned = { connectionId: owned.bobCreated.connectionId, revision: 1, configurationRevision: 1,
        credentialRevision: 1, catalogId: bobCatalogId }
      const snapshot = await service.runtimeSnapshot(client, bob, pinned)
      expect(snapshot.headers).toEqual({ Authorization: 'Bearer original-Bob-credential' })
      expect(snapshot.resourceId).toBe(owned.bobCreated.connectionId)
      await expect(service.runtimeSnapshot(client, alice, { connectionId: owned.created.connectionId, revision: 3,
        configurationRevision: 2, credentialRevision: 2, catalogId: aliceCatalogId })).rejects.toMatchObject({ code: 'mcp_connection_revoked' })
    })
    const server = createServer((request, response) => {
      const token = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1]
      if (!token) { response.writeHead(401).end(); return }
      void service.upload(token, request).then((value) => { sendJson(response, value) },
        (error: unknown) => { sendFailure(response, error) })
    })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Owned remote MCP upload port missing')
      for (const token of [owned.consumedTicket, owned.pendingTicket]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/mcp/connections/upload`, { method: 'POST',
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error: 'invalid_mcp_ticket' })
      }
    } finally { await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() })) }
    expect((await f.target.query('SELECT * FROM pe_mcp_remote_connections ORDER BY id')).rows).toEqual(rowsBefore)
    expect((await f.target.query('SELECT * FROM pe_mcp_management_requests ORDER BY user_id,request_id')).rows).toEqual(requestsBefore)
    expect((await f.target.query('SELECT connection_id,configuration_revision,sealed::text AS sealed FROM pe_mcp_credential_versions ORDER BY connection_id,configuration_revision')).rows)
      .toEqual(ciphertextBefore)
    const catalogs = (await f.target.query<{ id: string; tools: string }>('SELECT id,tools::text AS tools FROM pe_mcp_catalog_versions')).rows
    for (const row of catalogs) expect(row.tools).toBe(f.capture.tables.pe_mcp_catalog_versions?.find(item => item.id === row.id)?.tools)
    expect(JSON.stringify(f.capture.tables)).toBe(before)
  }, false, false, false, false, false, true)
})

test('remote MCP migration rejects changed original keys, AAD identities, inputs, HMAC receipts, catalogs and active capabilities', async () => {
  await fixture(async (f) => {
    const owned = f.remoteMcp, evidence = f.mcpEvidence
    if (!owned || !evidence) throw new Error('Owned original remote MCP evidence missing')
    const key = { format: 'power-evolve-legacy-mcp-key', version: 1, keyId: owned.keyId, key: owned.key }
    const context = createLegacyMigrationMcpContext(key, evidence, f.capture.source.codeId, budgets)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const prepare = (original = context) => prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files,
      cut.filesSha256, cut, budgets, [], original)
    const plan = prepare()
    expect(() => prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files,
      cut.filesSha256, cut, budgets)).toThrow('migration_mcp_original_evidence_missing')
    expect(() => createLegacyMigrationMcpContext({ ...key, keyId: 'different-source-key' }, evidence, f.capture.source.codeId, budgets))
      .toThrow('migration_mcp_original_key_identity')
    expect(() => prepare(createLegacyMigrationMcpContext({ ...key, key: randomBytes(32).toString('base64url') }, evidence,
      f.capture.source.codeId, budgets))).toThrow('migration_mcp_credential_unavailable')
    const credential = plan.rows.find(row => row.table === 'pe_mcp_credential_versions' && row.values.connection_id === owned.created.connectionId
      && row.values.configuration_revision === '1')
    const request = plan.rows.find(row => row.table === 'pe_mcp_management_requests' && row.values.request_id === owned.createInput.requestId)
    const ticket = plan.rows.find(row => row.table === 'pe_mcp_credential_tickets' && row.values.request_id === owned.pendingInput.requestId)
    const catalog = plan.rows.find(row => row.table === 'pe_mcp_catalog_versions' && row.values.connection_id === owned.created.connectionId)
    if (!credential || !request || !ticket || !catalog) throw new Error('Original remote MCP selected rows missing')
    const validate = (row: typeof credential, original = context) => validateLegacyMigrationRemoteMcp(row,
      plan.rows.map(item => item.table === row.table && item.sourceSha256 === row.sourceSha256 ? row : item), budgets, cut.cut, original)
    const sealed = credential.values.sealed ?? ''
    expect(() => validate({ ...credential, values: { ...credential.values, sealed: sealed.slice(0, -2) + (sealed.endsWith('00') ? '01' : '00') } }))
      .toThrow('migration_mcp_credential_unavailable')
    expect(() => validate({ ...credential, values: { ...credential.values, user_id: f.bob.user } })).toThrow('migration_mcp_reference_missing')
    const bobCredential = plan.rows.find(row => row.table === 'pe_mcp_credential_versions' && row.values.connection_id === owned.bobCreated.connectionId)
    const updatedCredential = plan.rows.find(row => row.table === 'pe_mcp_credential_versions'
      && row.values.connection_id === owned.created.connectionId && row.values.configuration_revision === '2')
    const updatedRequest = plan.rows.find(row => row.table === 'pe_mcp_management_requests' && row.values.request_id === owned.updateInput.requestId)
    if (!bobCredential || !updatedCredential || !updatedRequest) throw new Error('Owned original versioned credentials missing')
    expect(() => validate({ ...credential, values: { ...credential.values, sealed: bobCredential.values.sealed ?? null } }))
      .toThrow('migration_mcp_credential_unavailable')
    const changedRetained = new McpCredentialCipher(owned.key).seal({ kind: 'connection',
      userId: identity.parse({ userId: f.alice.user, username: 'migration-alice' }).userId,
      resourceId: mcpResourceId.parse(owned.created.connectionId), configurationRevision: 2, credentialRevision: 2 },
    { formatVersion: 1, bearerToken: 'Changed-retained-original-credential' })
    expect(() => validateLegacyMigrationRemoteMcp(updatedRequest, plan.rows.map(row => row === updatedCredential
      ? { ...row, values: { ...row.values, sealed: `\\x${changedRetained.toString('hex')}` } } : row), budgets, cut.cut, context))
      .toThrow('migration_mcp_retained_secret_changed')
    expect(() => validate({ ...request, values: { ...request.values, metadata_digest: '0'.repeat(64) } }))
      .toThrow('migration_mcp_original_metadata_digest')
    expect(() => validate({ ...request, values: { ...request.values, secret_digest: '0'.repeat(64) } }))
      .toThrow('migration_mcp_original_secret_digest')
    expect(() => validate({ ...ticket, values: { ...ticket.values, expires_at: new Date(Date.parse(cut.cut) + 60000).toISOString() } }))
      .toThrow('migration_mcp_ticket_active')
    const tools = z.array(z.record(z.string(), z.json())).parse(JSON.parse(catalog.values.tools ?? ''))
    expect(() => validate({ ...catalog, values: { ...catalog.values,
      tools: JSON.stringify(tools.map(tool => ({ ...tool, toolId: randomUUID() }))) } }))
      .toThrow('migration_mcp_original_catalog')
    const changedEvidence = legacyMigrationMcpEvidence.parse({ ...evidence, requests: evidence.requests.map(proof =>
      proof.requestId === owned.createInput.requestId ? { ...proof, input: { ...owned.createInput,
        configuration: { ...owned.createInput.configuration, displayName: 'Changed original metadata' } } } : proof) })
    expect(() => validate(request, createLegacyMigrationMcpContext(key, changedEvidence, f.capture.source.codeId, budgets)))
      .toThrow('migration_mcp_original_metadata_digest')
    await writeFile(join(f.root, 'mcp-original-inputs.json'), JSON.stringify(changedEvidence) + '\n', { mode: 0o600 })
    expect(await migrateFixtureCurrent(f, 'remote-mcp-tampered', 1)).toMatchObject({ exitCode: 1 })
    expect(JSON.parse(await readFile(join(f.root, 'remote-mcp-tampered-failure.json'), 'utf8')))
      .toMatchObject({ code: 'migration_cut_mismatch', systemMigrationComplete: false })
    expect((await f.target.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rowCount).toBe(0)
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, true)
})

test('remote MCP never-started checks preserve expired draft AAD, cancelled state and pruned original queued receipts', async () => {
  await fixture(async (f) => {
    const owned = f.remoteMcp, discovery = owned?.noStart
    if (!owned || !discovery) throw new Error('Owned never-started original MCP inventory missing')
    const sourceBefore = JSON.stringify(f.capture.tables)
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'remote-mcp-no-start'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_mcp_drafts).toBe('1')
    expect(output.tableCounts.pe_mcp_checks).toBe('3')
    expect(output.tableCounts.pe_mcp_management_requests).toBe('9')
    const identities = new IdentityService(f.target, 60000), alice = (await identities.login('migration-alice', password)).user
    const bob = (await identities.login('migration-bob', password)).user
    const service = new McpConnectionService(f.target, owned.key, { ...remoteMcpLimits,
      assertEndpoint: () => { throw new Error('Original check replay attempted endpoint admission') } })
    const checksBefore = (await f.target.query('SELECT * FROM pe_mcp_checks ORDER BY id')).rows
    const requestsBefore = (await f.target.query('SELECT * FROM pe_mcp_management_requests ORDER BY user_id,request_id')).rows
    const draft = (await f.target.query<{ id: string; sealed: string }>(
      'SELECT id,credential_sealed::text AS sealed FROM pe_mcp_drafts')).rows[0]!
    expect(draft.sealed).toBe(f.capture.tables.pe_mcp_drafts?.[0]?.credential_sealed)
    expect(new McpCredentialCipher(owned.key).open({ kind: 'draft', userId: alice.userId,
      resourceId: mcpResourceId.parse(draft.id), configurationRevision: 1, credentialRevision: 1 },
    Buffer.from(draft.sealed.slice(2), 'hex'))).toEqual({ formatVersion: 1, bearerToken: 'original-Alice-credential' })
    expect(await service.startDraftCheck(alice, discovery.draftInput)).toEqual(discovery.draftCheck)
    expect(await service.startCheck(bob, discovery.savedInput)).toEqual(discovery.savedCheck)
    expect(await service.startCheck(alice, discovery.cancelInput)).toEqual(discovery.cancelCheck)
    expect(await service.startCheck(bob, discovery.prunedInput)).toEqual(discovery.prunedCheck)
    expect(await service.check(alice, discovery.draftCheck.checkId)).toMatchObject({ state: 'expired', errorCode: 'mcp_check_expired' })
    expect(await service.check(bob, discovery.savedCheck.checkId)).toMatchObject({ state: 'expired', errorCode: 'mcp_check_expired' })
    expect(await service.check(alice, discovery.cancelCheck.checkId)).toEqual(discovery.cancelled)
    await expect(service.check(bob, discovery.prunedCheck.checkId)).rejects.toMatchObject({ code: 'mcp_check_not_found' })
    await expect(service.check(bob, discovery.draftCheck.checkId)).rejects.toMatchObject({ code: 'mcp_check_not_found' })
    await expect(service.startDraftCheck(alice, { ...discovery.draftInput, configuration: {
      ...discovery.draftInput.configuration, displayName: 'Changed original draft retry' } }))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    expect(await service.claimCheck(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
    await expect(service.checkSnapshot({ checkId: discovery.draftCheck.checkId,
      ownerId: discovery.originalWorker, epoch: 0 })).rejects.toMatchObject({ code: 'mcp_check_lease_lost' })
    expect((await f.target.query('SELECT * FROM pe_mcp_checks ORDER BY id')).rows).toEqual(checksBefore)
    expect((await f.target.query('SELECT * FROM pe_mcp_management_requests ORDER BY user_id,request_id')).rows).toEqual(requestsBefore)
    expect(JSON.stringify(f.capture.tables)).toBe(sourceBefore)
  }, false, false, false, false, false, true, true)
})

test('remote MCP no-start migration rejects active drafts, started epochs, changed retained draft secrets and mismatched original check closure', async () => {
  await fixture(async (f) => {
    const owned = f.remoteMcp, discovery = owned?.noStart, evidence = f.mcpEvidence
    if (!owned || !discovery || !evidence) throw new Error('Owned no-start MCP evidence missing')
    const context = createLegacyMigrationMcpContext({ format: 'power-evolve-legacy-mcp-key', version: 1,
      keyId: owned.keyId, key: owned.key }, evidence, f.capture.source.codeId, budgets)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets, [], context)
    const draft = plan.rows.find(row => row.table === 'pe_mcp_drafts')
    const check = plan.rows.find(row => row.table === 'pe_mcp_checks' && row.values.id === discovery.draftCheck.checkId)
    const request = plan.rows.find(row => row.table === 'pe_mcp_management_requests' && row.values.request_id === discovery.draftInput.requestId)
    if (!draft || !check || !request) throw new Error('Owned no-start MCP selected rows missing')
    const validate = (row: typeof draft) => validateLegacyMigrationRemoteMcp(row,
      plan.rows.map(item => item === draft && row.table === draft.table || item === check && row.table === check.table ? row : item),
      budgets, cut.cut, context)
    expect(() => validate({ ...draft, values: { ...draft.values,
      expires_at: new Date(Date.parse(cut.cut) + 60000).toISOString() } })).toThrow('migration_mcp_draft_identity')
    expect(() => validate({ ...check, values: { ...check.values, lease_epoch: '1' } }))
      .toThrow('migration_mcp_check_worker_closure_missing')
    expect(() => validate({ ...check, values: { ...check.values, lease_owner: randomUUID() } }))
      .toThrow('migration_mcp_check_no_start_invalid')
    expect(() => validate({ ...check, values: { ...check.values, error_code: null } }))
      .toThrow('migration_mcp_check_no_start_invalid')
    expect(() => validate({ ...check, values: { ...check.values, credential_revision: null } }))
      .toThrow('migration_mcp_check_result_identity')
    const cipher = new McpCredentialCipher(owned.key), owner = identity.parse({ userId: f.alice.user, username: 'migration-alice' })
    const wrongAad = cipher.seal({ kind: 'connection', userId: owner.userId, resourceId: mcpResourceId.parse(draft.values.id),
      configurationRevision: 1, credentialRevision: 1 }, { formatVersion: 1, bearerToken: 'original-Alice-credential' })
    expect(() => validate({ ...draft, values: { ...draft.values, credential_sealed: `\\x${wrongAad.toString('hex')}` } }))
      .toThrow('migration_mcp_credential_unavailable')
    const changed = cipher.seal({ kind: 'draft', userId: owner.userId, resourceId: mcpResourceId.parse(draft.values.id),
      configurationRevision: 1, credentialRevision: 1 }, { formatVersion: 1, bearerToken: 'changed-retained-draft-credential' })
    expect(() => validateLegacyMigrationRemoteMcp(request, plan.rows.map(row => row === draft
      ? { ...row, values: { ...row.values, credential_sealed: `\\x${changed.toString('hex')}` } } : row), budgets, cut.cut, context))
      .toThrow('migration_mcp_retained_secret_changed')
    expect(() => validateLegacyMigrationRemoteMcp(check, plan.rows.filter(row => row !== request), budgets, cut.cut, context))
      .toThrow('migration_mcp_check_request_closure')
  }, false, false, false, false, false, true, true)
})

test('remote MCP original no-start actions preserve source-service HMACs, decisions, permissions and terminal continuations', async () => {
  await fixture(async (f) => {
    const actions = f.mcpActions, original = f.remoteMcp
    if (!actions || !original) throw new Error('Owned original action source missing')
    expect(actions).toMatchObject({ metadataOnlyFixture: true, hostStarted: false, mcpWorkerClaimed: false,
      networkDispatchStarted: false, physicalStopReceipt: null })
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'remote-mcp-actions'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_mcp_actions).toBe('3')
    expect(output.tableCounts.pe_mcp_permissions).toBe('2')
    expect(output.tableCounts.pe_mcp_action_chains).toBe('3')
    expect(output.tableCounts.pe_operations).toBe('6')
    const identities = new IdentityService(f.target, 60000), bob = (await identities.login('migration-bob', password)).user
    const alice = (await identities.login('migration-alice', password)).user
    const approval = await identities.login('migration-bob', password, 'approval')
    const store = new McpActionStore(new TaskStore(f.target, taskLimits), original.key, { maxArgumentBytes: 8192,
      maxResultBytes: 32768, maxCallsPerChain: 8, maxPendingPerUser: 8, chainLifetimeMs: 60000,
      approvalLifetimeMs: 60000, leaseMs: 10000, listLimit: 50 })
    const before = (await f.target.query('SELECT * FROM pe_mcp_actions ORDER BY id')).rows
    for (const record of actions.records) {
      const receipt = { actionId: record.terminal.actionId, state: record.terminal.state,
        fingerprint: record.terminal.fingerprint, errorCode: record.terminal.errorCode }
      expect(await store.status(bob, record.proposed.actionId)).toEqual(record.terminal)
      expect(await store.cancel(bob, record.proposed.actionId, { token: approval.token, audience: 'approval' }))
        .toEqual(receipt)
      expect(await store.decide(bob, record.proposed.actionId, record.proposed.fingerprint, record.decision, approval.token))
        .toEqual(receipt)
      await expect(store.status(alice, record.proposed.actionId)).rejects.toMatchObject({ code: 'mcp_action_not_found' })
      if (record.permissionId) await store.revoke(bob, mcpPermissionId.parse(record.permissionId), approval.token)
      const continuation = (await f.target.query<{ input: string; state: string; request_id: string }>(
        'SELECT input,state,request_id FROM pe_operations WHERE id=$1', [record.continuationOperationId])).rows[0]!
      const source = f.capture.tables.pe_operations?.find(row => row.id === record.continuationOperationId)
      expect(continuation.input).toBe(source?.input)
      expect(continuation.state).toBe('failed')
      expect(JSON.parse(continuation.input)).toMatchObject({ kind: 'remote_mcp_result', actionId: record.proposed.actionId,
        state: record.terminal.state, errorCode: record.terminal.errorCode, result: null })
    }
    expect(await store.claim(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
    expect((await f.target.query('SELECT * FROM pe_mcp_actions ORDER BY id')).rows).toEqual(before)
    expect((await f.target.query('SELECT * FROM pe_operations')).rows).toHaveLength(6)
  }, false, false, false, false, false, true, false, true)
})

test('remote MCP original action migration rejects altered HMACs, started intent, historical tool changes and decision/continuation drift', async () => {
  await fixture(async (f) => {
    const actions = f.mcpActions, original = f.remoteMcp, evidence = f.mcpEvidence
    if (!actions || !original || !evidence) throw new Error('Owned original action input inventory missing')
    const context = createLegacyMigrationMcpContext({ format: 'power-evolve-legacy-mcp-key', version: 1,
      keyId: original.keyId, key: original.key }, evidence, f.capture.source.codeId, budgets)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets, [], context)
    const action = plan.rows.find(row => row.table === 'pe_mcp_actions' && row.values.decision === 'persistent')
    const permission = plan.rows.find(row => row.table === 'pe_mcp_permissions' && row.values.id === action?.values.permission_id)
    const continuation = plan.rows.find(row => row.table === 'pe_operations' && row.values.source_mcp_action_id === action?.values.id)
    const chain = plan.rows.find(row => row.table === 'pe_mcp_action_chains' && row.values.root_operation_id === action?.values.root_operation_id)
    if (!action || !permission || !continuation || !chain) throw new Error('Original action closure rows missing')
    const validate = (row: typeof action) => validateLegacyMigrationRemoteMcp(row, plan.rows.map(item =>
      item.table === row.table && item.sourceSha256 === row.sourceSha256 ? row : item), budgets, cut.cut, context)
    expect(() => validate({ ...action, values: { ...action.values, request_digest: '0'.repeat(64) } }))
      .toThrow('migration_mcp_original_action_digest')
    expect(() => validate({ ...action, values: { ...action.values, lease_epoch: '1' } }))
      .toThrow('migration_mcp_action_worker_closure_missing')
    expect(() => validate({ ...action, values: { ...action.values, dispatch_id: randomUUID(), dispatch_at: cut.cut } }))
      .toThrow('migration_mcp_action_worker_closure_missing')
    const tool = z.record(z.string(), z.json()).parse(JSON.parse(action.values.tool ?? ''))
    expect(() => validate({ ...action, values: { ...action.values, tool: JSON.stringify({ ...tool, catalogId: randomUUID() }) } }))
      .toThrow('migration_mcp_action_reference_missing')
    expect(() => validate({ ...permission, values: { ...permission.values, session_id: f.bob.session } }))
      .toThrow('migration_mcp_permission_original_decision')
    const sessionPermission = plan.rows.find(row => row.table === 'pe_mcp_permissions' && row.values.session_id === f.bob.session)
    if (!sessionPermission) throw new Error('Original session permission missing')
    expect(() => validate({ ...action, values: { ...action.values, permission_id: sessionPermission.values.id ?? null } }))
      .toThrow('migration_mcp_action_permission_identity')
    expect(() => validate({ ...chain, values: { ...chain.values, calls: '2' } })).toThrow('migration_mcp_action_chain_identity')
    expect(() => validateLegacyMigrationRemoteMcp(action, plan.rows.filter(row => row !== continuation), budgets, cut.cut, context))
      .toThrow('migration_mcp_action_continuation_identity')
    expect(() => validateLegacyMigrationRemoteMcp(action, plan.rows.map(row => row === continuation
      ? { ...row, values: { ...row.values, settings: '{"model":"changed","maxTokens":1,"revision":1}' } } : row), budgets, cut.cut, context))
      .toThrow('migration_mcp_action_continuation_snapshot')
  }, false, false, false, false, false, true, false, true)
})

test('Office original cancellation-before-admission metadata survives schema4 maintenance and changed converter defaults', async () => {
  await fixture(async (f) => {
    const office = f.office
    if (!office) throw new Error('Owned original Office cancellation missing')
    const source = JSON.stringify(f.capture.tables)
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'office-tombstone'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_office_preview_jobs).toBe('1')
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const service = ownedOfficeService(f.target, join(f.root, 'candidate', 'office'), 'c'.repeat(64))
    expect((await service.generation(alice.token)).generation).not.toBe(office.generation)
    const before = (await f.target.query('SELECT * FROM pe_office_preview_jobs')).rows
    expect(await service.status(alice.token, { jobId: office.result.jobId, generation: office.generation })).toEqual(office.result)
    expect(await service.cancel(alice.token, { requestId: office.requestId, generation: office.generation })).toEqual(office.result)
    expect(await service.prepare(alice.token, officePreviewPrepareRequest.parse({
      requestId: office.requestId, generation: office.generation,
      sessionId: f.alice.session, path: 'original-never-read.docx', priority: 'foreground' }))).toEqual(office.result)
    await expect(service.status(bob.token, { jobId: office.result.jobId, generation: office.generation }))
      .rejects.toMatchObject({ code: 'office_preview_not_found' })
    await expect(service.cancel(alice.token, officePreviewCancelRequest.parse({ requestId: office.requestId, generation: 'd'.repeat(64) })))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    expect((await f.target.query('SELECT * FROM pe_office_preview_jobs')).rows).toEqual(before)
    expect(JSON.stringify(f.capture.tables)).toBe(source)
    expect(await readdir(join(f.root, 'candidate', 'office'))).toEqual([])
    expect(officePreviewJobView.parse(office.result)).toMatchObject({ state: 'cancelled', errorCode: null })
  }, false, false, false, false, false, false, false, false, true)
})

test('Office original tombstone adapter rejects admitted conversion, parser claims, invented stop evidence and extra Office files', async () => {
  await fixture(async (f) => {
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets)
    const row = plan.rows.find(item => item.table === 'pe_office_preview_jobs')
    if (!row) throw new Error('Original Office tombstone selected row missing')
    const validate = (patch: Record<string, string | null>) => validateLegacyMigrationOffice({ ...row,
      values: { ...row.values, ...patch } }, plan.rows, plan.files, cut.cut)
    expect(() => validate({ request_digest: 'a'.repeat(64), request: '{}' }))
      .toThrow('migration_office_original_conversion_closure_missing')
    for (const patch of [{ lease_epoch: '1' }, { attempts: '1' }, { parser_slot: '0' }, { stop_evidence: '{}' },
      { state: 'queued' }, { cancel_requested: 'false' }, { result: '{}' },
      { completed_at: new Date(Date.parse(cut.cut) + 60000).toISOString() }]) {
      expect(() => validate(patch)).toThrow('migration_office_original_tombstone_invalid')
    }
    expect(() => validateLegacyMigrationOffice(row, plan.rows, [...plan.files, { area: 'office', owner: f.alice.user,
      resource: row.values.id ?? '', path: '', kind: 'directory', sourcePath: null, bytes: null, sha256: null,
      mode: 448, uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }], cut.cut))
      .toThrow('migration_office_original_tombstone_invalid')
  }, false, false, false, false, false, false, false, false, true)
})

test('schema4 maintenance preserves original SSH formats, historical receipts, retained fields and expired capabilities', async () => {
  await fixture(async (f) => {
    const owned = f.ssh
    if (!owned || !f.sshEvidence) throw new Error('Owned original SSH management inventory missing')
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'ssh-management'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    for (const table of LEGACY_MIGRATION_SSH_TABLES) {
      expect(output.tableCounts[table]).toBe(String(f.capture.tables[table]?.length))
      expect(Number(output.tableCounts[table])).toBeGreaterThan(0)
    }
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const service = new SshConnectionService(f.target, owned.key, 'legacy.example:22,private.example:2222')
    const snapshots = async () => {
      const result: Record<string, unknown> = {}
      for (const table of LEGACY_MIGRATION_SSH_TABLES) result[table] = (await f.target.query(`SELECT * FROM "${table}"`)).rows
      return result
    }
    const before = await snapshots()
    const tasks = new TaskStore(f.target, { ...taskLimits, sshEnabled: true })
    for (const operation of owned.operations) {
      const actor = operation.userId === f.alice.user ? alice : bob
      expect(await tasks.accept(actor.user, sessionId.parse(operation.sessionId), operation.requestId, operation.input, actor.token))
        .toMatchObject({ operationId: operation.operationId, state: 'failed' })
      const row = (await f.target.query<{ selection: string }>('SELECT ssh_selection::text AS selection FROM pe_operations WHERE id=$1',
        [operation.operationId])).rows[0]
      expect(row?.selection).toBe(f.capture.tables.pe_operations?.find(item => item.id === operation.operationId)?.ssh_selection)
    }
    expect(await service.receipt(alice.user, owned.legacyInput.requestId)).toMatchObject({ item: owned.legacyCreated })
    expect(await service.toggle(alice.user, owned.legacyCreated.connectionId, owned.toggleRequestId, 1, false)).toEqual(owned.toggled)
    expect(await service.update(alice.user, owned.retainedInput)).toEqual(owned.retained)
    expect(await service.remove(alice.user, owned.deleteInput)).toEqual(owned.deleted)
    expect((await service.listManaged(alice.user)).items).toEqual([])
    expect(await service.receipt(bob.user, owned.legacyInput.requestId)).toEqual({ item: null })
    await expect(service.metadataForVersion(bob.user, owned.legacyCreated.connectionId, 1))
      .rejects.toMatchObject({ code: 'ssh_connection_not_found' })
    expect(await service.metadataForVersion(alice.user, owned.legacyCreated.connectionId, 1))
      .toMatchObject({ displayName: owned.legacyCreated.displayName, authentication: 'password', workingDirectory: null })
    expect(await service.metadataForVersion(bob.user, owned.privateCreated.connectionId, 1))
      .toMatchObject({ authentication: 'private_key', passphraseConfigured: true })
    expect(await service.update(bob.user, owned.clearInput)).toEqual(owned.cleared)
    expect(await service.credentialForCall(bob.user, owned.privateCreated.connectionId, 3)).toMatchObject({
      credential: { kind: 'private_key', privateKey: 'original-private-key' }, workingDirectory: '/original/private/path' })
    expect((await service.credentialForCall(bob.user, owned.bobLegacyCreated.connectionId, 1)).credential)
      .toEqual({ kind: 'password', password: '{"formatVersion":2,"password":"JSON-shaped raw original password"}' })
    await expect(service.credentialForCall(alice.user, owned.legacyCreated.connectionId, 4))
      .rejects.toMatchObject({ code: 'ssh_connection_not_found' })
    await expect(service.update(alice.user, { ...owned.retainedInput,
      configuration: { ...owned.retainedInput.configuration, displayName: 'Changed original retry' } }))
      .rejects.toMatchObject({ code: 'request_id_conflict' })
    const server = createServer((request, response) => {
      const ticket = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1]
      if (!ticket) { response.writeHead(401).end(); return }
      void service.upload(ticket, request).then((value) => { sendJson(response, value) },
        (error: unknown) => { sendFailure(response, error) })
    })
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Owned original SSH HTTP port missing')
      for (const ticket of [owned.consumedTicket, owned.privateConsumedTicket, owned.pendingTicket]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/ssh/upload`, { method: 'POST',
          headers: { authorization: `Bearer ${ticket}` }, signal: AbortSignal.timeout(5000) })
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ error: 'invalid_ssh_ticket' })
      }
    } finally { await new Promise<void>((done, reject) => server.close((error) => { if (error) reject(error); else done() })) }
    expect(await snapshots()).toEqual(before)
    const encrypted = (await f.target.query<{ connection_id: string; credential_revision: number; bytes: string }>(
      'SELECT connection_id,credential_revision,encrypted_credential::text AS bytes FROM pe_ssh_credential_versions')).rows
    for (const row of encrypted) expect(row.bytes).toBe(f.capture.tables.pe_ssh_credential_versions?.find(item =>
      item.connection_id === row.connection_id && item.credential_revision === String(row.credential_revision))?.encrypted_credential)
    expect(owned).toMatchObject({ sshWorkerStarted: false, networkDispatchStarted: false, physicalStopReceipt: null })
    await identities.logout(alice.token); await identities.logout(bob.token)
  }, false, false, false, false, false, false, false, false, false, true)
})

test('SSH migration rejects changed keys, original AAD, HMAC, retained fields, history and active capabilities', async () => {
  await fixture(async (f) => {
    if (!f.ssh || !f.sshEvidence) throw new Error('Owned original SSH evidence missing')
    const context = createLegacyMigrationSshContext(f.sshEvidence, f.capture.source.codeId)
    const cut = cutFor(f), histories = migrateLegacyHistories(f.capture, f.histories, budgets), migrationId = randomUUID()
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256,
      cut, budgets, [], undefined, context)
    const selected = plan.rows.find(item => item.table === 'pe_operations'
      && item.values.id === f.ssh?.operations[0]?.operationId)
    if (!selected) throw new Error('Original accepted SSH selection fixture missing')
    const selection = z.array(z.record(z.string(), z.json())).parse(JSON.parse(selected.values.ssh_selection ?? ''))
    expect(() => {
      validateLegacyMigrationSshOperation({ ...selected, values: { ...selected.values,
        ssh_selection: JSON.stringify(selection.map(item => ({ ...item, displayName: 'changed-original-selection' }))) } }, plan.rows, budgets)
    }).toThrow('migration_ssh_original_selection_identity')
    const row = (table: string) => {
      const found = plan.rows.find(item => item.table === table)
      if (!found) throw new Error('Owned original SSH negative row missing')
      return found
    }
    const validate = (table: string, patch: Record<string, string | null>, selectedContext = context) => {
      const original = row(table), changed = { ...original, values: { ...original.values, ...patch } }
      return validateLegacyMigrationSsh(changed, plan.rows.map(item => item === original ? changed : item), budgets,
        f.capture.source.cut, selectedContext)
    }
    expect(() => prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files,
      cut.filesSha256, cut, budgets)).toThrow('migration_ssh_original_evidence_missing')
    expect(() => createLegacyMigrationSshContext({ ...f.sshEvidence, sourceCodeId: 'changed' }, f.capture.source.codeId))
      .toThrow('migration_ssh_original_key_identity')
    expect(() => createLegacyMigrationSshContext({ ...f.sshEvidence, key: 'invalid' }, f.capture.source.codeId))
      .toThrow('migration_ssh_original_key_invalid')
    const wrong = createLegacyMigrationSshContext({ ...f.sshEvidence, key: randomBytes(32).toString('base64url') }, f.capture.source.codeId)
    expect(() => validate('pe_ssh_credential_versions', {}, wrong)).toThrow('migration_ssh_original_credential_unavailable')
    const key = row('pe_ssh_credential_versions'), bytes = key.values.encrypted_credential ?? ''
    const changedBytes = bytes.slice(0, -2) + (bytes.endsWith('00') ? '01' : '00')
    expect(() => validate('pe_ssh_credential_versions', { encrypted_credential: changedBytes }))
      .toThrow('migration_ssh_original_credential_unavailable')
    expect(() => validate('pe_ssh_credential_versions', { aad_request_id: randomUUID() }))
      .toThrow('migration_ssh_original_credential_identity')
    expect(() => validate('pe_ssh_management_requests', { request_digest: 'c'.repeat(64) }))
      .toThrow('migration_ssh_original_request_digest')
    expect(() => validate('pe_ssh_connections', { revision: '99' })).toThrow('migration_ssh_original_reference_missing')
    expect(() => validate('pe_ssh_connections', { encrypted_credential: changedBytes }))
      .toThrow('migration_ssh_original_current_pointer')
    expect(() => validate('pe_ssh_upload_intents', { expires_at: '2099-01-01T00:00:00.000000Z' }))
      .toThrow('migration_ssh_original_ticket_identity')
    expect(() => validate('pe_ssh_upload_intents', { request_digest: 'a'.repeat(64) }))
      .toThrow('migration_ssh_original_ticket_identity')
    expect(() => validate('pe_ssh_updates', { request_digest: 'e'.repeat(64) })).toThrow('migration_ssh_original_legacy_update')
    const replaced = plan.rows.find(item => item.table === 'pe_ssh_credential_versions'
      && item.values.connection_id === f.ssh?.privateCreated.connectionId && item.values.credential_revision === '2')
    const replacedRequest = plan.rows.find(item => item.table === 'pe_ssh_management_requests'
      && item.values.request_id === f.ssh?.replaceInput.requestId)
    if (!replaced || !replacedRequest) throw new Error('Owned original retained SSH secret closure missing')
    const cipher = new SshCredentialCipher(f.ssh.key)
    const sealed = cipher.seal({ userId: f.bob.user, connectionId: f.ssh.privateCreated.connectionId,
      credentialRevision: 2, credentialKind: 'private_key', formatVersion: 2, aadRequestId: null },
    { kind: 'private_key', privateKey: 'changed-retained-key', passphrase: 'later-original-passphrase' })
    const changed = { ...replaced, values: { ...replaced.values, encrypted_credential: `\\x${sealed.toString('hex')}` } }
    const changedRows = plan.rows.map(item => item === replaced ? changed : item)
    expect(() => validateLegacyMigrationSsh(replacedRequest, changedRows, budgets, f.capture.source.cut, context))
      .toThrow('migration_ssh_original_retained_secret_changed')
    await writeFile(join(f.root, 'ssh-original-key.json'), JSON.stringify({ ...f.sshEvidence, keyId: 'changed-original-key-id' }),
      { mode: 0o600 })
    await migrateFixtureCurrent(f, 'ssh-key-tampered', 1)
    expect(JSON.parse(await readFile(join(f.root, 'ssh-key-tampered-failure.json'), 'utf8')))
      .toMatchObject({ phase: 'failed', code: 'migration_cut_mismatch', systemMigrationComplete: false })
    expect((await f.target.query<{ n: string }>('SELECT count(*) AS n FROM pg_tables WHERE schemaname=\'public\'')).rows[0]?.n).toBe('0')
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, true)
})

function neverStartedSshRunner(key: string) {
  return new SshRunnerOrchestrator({
    call: async () => { throw new Error('No-start SSH fixture attempted a Kubernetes call') },
    resourcePath: () => { throw new Error('No-start SSH fixture attempted a Kubernetes path') },
    proxyPath: () => { throw new Error('No-start SSH fixture attempted a Runner proxy') },
  }, { namespace: 'owned-offline-ssh', runtimeClassName: 'owned-offline-runtime',
    image: `registry.example/owned-ssh@sha256:${'a'.repeat(64)}`, controlKey: key, readyTimeoutMs: 1000,
    platformIngressCidrs: ['127.0.0.1/32'], forbiddenProbe: { ip: '198.51.100.1', port: 8080 },
    proveForbiddenListener: async () => { throw new Error('No-start SSH fixture attempted a network probe') } })
}

test('schema4 preserves original no-start SSH command decisions, encrypted approvals and continuations', async () => {
  await fixture(async (f) => {
    const owned = f.ssh
    if (!owned || owned.actions.length !== 4) throw new Error('Owned original SSH no-start action inventory missing')
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'ssh-no-start-actions'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_ssh_execute_actions).toBe('4')
    expect(output.tableCounts.pe_ssh_calls).toBe('1')
    const identities = new IdentityService(f.target, 60000), bob = await identities.login('migration-bob', password, 'approval')
    const alice = await identities.login('migration-alice', password, 'approval')
    const tasks = new TaskStore(f.target, { ...taskLimits, sshEnabled: true }), calls = new SshCallStore(f.target)
    const connections = new SshConnectionService(f.target, owned.key, 'legacy.example:22,private.example:2222')
    const execute = new SshExecuteService(tasks, calls, connections, neverStartedSshRunner(owned.key), owned.key,
      randomUUID(), 60000, 500, async () => { throw new Error('Original no-start SSH retry attempted DNS') })
    const before = (await f.target.query('SELECT * FROM pe_ssh_execute_actions ORDER BY id')).rows
    const callsBefore = (await f.target.query<{ id: string }>('SELECT * FROM pe_ssh_calls ORDER BY id')).rows
    try {
      const approvals = await execute.approvals(bob.user)
      for (const action of owned.actions) {
        expect(await execute.status(bob.user, action.proposed.actionId)).toEqual(action.terminal)
        expect(approvals.items.find(item => item.actionId === action.proposed.actionId)?.command).toBe(action.reviewedCommand)
        if (action.decision === 'reject') expect(await execute.decide(bob.user, action.proposed.actionId,
          action.proposed.fingerprint, false, bob.token)).toEqual(action.terminal)
        else expect(await execute.cancel(bob.user, action.proposed.actionId, { token: bob.token, audience: 'approval' }))
          .toMatchObject({ actionId: action.terminal.actionId, state: action.terminal.state, fingerprint: action.terminal.fingerprint })
        await expect(execute.status(alice.user, action.proposed.actionId)).rejects.toMatchObject({ code: 'ssh_action_not_found' })
        const next = (await f.target.query<{ source: string; parent: string; input: string }>(
          'SELECT source,source_ssh_execute_action_id AS parent,input FROM pe_operations WHERE id=$1',
          [action.continuationOperationId])).rows[0]
        expect(next).toMatchObject({ source: 'ssh_execute_result', parent: action.proposed.actionId })
        expect(next?.input).toBe(f.capture.tables.pe_operations?.find(item => item.id === action.continuationOperationId)?.input)
      }
      expect(await calls.claim(randomUUID(), 60000, 'ssh.execute')).toBeNull()
      const callId = callsBefore[0]?.id
      const call = z.object({ id: z.string(), state: z.string(), lease_epoch: z.number(), pod_uid: z.null(), dispatch_digest: z.null() })
        .parse(await calls.get(bob.user, z.uuid().parse(callId)))
      expect(call).toMatchObject({ state: 'cancelled', lease_epoch: 0, pod_uid: null, dispatch_digest: null })
      await expect(calls.get(alice.user, call.id)).rejects.toMatchObject({ code: 'ssh_call_not_found' })
      expect((await f.target.query('SELECT * FROM pe_ssh_execute_actions ORDER BY id')).rows).toEqual(before)
      expect((await f.target.query('SELECT * FROM pe_ssh_calls ORDER BY id')).rows).toEqual(callsBefore)
    } finally { await execute.close(); await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, true, true)
})

test('SSH no-start migration rejects command AAD/HMAC changes, worker markers and changed continuation snapshots', async () => {
  await fixture(async (f) => {
    if (!f.ssh || !f.sshEvidence) throw new Error('Owned original no-start SSH evidence missing')
    const context = createLegacyMigrationSshContext(f.sshEvidence, f.capture.source.codeId), cut = cutFor(f), migrationId = randomUUID()
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files,
      cut.filesSha256, cut, budgets, [], undefined, context)
    const action = plan.rows.find(row => row.table === 'pe_ssh_execute_actions' && row.values.state === 'rejected')
    const call = plan.rows.find(row => row.table === 'pe_ssh_calls')
    if (!action || !call) throw new Error('Owned original SSH negative action/call missing')
    const cipher = new SshActionCipher(f.ssh.key)
    const validate = (row: typeof action, patch: Record<string, string | null>, rows = plan.rows) => {
      const changed = { ...row, values: { ...row.values, ...patch } }
      return validateLegacyMigrationSshAction(changed, rows.map(item => item === row ? changed : item), budgets,
        f.capture.source.cut, cipher)
    }
    for (const patch of [{ lease_epoch: '1' }, { dispatch_digest: 'a'.repeat(64) }, { pod_uid: randomUUID() }]) {
      expect(() => validate(call, patch)).toThrow('migration_ssh_action_original_worker_closure_missing')
    }
    expect(() => validate(call, { request_digest: 'f'.repeat(64) })).toThrow('migration_ssh_action_original_call_invalid')
    expect(() => validate(call, { kind: 'ssh.authenticate' })).toThrow('migration_ssh_authenticate_original_input_key_missing')
    expect(() => validate(action, { state: 'approved' })).toThrow('migration_ssh_action_original_terminal_invalid')
    expect(() => validate(action, { result_sealed: '\\x00' })).toThrow('migration_ssh_action_original_terminal_invalid')
    expect(() => validate(action, { decided_at: null })).toThrow('migration_ssh_action_original_decision_closure')
    const bytes = action.values.command_sealed ?? ''
    const tampered = bytes.slice(0, -2) + (bytes.endsWith('00') ? '01' : '00')
    expect(() => validate(action, { command_sealed: tampered })).toThrow('migration_ssh_action_original_command_unavailable')
    const identity = { id: action.values.id ?? '', user_id: action.values.user_id ?? '', operation_id: action.values.operation_id ?? '',
      connection_id: action.values.connection_id ?? '', connection_revision: Number(action.values.connection_revision),
      credential_revision: Number(action.values.credential_revision), request_digest: action.values.request_digest ?? '' }
    const changed = cipher.seal(identity, 'command', 'changed original command')
    expect(() => validate(action, { command_sealed: `\\x${changed.toString('hex')}` })).toThrow('migration_ssh_action_original_hmac')
    const next = plan.rows.find(row => row.table === 'pe_operations' && row.values.source_ssh_execute_action_id === action.values.id)
    if (!next) throw new Error('Owned original SSH continuation missing')
    expect(() => validate(action, {}, plan.rows.filter(row => row !== next)))
      .toThrow('migration_ssh_action_original_continuation_identity')
    expect(() => validate(action, {}, plan.rows.map(row => row === next ? { ...row, values: { ...row.values, input: 'changed outcome' } } : row)))
      .toThrow('migration_ssh_action_original_continuation_result')
    expect(() => validate(action, {}, plan.rows.map(row => row === next
      ? { ...row, values: { ...row.values, ssh_selection: '[]' } } : row))).toThrow('migration_ssh_action_original_continuation_snapshot')
    const wrong = new SshActionCipher(randomBytes(32).toString('base64url'))
    expect(() => validateLegacyMigrationSshAction(action, plan.rows, budgets, f.capture.source.cut, wrong))
      .toThrow('migration_ssh_action_original_command_unavailable')
  }, false, false, false, false, false, false, false, false, false, true, true)
})

test('schema4 preserves original STDIO metadata, case-sensitive input digests and accepted historical selections', async () => {
  await fixture(async (f) => {
    if (!f.stdio) throw new Error('Owned original STDIO metadata inventory missing')
    const owned = f.stdio, sourceBefore = (await f.source.query('SELECT * FROM pe_stdio_mcp_updates ORDER BY request_id')).rows
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'stdio-metadata'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_stdio_mcp_connections).toBe('2')
    expect(output.tableCounts.pe_stdio_mcp_updates).toBe('3')
    expect(output.tableCounts.pe_stdio_mcp_calls).toBe('0')
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password), tasks = new TaskStore(f.target, { ...taskLimits, stdioMcpEnabled: true })
    const service = new StdioMcpService(tasks, null, randomUUID(), 60000)
    const connectionsBefore = (await f.target.query('SELECT * FROM pe_stdio_mcp_connections ORDER BY id')).rows
    const updatesBefore = (await f.target.query('SELECT * FROM pe_stdio_mcp_updates ORDER BY request_id')).rows
    try {
      expect(await service.list(alice.user)).toMatchObject({ available: false, items: [owned.current] })
      expect(await service.list(bob.user)).toMatchObject({ available: false, items: [owned.bobCreated] })
      expect(await service.install(alice.user, owned.aliceInstall.requestId, owned.aliceInstall.name)).toEqual(owned.aliceCreated)
      expect(await service.install(bob.user, owned.bobInstall.requestId, owned.bobInstall.name)).toEqual(owned.bobCreated)
      for (const record of owned.records) {
        expect(await service.toggle(alice.user, record.input.id, record.requestId, record.input.baseRevision, record.input.enabled))
          .toEqual(record.result)
      }
      const original = owned.records[0]
      if (!original) throw new Error('Owned original case-sensitive STDIO receipt missing')
      expect(original.input.id).toBe(original.input.id.toUpperCase())
      await expect(service.toggle(alice.user, original.input.id.toLowerCase(), original.requestId, 1, false))
        .rejects.toMatchObject({ code: 'request_id_conflict' })
      await expect(service.toggle(bob.user, original.input.id, randomUUID(), 4, false))
        .rejects.toMatchObject({ code: 'stdio_mcp_connection_not_found' })
      await expect(service.install(alice.user, owned.aliceInstall.requestId, 'Changed retained name'))
        .rejects.toMatchObject({ code: 'request_id_conflict' })
      for (const operation of owned.operations) {
        const actor = operation.userId === f.alice.user ? alice : bob
        expect(await tasks.accept(actor.user, sessionId.parse(operation.sessionId), requestId.parse(operation.requestId),
          operation.input, actor.token)).toMatchObject({ operationId: operation.operationId, state: 'failed' })
        expect((await f.target.query<{ selection: string }>(
          'SELECT stdio_mcp_selection::text AS selection FROM pe_operations WHERE id=$1', [operation.operationId])).rows[0]?.selection)
          .toBe(f.capture.tables.pe_operations?.find(item => item.id === operation.operationId)?.stdio_mcp_selection)
      }
      expect((await f.target.query('SELECT * FROM pe_stdio_mcp_connections ORDER BY id')).rows).toEqual(connectionsBefore)
      expect((await f.target.query('SELECT * FROM pe_stdio_mcp_updates ORDER BY request_id')).rows).toEqual(updatesBefore)
      expect((await f.source.query('SELECT * FROM pe_stdio_mcp_updates ORDER BY request_id')).rows).toEqual(sourceBefore)
      expect((await f.target.query<{ n: string }>('SELECT count(*) AS n FROM pe_operations')).rows[0]?.n).toBe('3')
      expect(owned).toMatchObject({ hostStarted: false, stdioWorkerStarted: false,
        networkDispatchStarted: false, physicalStopReceipt: null })
    } finally { await service.close(); await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('STDIO metadata migration rejects missing original inputs, changed digests, incomplete history and rewritten selections', async () => {
  await fixture(async (f) => {
    if (!f.stdio || !f.stdioEvidence) throw new Error('Owned original STDIO input evidence missing')
    const context = createLegacyMigrationStdioContext(f.stdioEvidence, f.capture.source.codeId, budgets)
    const cut = cutFor(f), migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files,
      cut.filesSha256, cut, budgets, [], undefined, undefined, context)
    const update = plan.rows.find(item => item.table === 'pe_stdio_mcp_updates')
    const owner = plan.rows.find(item => item.table === 'pe_stdio_mcp_connections' && item.values.user_id === f.alice.user)
    const operation = plan.rows.find(item => item.table === 'pe_operations' && item.values.session_id === f.alice.session)
    if (!update || !owner || !operation) throw new Error('Owned original STDIO negative rows missing')
    const validate = (row: typeof update, patch: Record<string, string | null>, rows = plan.rows, original = context) => {
      const changed = { ...row, values: { ...row.values, ...patch } }
      return validateLegacyMigrationStdio(changed, rows.map(item => item === row ? changed : item), budgets, f.capture.source.cut, original)
    }
    expect(() => validateLegacyMigrationStdio(update, plan.rows, budgets, f.capture.source.cut))
      .toThrow('migration_stdio_original_evidence_missing')
    expect(() => validate(update, {}, plan.rows, { evidenceSha256: context.evidenceSha256 }))
      .toThrow('migration_stdio_original_evidence_missing')
    expect(() => validate(update, { request_digest: 'f'.repeat(64) })).toThrow('migration_stdio_receipt_invalid')
    expect(() => validate(owner, { enabled: 'true' })).toThrow('migration_stdio_toggle_chain')
    expect(() => validate(owner, { install_request_id: randomUUID() })).toThrow('migration_stdio_connection_invalid')
    expect(() => validate(owner, { updated_at: '2099-01-01T00:00:00Z' })).toThrow('migration_stdio_connection_invalid')
    expect(() => validate(owner, {}, plan.rows.filter(item => item !== update))).toThrow('migration_stdio_input_inventory')
    const changedInput = structuredClone(f.stdioEvidence)
    const first = changedInput.requests[0]
    if (!first) throw new Error('Owned original uppercase STDIO input missing')
    first.input.id = first.input.id.toLowerCase()
    const changedContext = createLegacyMigrationStdioContext(changedInput, f.capture.source.codeId, budgets)
    expect(() => validate(owner, {}, plan.rows, changedContext)).toThrow('migration_stdio_receipt_invalid')
    expect(() => createLegacyMigrationStdioContext({ ...f.stdioEvidence, sourceCodeId: 'changed-source' }, f.capture.source.codeId, budgets))
      .toThrow('migration_stdio_original_input_identity')
    const rewritten = { ...operation, values: { ...operation.values, stdio_mcp_selection: JSON.stringify([
      { connectionId: f.stdio.current.connectionId, revision: 4 }]) } }
    expect(() => { validateLegacyMigrationStdioOperation(rewritten, plan.rows, budgets) })
      .toThrow('migration_stdio_operation_selection_invalid')
    const otherOwner = { ...operation, values: { ...operation.values, stdio_mcp_selection: JSON.stringify([
      { connectionId: f.stdio.bobCreated.connectionId, revision: 1 }]) } }
    expect(() => { validateLegacyMigrationStdioOperation(otherOwner, plan.rows, budgets) }).toThrow('migration_stdio_owner_missing')
    await writeFile(join(f.root, 'stdio-original-inputs.json'), JSON.stringify(changedInput), { mode: 0o600 })
    await migrateFixtureCurrent(f, 'stdio-changed-signed-input', 1)
    expect((await f.target.query<{ n: string }>("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0]?.n).toBe('0')
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('schema4 preserves original STDIO v2 management requests, configurations and deleted-history retries', async () => {
  await fixture(async (f) => {
    if (!f.stdioV2) throw new Error('Owned original STDIO v2 metadata missing')
    const owned = f.stdioV2, output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'stdio-v2-metadata'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_stdio_v2_connections).toBe('2')
    expect(output.tableCounts.pe_stdio_v2_configurations).toBe('3')
    expect(output.tableCounts.pe_stdio_v2_management_requests).toBe('5')
    expect(output.tableCounts.pe_stdio_v2_actions).toBe('0')
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const service = new StdioConnectionServiceV2(f.target, owned.limits, owned.management)
    const originalTables = ['pe_stdio_v2_connections', 'pe_stdio_v2_configurations', 'pe_stdio_v2_management_requests']
    const snapshot = async () => {
      const value: Record<string, unknown> = {}
      for (const table of originalTables) value[table] = (await f.target.query(`SELECT * FROM "${table}"`)).rows
      return value
    }
    const before = await snapshot()
    try {
      expect(await service.list(alice.token, {})).toEqual({ items: [], next: null })
      expect(await service.list(bob.token, {})).toEqual(owned.bobList)
      expect(await service.create(alice.token, owned.aliceCreate)).toEqual(owned.created)
      expect(await service.update(alice.token, owned.aliceUpdate)).toEqual(owned.updated)
      expect(await service.toggle(alice.token, owned.aliceToggle)).toEqual(owned.toggled)
      expect(await service.remove(alice.token, owned.aliceDelete)).toEqual(owned.deleted)
      expect(await service.create(bob.token, owned.bobCreate)).toEqual(owned.bobCreated)
      for (const receipt of [owned.created, owned.updated, owned.toggled, owned.deleted]) {
        expect(await service.receipt(alice.token, { requestId: receipt.requestId })).toEqual(receipt)
        await expect(service.receipt(bob.token, { requestId: receipt.requestId }))
          .rejects.toMatchObject({ code: 'stdio_v2_request_not_found' })
      }
      await expect(service.create(alice.token, stdioV2Schemas.create.parse({ ...owned.aliceCreate,
        requestId: owned.aliceCreate.requestId.toLowerCase() })))
        .rejects.toMatchObject({ code: 'stdio_v2_request_conflict' })
      await expect(service.update(alice.token, { ...owned.aliceUpdate,
        configuration: { ...owned.aliceUpdate.configuration, name: 'changed retained name' } }))
        .rejects.toMatchObject({ code: 'stdio_v2_request_conflict' })
      const textRows = (await f.target.query<{ connection_id: string; revision: number; text: string }>(
        'SELECT connection_id,revision,configuration::text AS text FROM pe_stdio_v2_configurations')).rows
      for (const row of textRows) expect(row.text).toBe(f.capture.tables.pe_stdio_v2_configurations?.find(item =>
        item.connection_id === row.connection_id && item.revision === String(row.revision))?.configuration)
      expect(await snapshot()).toEqual(before)
      expect(owned).toMatchObject({ programStarted: false, hostStarted: false, workerStarted: false,
        networkDispatchStarted: false, physicalStopReceipt: null })
    } finally { await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('STDIO v2 metadata rejects altered request/configuration domains, absent history and forged original parser policy', async () => {
  await fixture(async (f) => {
    if (!f.stdioV2 || !f.stdioV2Policy) throw new Error('Owned original STDIO v2 policy missing')
    const context = createLegacyMigrationStdioV2Context(f.stdioV2Policy, f.capture.source.codeId), cut = cutFor(f)
    const migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files,
      cut.filesSha256, cut, budgets, [], undefined, undefined, undefined, context)
    const owner = plan.rows.find(item => item.table === 'pe_stdio_v2_connections' && item.values.user_id === f.alice.user)
    const configuration = plan.rows.find(item => item.table === 'pe_stdio_v2_configurations' && item.values.user_id === f.alice.user
      && item.values.connection_id === owner?.values.id && item.values.revision === '1')
    const request = plan.rows.find(item => item.table === 'pe_stdio_v2_management_requests' && item.values.user_id === f.alice.user
      && item.values.purpose === 'create')
    if (!owner || !configuration || !request) throw new Error('Owned original STDIO v2 negative rows missing')
    const validate = (row: typeof owner, patch: Record<string, string | null>, rows = plan.rows, policy = context) => {
      const changed = { ...row, values: { ...row.values, ...patch } }
      return validateLegacyMigrationStdioV2Metadata(changed, rows.map(item => item === row ? changed : item),
        budgets, f.capture.source.cut, policy)
    }
    expect(() => validateLegacyMigrationStdioV2Metadata(owner, plan.rows, budgets, f.capture.source.cut))
      .toThrow('migration_stdio_v2_original_policy_missing')
    expect(() => validate(owner, {}, plan.rows, { evidenceSha256: context.evidenceSha256 }))
      .toThrow('migration_stdio_v2_original_policy_missing')
    expect(() => validate(configuration, { config_digest: 'f'.repeat(64) })).toThrow('migration_stdio_v2_configuration_digest')
    expect(() => validate(request, { request_digest: configuration.values.config_digest ?? '' })).toThrow('migration_stdio_v2_receipt_invalid')
    expect(() => validate(request, { purpose: 'check' })).toThrow('migration_stdio_v2_execution_owner_missing')
    expect(() => validate(owner, { current_catalog_id: randomUUID() })).toThrow('migration_stdio_v2_catalog_owner_missing')
    expect(() => validate(owner, { enabled: 'true' })).toThrow('migration_stdio_v2_catalog_owner_missing')
    expect(() => validate(owner, { deleted_at: null })).toThrow('migration_stdio_v2_deletion_receipt')
    expect(() => validate(owner, {}, plan.rows.filter(item => item !== configuration))).toThrow('migration_stdio_v2_configuration_chain')
    expect(() => validate(configuration, {}, plan.rows.filter(item => item !== request)))
      .toThrow('migration_stdio_v2_configuration_origin_missing')
    expect(() => createLegacyMigrationStdioV2Context({ ...f.stdioV2Policy, sourceCodeId: 'changed-original-code' }, f.capture.source.codeId))
      .toThrow('migration_stdio_v2_original_policy_identity')
    await writeFile(join(f.root, 'stdio-v2-original-policy.json'), JSON.stringify({ ...f.stdioV2Policy,
      management: { ...f.stdioV2Policy.management, pageItems: 9 } }), { mode: 0o600 })
    await migrateFixtureCurrent(f, 'stdio-v2-changed-signed-policy', 1)
    expect((await f.target.query<{ n: string }>("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0]?.n).toBe('0')
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('schema4 preserves original Connector permissions and rejected decisions through ordinary consumers', async () => {
  await fixture(async (f) => {
    if (!f.connector) throw new Error('Owned original Connector rejection missing')
    const owned = f.connector, output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(),
      tableCounts: z.record(z.string(), z.string()) }).parse(await migrateFixtureCurrent(f, 'connector-rejected'))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect(output.tableCounts.pe_connector_permissions).toBe('4')
    expect(output.tableCounts.pe_connector_actions).toBe('1')
    expect(output.tableCounts.pe_operations).toBe('2')
    const identities = new IdentityService(f.target, 60000), bob = await identities.login('migration-bob', password, 'approval')
    const alice = await identities.login('migration-alice', password, 'approval')
    const service = new ConnectorService(new TaskStore(f.target, taskLimits), 'http://127.0.0.1:9', 'owned-unused-key', 1000, 500)
    const before = (await f.target.query('SELECT * FROM pe_connector_actions')).rows
    const permissionsBefore = (await f.target.query('SELECT * FROM pe_connector_permissions ORDER BY user_id,capability')).rows
    try {
      expect(await service.permissions(bob.user)).toEqual(owned.permissions)
      expect(await service.permissions(alice.user)).toEqual({ items: [
        { capability: 'trial_note_append', enabled: true }, { capability: 'trial_note_query', enabled: true }] })
      expect(await service.list(bob.user)).toMatchObject({ items: [owned.terminal] })
      expect(await service.list(alice.user)).toEqual({ items: [] })
      expect(await service.decide(bob.user, owned.terminal.actionId, owned.terminal.fingerprint, false, bob.token)).toEqual(owned.terminal)
      await expect(service.decide(alice.user, owned.terminal.actionId, owned.terminal.fingerprint, false, alice.token))
        .rejects.toMatchObject({ code: 'action_not_found' })
      const next = (await f.target.query<{ source: string; input: string }>('SELECT source,input FROM pe_operations WHERE id=$1',
        [owned.continuationOperationId])).rows[0]
      expect(next?.source).toBe('platform_action')
      expect(next?.input).toBe(f.capture.tables.pe_operations?.find(item => item.id === owned.continuationOperationId)?.input)
      expect((await f.target.query('SELECT * FROM pe_connector_actions')).rows).toEqual(before)
      expect((await f.target.query('SELECT * FROM pe_connector_permissions ORDER BY user_id,capability')).rows).toEqual(permissionsBefore)
      expect((await f.target.query<{ n: string }>('SELECT count(*) AS n FROM pe_operations')).rows[0]?.n).toBe('2')
      expect(owned).toMatchObject({ connectorWorkerStarted: false, hostStarted: false,
        networkDispatchStarted: false, physicalStopReceipt: null })
    } finally { await service.close(); await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('Connector migration rejects original dispatch markers, changed requests and lost continuation snapshots', async () => {
  await fixture(async (f) => {
    const cut = cutFor(f), migrationId = randomUUID(), histories = migrateLegacyHistories(f.capture, f.histories, budgets)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets)
    const action = plan.rows.find(item => item.table === 'pe_connector_actions')
    const permission = plan.rows.find(item => item.table === 'pe_connector_permissions')
    if (!action || !permission) throw new Error('Owned original Connector negative rows missing')
    const validate = (row: typeof action, patch: Record<string, string | null>, rows = plan.rows) => {
      const changed = { ...row, values: { ...row.values, ...patch } }
      return validateLegacyMigrationConnector(changed, rows.map(item => item === row ? changed : item), budgets, f.capture.source.cut)
    }
    for (const patch of [{ attempts: '1' }, { state: 'approved' }, { lease_owner: randomUUID() }, { result: '{}' }]) {
      expect(() => validate(action, patch)).toThrow('migration_connector_original_dispatch_closure_missing')
    }
    expect(() => validate(action, { request_digest: 'f'.repeat(64) })).toThrow('migration_connector_original_decision_invalid')
    expect(() => validate(action, { request: JSON.stringify({ text: 'changed note' }) }))
      .toThrow('migration_connector_original_decision_invalid')
    expect(() => validate(permission, { capability: 'unknown_connector' })).toThrow('migration_connector_permission_invalid')
    expect(() => validate(permission, { updated_at: '2099-01-01T00:00:00Z' })).toThrow('migration_connector_future')
    const next = plan.rows.find(item => item.table === 'pe_operations' && item.values.source_action_id === action.values.id)
    if (!next) throw new Error('Owned original Connector continuation missing')
    expect(() => validate(action, {}, plan.rows.filter(item => item !== next))).toThrow('migration_connector_original_continuation_identity')
    expect(() => validate(action, {}, plan.rows.map(item => item === next ? { ...item, values: { ...item.values, input: 'changed result' } } : item)))
      .toThrow('migration_connector_original_continuation_result')
    expect(() => validate(action, {}, plan.rows.map(item => item === next
      ? { ...item, values: { ...item.values, settings: '{"model":"changed"}' } } : item)))
      .toThrow('migration_connector_original_continuation_snapshot')
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('schema4 attachment aliases fit the original object-byte budget and keep independent named authority', async () => {
  await fixture(async (f) => {
    const exactBytes = (await readFile(join(f.root, 'bundle', 'original.txt'))).byteLength
      + Buffer.byteLength('First original\n第二行\n') + Buffer.byteLength('outside fork prefix\n') + Buffer.byteLength('Bob original\n')
    const output = z.object({ version: z.number(), systemMigrationComplete: z.boolean(), receipts: z.array(z.object({
      sessionId: z.string(), storageSessionId: z.string(), file: nativeFileAttachment }).loose()) })
      .parse(await migrateFixtureCurrent(f, 'attachment-alias-budget', 0, { ...budgets, maxStorageBytes: exactBytes }))
    expect(output).toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    const aliases = output.receipts.filter(item => item.sessionId === f.child)
    expect(aliases.map(item => item.file.name).sort()).toEqual(['first.txt', 'same-bytes-other-name.txt'])
    const first = aliases[0], second = aliases[1]
    if (!first || !second) throw new Error('Owned original attachment aliases missing')
    expect(first.file.attachmentId).toBe(second.file.attachmentId)
    const root = join(f.root, 'candidate', 'attachments', f.alice.user, f.alice.session)
    const left = await lstat(storedFilePath(root, first.file), { bigint: true })
    const right = await lstat(storedFilePath(root, second.file), { bigint: true })
    expect(left.ino).toBe(right.ino); expect(left.dev).toBe(right.dev)
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const tasks = new TaskStore(f.target, taskLimits), files = new FileService(f.target, join(f.root, 'candidate', 'workspaces'))
    await files.init()
    const attachments = new NativeAttachments(f.target, tasks, files, { root: join(f.root, 'candidate', 'attachments'),
      maxFilesPerSession: 100, maxFilesPerUser: 100, maxBytesPerUser: 262144 }); await attachments.init()
    await tasks.accept(alice.user, sessionId.parse(f.child), requestId.parse(randomUUID()), 'Read migrated named aliases', alice.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('New current alias read grant missing')
    try {
      for (const item of aliases) {
        expect(grant.attachments).toContainEqual(item.file)
        expect(await attachments.readText(grant.token, item.file, 1, 1)).toMatchObject({ text: 'First original' })
      }
      await expect(attachments.readText(grant.token, { ...first.file, name: 'not-authorized.txt' }, 1, 1))
        .rejects.toMatchObject({ code: 'attachment_not_found' })
    } finally { await tasks.finish(grant.token, 'failed', 'owned_alias_fixture_no_host'); await identities.logout(alice.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
}, 120000)

test('schema4 original built-in Skill installs retain published versions, shared receipts and ordinary owner reads', async () => {
  await fixture(async (f) => {
    const original = f.builtin
    if (!original || !f.builtinEvidence) throw new Error('Original built-in Skill witness missing')
    const imported = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), phase: z.literal('current-schema-initialized'),
      systemMigrationComplete: z.literal(false), tableCounts: z.record(z.string(), z.string()) }).loose()
      .parse(await migrateFixtureCurrent(f, 'builtin-skills'))
    expect(imported.tableCounts.pe_builtin_skill_install_requests).toBe('3')
    expect(imported.tableCounts.pe_skill_package_versions).toBe('2')
    expect(imported.tableCounts.pe_user_skills).toBe('2')
    for (const entry of f.files.filter(file => file.area === 'skill-package')) {
      const target = join(f.root, 'candidate', 'skills', 'skill-packages', entry.owner, 'sha256', entry.resource, entry.path)
      expect((await lstat(target)).mode & 0o777).toBe(entry.mode)
    }
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const skills = new SkillService(f.target, join(f.root, 'candidate', 'workspaces'), join(f.root, 'candidate', 'skills'), 64)
    await skills.init()
    try {
      const requestsBefore = (await f.target.query<{ user_id: string; package_version_id: string }>(
        'SELECT * FROM pe_builtin_skill_install_requests ORDER BY request_id')).rows
      const versionsBefore = (await f.target.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows
      const skillsBefore = (await f.target.query('SELECT * FROM pe_user_skills ORDER BY id')).rows
      const first = original.records[0]!, reused = original.records[1]!, second = original.records[2]!
      expect(requestsBefore.filter(row => row.user_id === alice.user.userId).map(row => row.package_version_id))
        .toEqual([first.requestId, first.requestId])
      expect(await skills.read(alice.user, first.requestId)).toEqual(original.aliceRead)
      expect(await skills.read(bob.user, second.requestId)).toEqual(original.bobRead)
      expect((await skills.list(alice.user)).items).toHaveLength(1)
      expect((await skills.catalog(alice.user)).items.find(item => item.id === original.catalogId))
        .toMatchObject({ installedSkillId: first.requestId, version: original.version })
      for (const record of [first, reused]) {
        const retry = await skills.installBuiltin(alice.user, record.requestId, original.catalogId, original.version)
        expect(retry).toMatchObject({ skillId: first.requestId, version: '1.0.0', enabled: false,
          digest: original.aliceRead.digest, packageDigest: original.aliceRead.packageDigest,
          manifestDigest: original.aliceRead.manifestDigest })
      }
      expect(await skills.installBuiltin(bob.user, second.requestId, original.catalogId, original.version))
        .toMatchObject({ skillId: second.requestId, version: '1.0.0', enabled: true })
      await expect(skills.read(bob.user, first.requestId)).rejects.toMatchObject({ code: 'skill_not_found' })
      await expect(skills.installBuiltin(bob.user, reused.requestId, original.catalogId, original.version))
        .rejects.toMatchObject({ code: 'request_id_conflict' })
      await expect(skills.installBuiltin(alice.user, first.requestId, 'builtin.word', original.version))
        .rejects.toMatchObject({ code: 'request_id_conflict' })
      expect((await f.target.query('SELECT * FROM pe_builtin_skill_install_requests ORDER BY request_id')).rows).toEqual(requestsBefore)
      expect((await f.target.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows).toEqual(versionsBefore)
      expect((await f.target.query('SELECT * FROM pe_user_skills ORDER BY id')).rows).toEqual(skillsBefore)
    } finally { await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('built-in Skill migration requires original catalog ZIP and complete source-bound install witnesses', async () => {
  await fixture(async (f) => {
    if (!f.builtinEvidence) throw new Error('Original built-in Skill witness missing')
    const context = await createLegacyMigrationBuiltinContext(f.builtinEvidence, f.capture.source.codeId, budgets)
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), migrationId = randomUUID(), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets,
      [], undefined, undefined, undefined, undefined, context)
    const ledger = plan.rows.find(row => row.table === 'pe_builtin_skill_install_requests')
    if (!ledger) throw new Error('Original install ledger row missing')
    expect(validateLegacyMigrationBuiltinSkill(ledger, plan.rows, f.capture.source.cut, context)).toBe(true)
    expect(() => prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets))
      .toThrow('migration_builtin_original_evidence_missing')
    expect(() => validateLegacyMigrationBuiltinSkill(ledger, plan.rows, f.capture.source.cut, { ...context }))
      .toThrow('migration_builtin_original_evidence_missing')
    const missing = { ...f.builtinEvidence, requests: f.builtinEvidence.requests.slice(1) }
    const incomplete = await createLegacyMigrationBuiltinContext(missing, f.capture.source.codeId, budgets)
    expect(() => validateLegacyMigrationBuiltinSkill(ledger, plan.rows, f.capture.source.cut, incomplete))
      .toThrow('migration_builtin_original_input_inventory')
    const unrelated = plan.rows.map(row => row.table === 'pe_skill_package_versions'
      ? { ...row, values: { ...row.values, version: '9.9.9' } } : row)
    expect(() => validateLegacyMigrationBuiltinSkill(ledger, unrelated, f.capture.source.cut, context))
      .toThrow('migration_builtin_original_install_binding')
    const release = f.builtinEvidence.releases[0]!
    const archive = Buffer.from(release.archiveBase64, 'base64'); archive[archive.length - 1] = archive[archive.length - 1]! ^ 1
    await expect(createLegacyMigrationBuiltinContext({ ...f.builtinEvidence,
      releases: [{ ...release, archiveBase64: archive.toString('base64') }] }, f.capture.source.codeId, budgets))
      .rejects.toThrow('migration_builtin_original_archive_identity')
    await expect(createLegacyMigrationBuiltinContext({ ...f.builtinEvidence, catalogSha256: 'a'.repeat(64) },
      f.capture.source.codeId, budgets)).rejects.toThrow('migration_builtin_original_evidence_identity')
    const uid = process.getuid?.(), gid = process.getgid?.()
    if (uid === undefined || gid === undefined) throw new Error('Owned rollback fixture needs POSIX file ownership')
    const attachment = f.attachmentSources[0]!
    const originalPath = storedFilePath(f.attachmentRoots[attachment.rootId]!, attachment.file)
    const originalBytes = await readFile(originalPath), originalMode = (await lstat(originalPath)).mode & 0o777
    await chmod(originalPath, originalMode | 0o200)
    try {
      const changedBytes = Buffer.from(originalBytes); changedBytes[0] = changedBytes[0]! ^ 1
      await writeFile(originalPath, changedBytes)
      await expect(writeLegacyMigration(f.target, plan, { expectedDatabase: f.targetUrl.pathname.slice(1), statementTimeoutMs: 5000,
        attachmentSourceRoots: f.attachmentRoots, storage: { bundleRoot: join(f.root, 'bundle'), candidateRoot: join(f.root, 'candidate'),
          sourceUid: uid, sourceGid: gid, targetUid: uid, targetGid: gid } },
      new AbortController().signal)).rejects.toMatchObject({ code: 'migration_database_rejected' })
      await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await f.target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ n: '0' }])
    } finally { await writeFile(originalPath, originalBytes); await chmod(originalPath, originalMode) }
    const changed = { ...f.builtinEvidence, catalogText: f.builtinEvidence.catalogText + '\n' }
    changed.catalogSha256 = legacyDigest(changed.catalogText)
    await writeFile(join(f.root, 'builtin-original-evidence.json'), JSON.stringify(changed) + '\n', { mode: 0o600 })
    await migrateFixtureCurrent(f, 'builtin-changed-signed-evidence', 1)
    expect(JSON.parse(await readFile(join(f.root, 'builtin-changed-signed-evidence-failure.json'), 'utf8')))
      .toMatchObject({ code: 'migration_cut_mismatch' })
    expect((await f.target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ n: '0' }])
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
})


test('schema4 original STDIO live-probe refusal imports actual resource absence and ordinary failed-call consumers', async () => {
  await fixture(async (f) => {
    const original = f.stdioCall
    if (!original || !f.stdioCallEvidence) throw new Error('Original STDIO call witness missing')
    const imported = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), phase: z.literal('current-schema-initialized'),
      tableCounts: z.record(z.string(), z.string()), systemMigrationComplete: z.literal(false) }).loose()
      .parse(await migrateFixtureCurrent(f, 'stdio-no-start-call'))
    expect(imported.tableCounts.pe_stdio_mcp_calls).toBe('1')
    expect(imported.tableCounts.pe_operations).toBe('5')
    expect(original.creationRequests).toBe(0)
    expect(original.namespaceDeleted).toBe(true)
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password), tasks = new TaskStore(f.target, { ...taskLimits, stdioMcpEnabled: true })
    const service = new StdioMcpService(tasks, null, randomUUID(), 60000)
    try {
      const before = (await f.target.query('SELECT * FROM pe_stdio_mcp_calls ORDER BY id')).rows
      const operations = (await f.target.query('SELECT * FROM pe_operations ORDER BY id')).rows
      expect(await service.status(bob.user, original.callId)).toEqual(original.terminal)
      expect(await service.calls(bob.user)).toEqual({ items: [original.terminal] })
      expect(await service.calls(alice.user)).toEqual({ items: [] })
      await expect(service.status(alice.user, original.callId)).rejects.toMatchObject({ code: 'stdio_mcp_call_not_found' })
      expect(await tasks.accept(bob.user, sessionId.parse(f.bob.session), requestId.parse(original.originalRequest),
        original.input, bob.token)).toMatchObject({ operationId: original.operationId, accepted: true, state: 'failed' })
      const continuation = f.capture.tables.pe_operations?.find(row => row.id === original.continuationOperationId)
      expect(continuation?.input).toBe(`可信隔离进程 MCP 调用 ${original.callId} 的状态为 failed。`
        + '错误代码：stdio_mcp_runner_unavailable。结果不明时不要重复调用。')
      expect((await f.target.query('SELECT * FROM pe_stdio_mcp_calls ORDER BY id')).rows).toEqual(before)
      expect((await f.target.query('SELECT * FROM pe_operations ORDER BY id')).rows).toEqual(operations)
    } finally { await service.close(); await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, true, false, false, false, false, true)
})

test('STDIO refused-call migration rejects started markers missing absence and changed signed physical witnesses', async () => {
  await fixture(async (f) => {
    if (!f.stdioCallEvidence || !f.stdioEvidence) throw new Error('Original STDIO call witness missing')
    const context = createLegacyMigrationStdioCallContext(f.stdioCallEvidence, f.capture.source.codeId, budgets)
    const stdio = createLegacyMigrationStdioContext(f.stdioEvidence, f.capture.source.codeId, budgets)
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), migrationId = randomUUID(), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets,
      [], undefined, undefined, stdio, undefined, undefined, context)
    const call = plan.rows.find(row => row.table === 'pe_stdio_mcp_calls')
    if (!call) throw new Error('Original STDIO call row missing')
    expect(validateLegacyMigrationStdioCall(call, plan.rows, budgets, f.capture.source.cut, context)).toBe(true)
    expect(() => validateLegacyMigrationStdioCall(call, plan.rows, budgets, f.capture.source.cut))
      .toThrow('migration_stdio_call_original_evidence_missing')
    expect(() => validateLegacyMigrationStdioCall(call, plan.rows, budgets, f.capture.source.cut, { ...context }))
      .toThrow('migration_stdio_call_original_evidence_missing')
    expect(() => validateLegacyMigrationStdioCall({ ...call, values: { ...call.values, pod_uid: randomUUID() } },
      plan.rows, budgets, f.capture.source.cut, context)).toThrow('migration_stdio_call_original_no_start_missing')
    const proof = f.stdioCallEvidence.requests[0]!
    const missing = createLegacyMigrationStdioCallContext({ ...f.stdioCallEvidence, requests: [{ ...proof,
      observations: proof.observations.map(item => item.kind === 'services' ? { ...item, kind: 'pods' } : item) }] },
    f.capture.source.codeId, budgets)
    expect(() => validateLegacyMigrationStdioCall(call, plan.rows, budgets, f.capture.source.cut, missing))
      .toThrow('migration_stdio_call_original_absence_missing')
    const changedSnapshot = plan.rows.map(row => row.table === 'pe_operations' && row.values.source_stdio_mcp_call_id === call.values.id
      ? { ...row, values: { ...row.values, settings: '{"model":"trial-model","maxTokens":1,"revision":7}' } } : row)
    expect(() => validateLegacyMigrationStdioCall(call, changedSnapshot, budgets, f.capture.source.cut, context))
      .toThrow('migration_stdio_call_original_snapshot')
    await writeFile(join(f.root, 'stdio-call-original-evidence.json'), JSON.stringify({ ...f.stdioCallEvidence,
      requests: [{ ...proof, namespaceUid: randomUUID() }] }) + '\n', { mode: 0o600 })
    await migrateFixtureCurrent(f, 'stdio-call-changed-signed-evidence', 1)
    expect(JSON.parse(await readFile(join(f.root, 'stdio-call-changed-signed-evidence-failure.json'), 'utf8')))
      .toMatchObject({ code: 'migration_cut_mismatch' })
    expect((await f.target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ n: '0' }])
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, true, false, false, false, false, true)
})

test('schema4 original Cloud pre-worker cancellation imports admitted commands and ordinary terminal consumers', async () => {
  await fixture(async (f) => {
    const original = f.cloudCancellation
    if (!original || !f.cloudCancellationEvidence) throw new Error('Original Cloud cancellation witness missing')
    const imported = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), phase: z.literal('current-schema-initialized'),
      tableCounts: z.record(z.string(), z.string()), systemMigrationComplete: z.literal(false) }).loose()
      .parse(await migrateFixtureCurrent(f, 'cloud-cancel-no-executor'))
    expect(imported.tableCounts.pe_cloud_executions).toBe('1')
    expect(imported.tableCounts.pe_operations).toBe('2')
    for (const table of ['pe_sandbox_instances', 'pe_mount_slots', 'pe_cloud_execution_resolutions']) {
      expect(imported.tableCounts[table]).toBe('0')
    }
    expect(original.transportRequests).toBe(0)
    expect(original.executorReservationCreated).toBe(false)
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password), tasks = new TaskStore(f.target, { ...taskLimits, executionEnabled: true })
    const files = new FileService(f.target, join(f.root, 'target-cloud-unused-workspaces'))
    await files.init()
    const kube = await KubernetesClient.fromFile('/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/k3s-migration-kubeconfig.yaml')
    const sandboxes = new SandboxManager(kube, files, f.target, 'A'.repeat(43), {
      namespace: `pe-e5-cloud-unused-${randomUUID().replaceAll('-', '')}`,
      image: `registry.example/owned-unused-sandbox@sha256:${'a'.repeat(64)}`,
      localRoot: join(f.root, 'target-cloud-unused-home'), nodeRoot: join(f.root, 'target-cloud-unused-node'),
      readyTimeoutMs: 1000, maxExecutions: 8,
    })
    const service = new ExecutionService(tasks, sandboxes, 1, 100, 60000, original.commandTimeoutMs)
    try {
      const before = (await f.target.query('SELECT * FROM pe_cloud_executions ORDER BY id')).rows
      const operations = (await f.target.query('SELECT * FROM pe_operations ORDER BY id')).rows
      expect(await service.list(bob.user)).toEqual(original.listed)
      expect(await service.cancel(bob.user, original.executionId)).toEqual(original.terminal)
      expect(await service.list(alice.user)).toEqual({ items: [] })
      await expect(service.cancel(alice.user, original.executionId)).rejects.toMatchObject({ code: 'execution_not_found' })
      expect(await tasks.accept(bob.user, sessionId.parse(f.bob.session), requestId.parse(original.originalRequest),
        original.input, bob.token)).toMatchObject({ operationId: original.operationId, accepted: true, state: 'failed' })
      expect((await f.target.query('SELECT * FROM pe_cloud_executions ORDER BY id')).rows).toEqual(before)
      expect((await f.target.query('SELECT * FROM pe_operations ORDER BY id')).rows).toEqual(operations)
    } finally { await service.close(); await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('Cloud cancellation migration rejects executor markers changed admission snapshots and signed policy drift', async () => {
  await fixture(async (f) => {
    if (!f.cloudCancellationEvidence) throw new Error('Original Cloud cancellation witness missing')
    const context = createLegacyMigrationCloudCancellationContext(f.cloudCancellationEvidence, f.capture.source.codeId, budgets)
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), migrationId = randomUUID(), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets,
      [], undefined, undefined, undefined, undefined, undefined, undefined, context)
    const execution = plan.rows.find(row => row.table === 'pe_cloud_executions')
    if (!execution) throw new Error('Original Cloud execution row missing')
    expect(validateLegacyMigrationCloudCancellation(execution, plan.rows, budgets, f.capture.source.cut, context)).toBe(true)
    expect(() => validateLegacyMigrationCloudCancellation(execution, plan.rows, budgets, f.capture.source.cut))
      .toThrow('migration_cloud_cancel_original_evidence_missing')
    expect(() => validateLegacyMigrationCloudCancellation(execution, plan.rows, budgets, f.capture.source.cut, { ...context }))
      .toThrow('migration_cloud_cancel_original_evidence_missing')
    expect(() => validateLegacyMigrationCloudCancellation({ ...execution, values: { ...execution.values, pod_uid: randomUUID() } },
      plan.rows, budgets, f.capture.source.cut, context)).toThrow('migration_cloud_cancel_original_executor_missing')
    const policy = { ...f.cloudCancellationEvidence, commandTimeoutMs: f.cloudCancellationEvidence.commandTimeoutMs + 1 }
    const changed = createLegacyMigrationCloudCancellationContext(policy, f.capture.source.codeId, budgets)
    expect(() => validateLegacyMigrationCloudCancellation(execution, plan.rows, budgets, f.capture.source.cut, changed))
      .toThrow('migration_cloud_cancel_original_admission')
    const changedSnapshot = plan.rows.map(row => row.table === 'pe_operations' && row.values.source_execution_id === execution.values.id
      ? { ...row, values: { ...row.values, settings: '{"model":"trial-model","maxTokens":1,"revision":7}' } } : row)
    expect(() => validateLegacyMigrationCloudCancellation(execution, changedSnapshot, budgets, f.capture.source.cut, context))
      .toThrow('migration_cloud_cancel_original_snapshot')
    const missingContinuation = plan.rows.filter(row => row.table !== 'pe_operations' || row.values.source_execution_id !== execution.values.id)
    expect(() => validateLegacyMigrationCloudCancellation(execution, missingContinuation, budgets, f.capture.source.cut, context))
      .toThrow('migration_cloud_cancel_original_continuation')
    await writeFile(join(f.root, 'cloud-cancel-original-evidence.json'), JSON.stringify(policy) + '\n', { mode: 0o600 })
    await migrateFixtureCurrent(f, 'cloud-cancel-changed-signed-evidence', 1)
    expect(JSON.parse(await readFile(join(f.root, 'cloud-cancel-changed-signed-evidence-failure.json'), 'utf8')))
      .toMatchObject({ code: 'migration_cut_mismatch' })
    expect((await f.target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ n: '0' }])
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, true)
})

test('schema4 original STDIO v2 unallocated discovery imports formal no-start and ordinary action consumers', async () => {
  await fixture(async (f) => {
    const original = f.stdioV2Cancellation
    if (!original || !f.stdioNoStartEvidence) throw new Error('Original STDIO v2 no-start witness missing')
    const imported = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), phase: z.literal('current-schema-initialized'),
      tableCounts: z.record(z.string(), z.string()), systemMigrationComplete: z.literal(false) }).loose()
      .parse(await migrateFixtureCurrent(f, 'stdio-v2-unallocated-discovery'))
    for (const table of ['pe_stdio_v2_actions', 'pe_stdio_v2_no_start_closures']) {
      expect(imported.tableCounts[table]).toBe('1')
    }
    expect(imported.tableCounts.pe_cloud_executions).toBe('2')
    expect(imported.tableCounts.pe_stdio_v2_management_requests).toBe('6')
    expect(imported.tableCounts.pe_operations).toBe('2')
    expect(original.transportRequests).toBe(0)
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const actions = new StdioActionServiceV2(f.target, { limits: stdioV2Limits, maxReplyBytes: 262144, maxPageSize: 8 })
    const connections = new StdioConnectionServiceV2(f.target, stdioV2Limits, stdioV2Management)
    const files = new FileService(f.target, join(f.root, 'candidate', 'workspaces'))
    await files.init()
    const discovery = new StdioAdmissionServiceV2(f.target, files, { limits: stdioV2Limits, management: stdioV2Management,
      maxPendingPerUser: 8, deployments: { cloud: f.stdioNoStartEvidence.deploymentPin } })
    try {
      const tables = ['pe_stdio_v2_actions', 'pe_stdio_v2_no_start_closures', 'pe_cloud_executions', 'pe_stdio_v2_management_requests']
      const before = await Promise.all(tables.map(table => f.target.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1`)
        .then(result => result.rows)))
      const request = { actionId: original.accepted.actionId }
      expect(await actions.detail(bob.token, request)).toEqual(original.detail)
      expect(await actions.list(bob.token, { offset: 0, limit: 8 })).toEqual(original.listed)
      expect(await actions.cancel(bob.token, request)).toEqual(original.terminal)
      expect(await connections.receipt(bob.token, { requestId: original.accepted.requestId })).toEqual(original.accepted)
      expect(await discovery.check(bob.token, stdioCheckRequestV2.parse(original.request))).toEqual(original.accepted)
      await expect(actions.detail(alice.token, request)).rejects.toMatchObject({ code: 'stdio_v2_action_not_found' })
      await expect(actions.cancel(alice.token, request)).rejects.toMatchObject({ code: 'stdio_v2_action_not_found' })
      expect(await Promise.all(tables.map(table => f.target.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY 1`)
        .then(result => result.rows))))
        .toEqual(before)
    } finally { await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false, true, false, false, false, false, true, true)
})

test('STDIO v2 no-start migration rejects preparation authority changed tasks missing closure and signed pin drift', async () => {
  await fixture(async (f) => {
    if (!f.stdioNoStartEvidence || !f.stdioV2) throw new Error('Original STDIO v2 no-start witness missing')
    const context = createLegacyMigrationStdioNoStartContext(f.stdioNoStartEvidence, f.capture.source.codeId, budgets)
    const stdio = createLegacyMigrationStdioV2Context({ format: 'power-evolve-legacy-stdio-v2-policy', version: 1,
      sourceCodeId: f.capture.source.codeId, limits: stdioV2Limits, management: stdioV2Management }, f.capture.source.codeId)
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), migrationId = randomUUID(), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets,
      [], undefined, undefined, undefined, stdio, undefined, undefined, undefined, context)
    const action = plan.rows.find(row => row.table === 'pe_stdio_v2_actions')
    const closure = plan.rows.find(row => row.table === 'pe_stdio_v2_no_start_closures')
    const execution = plan.rows.find(row => row.table === 'pe_cloud_executions')
    if (!action || !closure || !execution) throw new Error('Original no-start source rows missing')
    expect(validateLegacyMigrationStdioNoStart(action, plan.rows, budgets, f.capture.source.cut, context)).toBe(true)
    expect(() => validateLegacyMigrationStdioNoStart(action, plan.rows, budgets, f.capture.source.cut))
      .toThrow('migration_stdio_no_start_original_evidence_missing')
    expect(() => validateLegacyMigrationStdioNoStart(action, plan.rows, budgets, f.capture.source.cut, { ...context }))
      .toThrow('migration_stdio_no_start_original_evidence_missing')
    expect(() => validateLegacyMigrationStdioNoStart({ ...execution, values: { ...execution.values, pod_uid: randomUUID() } },
      plan.rows, budgets, f.capture.source.cut, context)).toThrow('migration_stdio_no_start_original_unallocated')
    const changedTask = { ...action, values: { ...action.values, task: action.values.task?.replace('"phase":"discover"', '"phase":"call"') ?? '' } }
    expect(() => validateLegacyMigrationStdioNoStart(changedTask, plan.rows, budgets, f.capture.source.cut, context)).toThrow()
    const changedClosure = { ...closure, values: { ...closure.values, prepared_digest: 'a'.repeat(64) } }
    expect(() => validateLegacyMigrationStdioNoStart(changedClosure, plan.rows, budgets, f.capture.source.cut, context))
      .toThrow('migration_stdio_no_start_original_closure')
    expect(() => validateLegacyMigrationStdioNoStart(action, plan.rows.filter(row => row.table !== 'pe_stdio_v2_no_start_closures'),
      budgets, f.capture.source.cut, context)).toThrow('migration_stdio_no_start_original_inventory')
    const missing = createLegacyMigrationStdioNoStartContext({ ...f.stdioNoStartEvidence, requests: [] }, f.capture.source.codeId, budgets)
    expect(() => validateLegacyMigrationStdioNoStart(action, plan.rows, budgets, f.capture.source.cut, missing))
      .toThrow('migration_stdio_no_start_original_inventory')
    await writeFile(join(f.root, 'stdio-v2-no-start-original-evidence.json'), JSON.stringify({ ...f.stdioNoStartEvidence,
      deploymentPin: { ...f.stdioNoStartEvidence.deploymentPin, deploymentId: randomUUID() } }) + '\n', { mode: 0o600 })
    await migrateFixtureCurrent(f, 'stdio-v2-no-start-changed-signed-evidence', 1)
    expect(JSON.parse(await readFile(join(f.root, 'stdio-v2-no-start-changed-signed-evidence-failure.json'), 'utf8')))
      .toMatchObject({ code: 'migration_cut_mismatch' })
    expect((await f.target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ n: '0' }])
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, false, true, false, false, false, false, false, true)
})

test('schema4 pristine mount slot imports original default state and ordinary FileService consumers', async () => {
  await fixture(async (f) => {
    const original = f.pristineMount
    if (!original) throw new Error('Original pristine mount fixture missing')
    const imported = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), phase: z.literal('current-schema-initialized'),
      tableCounts: z.record(z.string(), z.string()), systemMigrationComplete: z.literal(false) }).loose()
      .parse(await migrateFixtureCurrent(f, 'pristine-mount-files'))
    expect(imported.tableCounts.pe_mount_slots).toBe('1')
    expect(imported.tableCounts.pe_file_uploads).toBe('1')
    expect(imported.tableCounts.pe_sandbox_instances).toBe('0')
    expect(imported.tableCounts.pe_cloud_executions).toBe('0')
    expect(original.sandboxManagerIssuedRow).toBe(false)
    expect(original.originalFileServiceConsumed).toBe(true)
    const identities = new IdentityService(f.target, 60000), alice = await identities.login('migration-alice', password)
    const bob = await identities.login('migration-bob', password)
    const files = new FileService(f.target, join(f.root, 'candidate', 'workspaces')); await files.init()
    try {
      const slotsBefore = (await f.target.query('SELECT * FROM pe_mount_slots ORDER BY user_id')).rows
      const priorBefore = (await f.target.query('SELECT * FROM pe_file_uploads WHERE request_id=$1', [original.requestId])).rows
      expect(await files.read(bob.user, original.path, f.bob.workspace)).toEqual(original.read)
      expect(await files.put(bob.user, original.requestId, original.path, original.read.data, f.bob.workspace)).toEqual(original.put)
      const fresh = randomUUID()
      expect(await files.put(bob.user, fresh, original.path, original.read.data, f.bob.workspace)).toEqual(original.put)
      expect((await f.target.query('SELECT count(*)::text AS n FROM pe_file_uploads WHERE request_id=$1', [fresh])).rows)
        .toEqual([{ n: '1' }])
      await expect(files.put(alice.user, randomUUID(), original.path, original.read.data, f.bob.workspace))
        .rejects.toMatchObject({ code: 'workspace_not_found' })
      expect(await files.read(bob.user, original.path, f.bob.workspace)).toEqual(original.read)
      expect((await f.target.query('SELECT * FROM pe_mount_slots ORDER BY user_id')).rows).toEqual(slotsBefore)
      expect((await f.target.query('SELECT * FROM pe_file_uploads WHERE request_id=$1', [original.requestId])).rows).toEqual(priorBefore)
      expect((await f.source.query('SELECT count(*)::text AS n FROM pe_file_mutations')).rows).toEqual([{ n: '1' }])
    } finally { await identities.logout(alice.token); await identities.logout(bob.token) }
  }, false, false, false, false, false, false, false, false, false, false, false, false,
  false, false, false, false, false, false, false, true)
})

test('pristine mount migration rejects prior generations owner drift occupancy and changed source cut', async () => {
  await fixture(async (f) => {
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), migrationId = randomUUID(), cut = cutFor(f)
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets)
    const slot = plan.rows.find(row => row.table === 'pe_mount_slots')
    if (!slot) throw new Error('Original pristine mount row missing')
    expect(validateLegacyMigrationPristineMount(slot, plan.rows, f.capture.source.cut)).toBe(true)
    for (const values of [{ generation: '1' }, { session_id: f.bob.session }, { pod_uid: randomUUID() },
      { stop_evidence: '{}' }, { binding_snapshot: '{}' }, { updated_at: '2100-01-01T00:00:00Z' }]) {
      expect(() => validateLegacyMigrationPristineMount({ ...slot, values: { ...slot.values, ...values } }, plan.rows,
        f.capture.source.cut)).toThrow('migration_mount_slot_pristine_required')
    }
    expect(() => validateLegacyMigrationPristineMount({ ...slot, values: { ...slot.values, user_id: randomUUID() } },
      plan.rows, f.capture.source.cut)).toThrow('migration_mount_slot_owner_missing')
    expect(() => validateLegacyMigrationPristineMount(slot, [...plan.rows, { ...slot, table: 'pe_sandbox_instances' }],
      f.capture.source.cut)).toThrow('migration_mount_slot_original_occupancy')
    await f.source.query('UPDATE pe_mount_slots SET generation=1 WHERE user_id=$1', [f.bob.user])
    await migrateFixtureCurrent(f, 'pristine-mount-changed-source-cut', 1)
    expect(JSON.parse(await readFile(join(f.root, 'pristine-mount-changed-source-cut-failure.json'), 'utf8')))
      .toMatchObject({ code: 'migration_cut_mismatch' })
    expect((await f.target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows).toEqual([{ n: '0' }])
    await expect(lstat(join(f.root, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, false, false, false, false, false, false, false, false, false, false, false, false,
  false, false, false, false, false, false, false, true)
})

test('current actual original unscheduled creation stop imports paired physical closure and ordinary consumers', async () => {
  await fixture(async (f) => {
    const original = f.stoppedCreation, evidence = f.stoppedCreationEvidence
    if (!original || !evidence) throw new Error('Original actual creation stop missing')
    const context = createLegacyMigrationStoppedCreationContext(evidence, f.capture.source.codeId, budgets)
    const histories = migrateLegacyHistories(f.capture, f.histories, budgets), cut = cutFor(f), migrationId = randomUUID()
    const receipts = planLegacyHistoryFiles(migrationId, histories, f.attachmentSources)
    const plan = prepareLegacyMigration(migrationId, f.capture, histories, receipts, f.files, cut.filesSha256, cut, budgets,
      [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, context)
    const instance = plan.rows.find(row => row.table === 'pe_sandbox_instances')
    const slot = plan.rows.find(row => row.table === 'pe_mount_slots')
    if (!instance || !slot) throw new Error('Original stopped Sandbox/mount rows missing')
    expect(validateLegacyMigrationStoppedCreation(instance, plan.rows, budgets, cut.cut, context)).toBe(true)
    expect(() => validateLegacyMigrationStoppedCreation(instance, plan.rows, budgets, cut.cut))
      .toThrow('migration_creation_stop_evidence_missing')
    for (const values of [{ state: 'ready' }, { pod_uid: randomUUID() }, { stop_pod_uid: randomUUID() },
      { user_id: f.alice.user }, { updated_at: '2100-01-01T00:00:00Z' }]) {
      expect(() => validateLegacyMigrationStoppedCreation({ ...instance, values: { ...instance.values, ...values } },
        plan.rows.map(row => row === instance ? { ...row, values: { ...row.values, ...values } } : row), budgets, cut.cut, context))
        .toThrow()
    }
    const changedSlot = { ...slot, values: { ...slot.values, generation: '0' } }
    expect(() => validateLegacyMigrationStoppedCreation(changedSlot,
      plan.rows.map(row => row === slot ? changedSlot : row), budgets, cut.cut, context)).toThrow()
    const proof = evidence.requests[0]
    if (!proof) throw new Error('Original stop API witness absent')
    const pod = z.object({ spec: z.record(z.string(), z.json()) }).loose().parse(proof.podDeleting)
    const scheduled = createLegacyMigrationStoppedCreationContext({ ...evidence,
      requests: [{ ...proof, podDeleting: { ...proof.podDeleting, spec: { ...pod.spec, nodeName: 'changed-node' } } }] },
    f.capture.source.codeId, budgets)
    expect(() => validateLegacyMigrationStoppedCreation(instance, plan.rows, budgets, cut.cut, scheduled))
      .toThrow('migration_creation_stop_identity')
    const imported = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), tableCounts: z.record(z.string(), z.string()),
      systemMigrationComplete: z.literal(false) }).loose().parse(await migrateFixtureCurrent(f, 'actual-creation-stop'))
    for (const table of ['pe_sandbox_instances', 'pe_mount_slots', 'pe_cloud_executions', 'pe_file_uploads']) {
      expect(imported.tableCounts[table]).toBe('1')
    }
    const identities = new IdentityService(f.target, 60000), bob = await identities.login('migration-bob', password)
    const alice = await identities.login('migration-alice', password)
    const files = new FileService(f.target, join(f.root, 'candidate', 'workspaces')); await files.init()
    const kube = await KubernetesClient.fromFile(original.hostKubeconfig)
    const manager = new SandboxManager(kube, files, f.target, 'C'.repeat(43), { namespace: original.namespace,
      image: 'pe-dsh-migration-runner:20261009-v3', localRoot: join(f.root, 'candidate'), nodeRoot: '/owned/unused-target',
      readyTimeoutMs: 1000, maxExecutions: 8 })
    const tasks = new TaskStore(f.target, { ...taskLimits, executionEnabled: true })
    const executions = new ExecutionService(tasks, manager, 1, 100, 60000, original.commandTimeoutMs)
    try {
      const sandboxBefore = (await f.target.query('SELECT * FROM pe_sandbox_instances')).rows
      const slotBefore = (await f.target.query('SELECT * FROM pe_mount_slots')).rows
      const executionsBefore = (await f.target.query('SELECT * FROM pe_cloud_executions')).rows
      expect(await executions.list(bob.user)).toEqual(original.listed)
      expect(await executions.cancel(bob.user, original.executionId)).toEqual(original.terminal)
      expect(await executions.list(alice.user)).toEqual({ items: [] })
      await expect(executions.cancel(alice.user, original.executionId)).rejects.toMatchObject({ code: 'execution_not_found' })
      expect(await files.read(bob.user, original.upload.path)).toEqual(original.upload.read)
      expect(await files.put(bob.user, requestId.parse(original.upload.requestId), original.upload.path,
        original.upload.bytesBase64)).toEqual(original.upload.receipt)
      const fresh = Buffer.from('Fresh current file after actual stopped generation\n').toString('base64')
      await files.put(bob.user, requestId.parse(randomUUID()), 'fresh-after-stop.txt', fresh)
      await expect(files.read(alice.user, original.upload.path)).rejects.toMatchObject({ code: 'file_not_found' })
      expect((await f.target.query('SELECT * FROM pe_sandbox_instances')).rows).toEqual(sandboxBefore)
      expect((await f.target.query('SELECT * FROM pe_mount_slots')).rows).toEqual(slotBefore)
      expect((await f.target.query('SELECT * FROM pe_cloud_executions')).rows).toEqual(executionsBefore)
      expect((await f.target.query('SELECT count(*)::text AS n FROM pe_file_uploads')).rows).toEqual([{ n: '2' }])
      expect((await f.source.query('SELECT count(*)::text AS n FROM pe_file_mutations')).rows).toEqual([{ n: '1' }])
      expect(original).toMatchObject({ ownedFixture: true, productionSource: false, commandDispatched: false, runnerStarted: false })
    } finally { await executions.close(); await identities.logout(bob.token); await identities.logout(alice.token) }
  }, false, false, false, false, false, false, false, false, false, false,
  false, false, false, false, false, false, false, false, false, false, true)
}, 120000)

test('STDIO approval metadata preserves original SDK HMAC and transaction timestamp precision without import admission', async () => {
  const original = await originalStdioApprovalMetadata(), before = JSON.stringify(original.preparation)
  const approval = readLegacyMigrationStdioPreparationApproval(original.preparation, original.key, stdioV2Limits, budgets, original.cut)
  expect(approval.binding).toEqual(original.original.binding)
  expect(approval.fingerprint).toBe(original.original.fingerprint)
  expect(approval.createdAt).toBe('2025-01-02T03:04:05.123456Z')
  expect(approval.expiresAt).toBe('2025-01-02T03:04:05.123000Z')
  for (const decision of original.decisions) {
    const before = JSON.stringify(decision)
    expect(readLegacyMigrationStdioDecisionMetadata(decision, approval, original.cut)).toEqual({
      actionId: decision.values.action_id, userId: decision.values.user_id, fingerprint: decision.values.fingerprint,
      decision: decision.values.decision, decidedAt: decision.values.decided_at,
    })
    expect(JSON.stringify(decision)).toBe(before)
  }
  expect(JSON.stringify(original.preparation)).toBe(before)
  expect(original.original).toMatchObject({ metadataOnly: true, productionApproval: false,
    databaseRowsCreated: 0, executorIdentitiesCreated: 0 })
})

test('STDIO approval metadata rejects replaced keys altered bindings owner drift and microsecond cut changes', async () => {
  const original = await originalStdioApprovalMetadata(), changedKey = Buffer.from(original.key)
  changedKey[0] = 0
  expect(() => readLegacyMigrationStdioPreparationApproval(original.preparation, changedKey, stdioV2Limits, budgets, original.cut))
    .toThrow('migration_stdio_approval_binding_changed')
  for (const values of [{ task_digest: legacyDigest('changed task') }, { prepared_digest: legacyDigest('changed prepared') },
    { expires_at: '2025-01-02T03:04:05.123001Z' }]) {
    expect(() => readLegacyMigrationStdioPreparationApproval({ ...original.preparation,
      values: { ...original.preparation.values, ...values } }, original.key, stdioV2Limits, budgets, original.cut))
      .toThrow('migration_stdio_approval_binding_changed')
  }
  expect(() => readLegacyMigrationStdioPreparationApproval({ ...original.preparation,
    values: { ...original.preparation.values, created_at: '2025-01-02T03:04:05.124001Z' } },
  original.key, stdioV2Limits, budgets, original.cut)).toThrow('migration_stdio_approval_after_cut')
  expect(() => readLegacyMigrationStdioPreparationApproval({ ...original.preparation, values: { ...original.preparation.values,
    approval_binding: JSON.stringify({ ...original.original.binding, grantOnce: true }) } },
  original.key, stdioV2Limits, budgets, original.cut)).toThrow()
  const approval = readLegacyMigrationStdioPreparationApproval(original.preparation, original.key, stdioV2Limits, budgets, original.cut)
  const decision = original.decisions[0]
  if (!decision) throw new Error('Original protocol decision example missing')
  for (const values of [{ action_id: randomUUID() }, { user_id: randomUUID() }, { fingerprint: legacyDigest('changed fingerprint') }]) {
    expect(() => readLegacyMigrationStdioDecisionMetadata({ ...decision, values: { ...decision.values, ...values } }, approval,
      original.cut))
      .toThrow('migration_stdio_decision_binding_changed')
  }
  expect(() => readLegacyMigrationStdioDecisionMetadata({ ...decision,
    values: { ...decision.values, decided_at: '2025-01-02T03:04:05.124001Z' } }, approval, original.cut))
    .toThrow('migration_stdio_decision_after_cut')
  expect(() => readLegacyMigrationStdioDecisionMetadata({ ...decision, values: { ...decision.values, decision: 'approve' } }, approval,
    original.cut)).toThrow()
})

for (const [environment, label] of [['PE_EMPLOYEE5_ORIGINAL_STDIO_COHORT', 'discovery'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_CALL_COHORT', 'call'], ['PE_EMPLOYEE5_ORIGINAL_STDIO_REJECT_COHORT', 'rejected call'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_TOOL_ERROR_COHORT', 'tool error'], ['PE_EMPLOYEE5_ORIGINAL_STDIO_FAILED_COHORT', 'failed call'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_TAKEOVER_COHORT', 'worker takeover'], ['PE_EMPLOYEE5_ORIGINAL_STDIO_HISTORY_COHORT', 'catalog history'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_CANCEL_COHORT', 'prepared cancellation'], ['PE_EMPLOYEE5_ORIGINAL_STDIO_MIXED_COHORT', 'mixed inventory'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_MIXED_UNALLOCATED_COHORT', 'mixed inventory with unallocated closure'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_PREPARED_DISCOVERY_COHORT', 'prepared discovery closures'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_FAILED_DISCOVERY_COHORT', 'failed discovery'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_ACK_LOSS_COHORT', 'dispatch acknowledgement loss'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_STARTED_CANCEL_COHORT', 'started cancellation'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_CLOUD_MIXED_COHORT', 'mixed inventory with legacy Cloud cancellation'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_FIXED_MCP_COHORT', 'combined fixed MCP'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_TEXT_SKILL_COHORT', 'combined text Skill'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_DOMAIN_MIXED_COHORT', 'mixed inventory with legacy Cloud text Skill and fixed MCP'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_FIXED_STDIO_MIXED_COHORT', 'mixed inventory with legacy Cloud text Skill fixed MCP and fixed STDIO'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_ALL_CLOSURES_MIXED_COHORT',
    'mixed inventory with legacy Cloud text Skill fixed MCP fixed STDIO and all STDIO closures'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_SSH_MIXED_COHORT',
    'mixed inventory with legacy Cloud text Skill fixed MCP fixed STDIO and all STDIO closures with SSH metadata'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_MULTI_TURN_COHORT', 'three-turn chain'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_WRITER_HISTORY_COHORT', 'writer history'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_PACKAGE_SKILL_COHORT', 'package Skill selection'],
  ['PE_EMPLOYEE5_ORIGINAL_STDIO_REMOTE_MCP_COHORT', 'remote MCP selection']] as const) {
  test(`current actual original successful STDIO ${label} imports full cohort and ordinary consumers`, async () => {
    const originalRoot = process.env[environment]
    if (!originalRoot) throw new Error('Original owned STDIO cohort required')
    const evidence = legacyMigrationStdioDiscoveryEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'discovery-evidence.json'), 'utf8')))
    const cut = z.object({ version: z.literal(2), snapshotId: z.uuid(), codeId: z.string(), stoppedAt: z.string(), cut: z.string(),
      catalogSha256: z.string(), tablesSha256: z.string(), filesSha256: z.string(), kind: z.literal('owned-fixture') }).strict()
      .parse(JSON.parse(await readFile(join(originalRoot, 'cut-payload.json'), 'utf8')))
    const originalKey = Buffer.from((await readFile(join(originalRoot, 'original-approval-key'), 'utf8')).trim(), 'hex')
    const context = createLegacyMigrationStdioDiscoveryContext(evidence, originalKey, cut.codeId, budgets)
    const remoteKey = label === 'remote MCP selection'
      ? legacyMigrationMcpKey.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-key.json'), 'utf8'))) : undefined
    const remoteEvidence = remoteKey === undefined ? undefined
      : legacyMigrationMcpEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-evidence.json'), 'utf8')))
    const remoteContext = remoteKey === undefined ? undefined
      : createLegacyMigrationMcpContext(remoteKey, remoteEvidence, cut.codeId, budgets)
    const cloudContext = label.startsWith('mixed inventory with legacy Cloud')
      ? createLegacyMigrationCloudCancellationContext(JSON.parse(await readFile(join(originalRoot, 'cloud-cancel-original-evidence.json'), 'utf8')),
        cut.codeId, budgets) : undefined
    const stdioContext = label.includes('fixed STDIO')
      ? createLegacyMigrationStdioContext(JSON.parse(await readFile(join(originalRoot, 'fixed-stdio-original-evidence.json'), 'utf8')),
        cut.codeId, budgets) : undefined
    const originalSshKey = label.includes('SSH metadata')
      ? legacyMigrationSshKey.parse(JSON.parse(await readFile(join(originalRoot, 'ssh-original-key-declaration.json'), 'utf8')))
      : undefined
    const sshContext = originalSshKey === undefined ? undefined : createLegacyMigrationSshContext(originalSshKey, cut.codeId)
    const originalNoStartRefusals = label.includes('all STDIO closures')
      ? z.object({ ownedFixture: z.literal(true), productionSource: z.literal(false), sourceRowsUnchanged: z.literal(true),
        refusals: z.array(z.object({ actionId: z.uuid(), code: z.enum(['stdio_v2_configuration_stale',
          'stdio_v2_action_not_startable']) }).strict()) }).strict()
        .parse(JSON.parse(await readFile(join(originalRoot, 'ordinary-no-start-refusals.json'), 'utf8'))).refusals
      : undefined
    const files = z.array(z.object({ area: z.enum(['workspace', 'home', 'skill-text', 'skill-package', 'office']), owner: z.uuid(),
      resource: z.string(), path: z.string(), kind: z.enum(['directory', 'file']), sourcePath: z.string().nullable(),
      bytes: z.string().nullable(), sha256: z.string().nullable(), mode: z.number(), uid: z.number(), gid: z.number() }).strict())
      .parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
    const sourceUrl = new URL((await readFile(join(originalRoot, 'readonly-url-private'), 'utf8')).trim())
    const source = new Pool({ connectionString: sourceUrl.href, max: 1 }), admin = new Pool({ connectionString: adminUrl.href, max: 1 })
    const suffix = randomUUID().replaceAll('-', ''), database = `pe_employee5_v2_target_${suffix}`, role = `pe_employee5_v2_owner_${suffix}`
    const targetUrl = new URL(adminUrl); targetUrl.pathname = `/${database}`; targetUrl.username = role; targetUrl.password = randomUUID()
    const root = await mkdtemp(join(originalRoot, 'schema5-consumer-')), target = new Pool({ connectionString: targetUrl.href, max: 2 })
    let createdRole = false, createdDatabase = false
    try {
      const capture = await captureLegacyMigrationSource(source, { schema: 37, ddlSha256: LEGACY_SQL_DIGESTS.source37,
        snapshotId: cut.snapshotId, codeId: cut.codeId, stoppedAt: cut.stoppedAt, cut: cut.cut }, {
        purpose: 'offline-readonly-export', expectedDatabase: sourceUrl.pathname.slice(1), expectedCatalogSha256: cut.catalogSha256,
        batchRows: 20, statementTimeoutMs: 5000, limits: budgets }, new AbortController().signal)
      const histories = capture.tables.pe_sessions?.map(item => ({ sessionId: z.uuid().parse(item.id), encoding: 'pg-logical' as const })) ?? []
      const migratedHistories = migrateLegacyHistories(capture, histories, budgets)
      const prepare = (selected = context, inventory = capture) => prepareLegacyMigration(randomUUID(), inventory,
        migratedHistories, [], files, cut.filesSha256, cut, budgets, [], remoteContext, sshContext, stdioContext, undefined, undefined,
        undefined, cloudContext, undefined, undefined, selected)
      const plan = prepare()
      expect(plan.rows.filter(item => item.table === 'pe_stdio_v2_observations')).toHaveLength(capture.tables.pe_stdio_v2_observations?.length ?? 0)
      const originalAction = plan.rows.find(item => item.table === 'pe_stdio_v2_actions' && item.values.phase === 'discover'
        && item.values.state === 'succeeded')
      if (!originalAction) throw new Error('Original STDIO action missing')
      for (const [table, field, value] of [
        ['pe_stdio_v2_start_permits', 'permit_id', randomUUID()],
        ['pe_stdio_v2_dispatches', 'dispatch_digest', '0'.repeat(64)],
        ['pe_stdio_v2_results', 'result_digest', '0'.repeat(64)],
        ['pe_stdio_v2_observations', 'observation_digest', '0'.repeat(64)],
        ['pe_stdio_v2_catalogs', 'catalog_digest', '0'.repeat(64)],
        ['pe_cloud_executions', 'runner_instance_id', randomUUID()],
      ]) {
        if (!table || !field || !value) throw new Error('Owned STDIO mutation case missing')
        const changed = plan.rows.map(item => item.table === table ? { ...item, values: { ...item.values, [field]: value } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(originalAction, changed, budgets, cut.cut, context)).toThrow()
      }
      const callAction = plan.rows.find(item => item.table === 'pe_stdio_v2_actions' && item.values.phase === 'call'
        && item.values.config_revision === '1' && item.values.operation_id === item.values.root_operation_id)
        ?? plan.rows.find(item => item.table === 'pe_stdio_v2_actions' && item.values.phase === 'call')
      if (callAction) for (const [table, field, value] of [
        ['pe_mcp_action_chains', 'calls', '2'], ['pe_mcp_action_chains', 'expires_at', cut.cut],
        ['pe_operations', 'stdio_v2_selection', '[]'], ['pe_operations', 'input', '{}'],
        ['pe_stdio_v2_actions', 'continuation_request_id', randomUUID()],
      ]) {
        if (!table || !field || !value) throw new Error('Owned call mutation case missing')
        const changed = plan.rows.map(item => item.table === table ? { ...item, values: { ...item.values, [field]: value } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, changed, budgets, cut.cut, context)).toThrow()
      }
      if (evidence.takeovers?.length) {
        const changed = structuredClone(evidence), takeover = changed.takeovers?.[0]
        if (!takeover) throw new Error('Original takeover witness missing')
        takeover.newWorkerId = takeover.oldLease.workerId
        expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(changed, originalKey, cut.codeId, budgets))).toThrow()
      }
      if (label === 'three-turn chain') {
        if (!callAction) throw new Error('Original chain root call absent')
        const calls = plan.rows.filter(item => item.table === 'pe_stdio_v2_actions' && item.values.phase === 'call')
        expect(calls).toHaveLength(3)
        expect(calls.filter(item => item.values.operation_id !== item.values.root_operation_id)).toHaveLength(2)
        expect(new Set(calls.map(item => item.values.root_operation_id)).size).toBe(1)
        const alteredStop = plan.rows.map(item => item.table === 'pe_mcp_action_chains'
          ? { ...item, values: { ...item.values, stopped_at: null, error_code: null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, alteredStop, budgets, cut.cut, context))
          .toThrow('migration_stdio_call_chain')
        const later = calls.find(item => item.values.operation_id !== item.values.root_operation_id)
        if (!later) throw new Error('Original later call absent')
        const changedCaller = plan.rows.map(item => item.table === 'pe_operations' && item.values.id === later.values.operation_id
          ? { ...item, values: { ...item.values, source_stdio_v2_action_id: later.values.id ?? null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(later, changedCaller, budgets, cut.cut, context))
          .toThrow('migration_stdio_call_chain_ancestry')
        const earlierContinuation = plan.rows.find(item => item.table === 'pe_operations'
          && item.values.source_stdio_v2_action_id === callAction.values.id)
        if (!earlierContinuation) throw new Error('Original first continuation absent')
        const body = z.object({ chainStopped: z.literal(false), errorCode: z.null() }).loose()
          .parse(JSON.parse(earlierContinuation.values.input ?? ''))
        const rewritten = plan.rows.map(item => item === earlierContinuation
          ? { ...item, values: { ...item.values, input: JSON.stringify({ ...body, chainStopped: true }) } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, rewritten, budgets, cut.cut, context))
          .toThrow('migration_stdio_call_continuation')
      }
      if (label === 'writer history') {
        const historical = evidence.requests.find(item => item.historicalWriter)
        const oldAction = plan.rows.find(item => item.table === 'pe_stdio_v2_actions' && item.values.id === historical?.actionId)
        if (!historical?.historicalWriter || !oldAction) throw new Error('Original historical writer absent')
        const podIds = evidence.requests.map(item => z.object({ metadata: z.object({ uid: z.uuid() }).loose() })
          .loose().parse(item.podReady).metadata.uid)
        expect(new Set(podIds).size).toBe(2)
        for (const mutation of ['digest', 'owner', 'generation', 'successor', 'missing'] as const) {
          const changed = structuredClone(evidence), proof = changed.requests.find(item => item.actionId === historical.actionId)
          if (!proof?.historicalWriter) throw new Error('Original historical snapshot missing')
          if (mutation === 'digest') proof.historicalWriter.slot.sha256 = '0'.repeat(64)
          else if (mutation === 'successor') proof.historicalWriter.successorActionId = proof.actionId
          else if (mutation === 'missing') delete proof.historicalWriter
          else {
            if (mutation === 'owner') proof.historicalWriter.slot.values.user_id = randomUUID()
            else proof.historicalWriter.slot.values.generation = plan.rows.find(item => item.table === 'pe_mount_slots')?.values.generation ?? null
            proof.historicalWriter.slot.sha256 = legacyRowDigest('pe_mount_slots', proof.historicalWriter.slot.values)
          }
          expect(() => validateLegacyMigrationStdioDiscovery(oldAction, plan.rows, budgets, cut.cut,
            createLegacyMigrationStdioDiscoveryContext(changed, originalKey, cut.codeId, budgets))).toThrow()
        }
      }
      if (remoteContext && remoteKey && remoteEvidence) {
        expect(plan.rows.filter(item => item.table === 'pe_mcp_checks').map(item => item.values.state).sort())
          .toEqual(['failed', 'succeeded'])
        expect(plan.rows.filter(item => item.table === 'pe_mcp_actions')).toHaveLength(0)
        const check = plan.rows.find(item => item.table === 'pe_mcp_checks' && item.values.state === 'succeeded')
        if (!check) throw new Error('Original successful remote check absent')
        for (const mutation of ['missing', 'epoch', 'result', 'catalog', 'inventory'] as const) {
          const changed = structuredClone(remoteEvidence), proof = changed.checkRuns?.find(item => item.checkId === check.values.id)
          if (!proof || !changed.checkRuns) throw new Error('Original remote check proof absent')
          if (mutation === 'missing') delete changed.checkRuns
          else if (mutation === 'epoch') proof.lease.epoch += 1
          else if (mutation === 'result') proof.completed = { state: 'succeeded' }
          else if (mutation === 'inventory') proof.sourceRowSha256 = '0'.repeat(64)
          else if ('tools' in proof.outcome) proof.outcome.tools = []
          expect(() => validateLegacyMigrationRemoteMcp(check, plan.rows, budgets, cut.cut,
            createLegacyMigrationMcpContext(remoteKey, changed, cut.codeId, budgets))).toThrow()
        }
        if (!callAction) throw new Error('Original remote selected STDIO call absent')
        const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction.values.operation_id)
        if (!parent) throw new Error('Original remote selected parent absent')
        const selected = z.array(z.object({ connectionId: z.uuid(), connectionRevision: z.number(),
          catalogId: z.uuid() }).loose()).parse(JSON.parse(parent.values.remote_mcp_selection ?? ''))
        expect(selected).toHaveLength(1)
        expect(selected[0]?.connectionRevision).toBe(1)
        expect(plan.rows.find(item => item.table === 'pe_mcp_remote_connections')?.values.revision).toBe('2')
        const altered = plan.rows.map(item => item === parent
          ? { ...item, values: { ...item.values, remote_mcp_selection: JSON.stringify([{ ...selected[0], connectionId: randomUUID() }]) } }
          : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, altered, budgets, cut.cut, context)).toThrow()
      }
      if (label === 'package Skill selection') {
        const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction?.values.operation_id)
        if (!parent) throw new Error('Original package call parent absent')
        const selected = z.array(skillSelection).parse(JSON.parse(parent.values.skill_selection ?? '')), first = selected[0]
        if (!first || first.kind !== 'package') throw new Error('Original package frozen selection absent')
        expect(first.revision).toBe(1)
        const current = plan.rows.find(item => item.table === 'pe_user_skills' && item.values.id === first.skillId)
        expect(current?.values.revision).toBe('2')
        expect(current?.values.enabled).toBe('false')
        for (const changed of [{ ...first, skillId: randomUUID() }, { ...first, revision: 3 },
          { ...first, version: '9.9.9' }, { ...first, packageDigest: '0'.repeat(64) }, { ...first, manifestDigest: '0'.repeat(64) }]) {
          expect(() => {
            validateLegacyMigrationSkillOperation({ ...parent,
              values: { ...parent.values, skill_selection: JSON.stringify([changed]) } }, plan.rows, budgets)
          }).toThrow()
        }
      }
      if (label.includes('fixed MCP') || label.includes('text Skill')) {
        if (!callAction) throw new Error('Original combined call missing')
        const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction.values.operation_id)
        const owner = plan.rows.find(item => item.table === 'pe_mcp_connections')
        if (!parent || !owner) throw new Error('Original fixed MCP selection owner missing')
        expect(owner.values.enabled).toBe('false')
        expect(owner.values.revision).toBe('4')
        for (const item of [{ connectionId: randomUUID(), revision: 1 }, { connectionId: owner.values.id, revision: 2 },
          { connectionId: owner.values.id, revision: 5 }]) {
          const changed = { ...parent, values: { ...parent.values, mcp_selection: JSON.stringify([item]) } }
          expect(() => { validateLegacyMigrationFixedMcpOperation(changed, plan.rows, budgets) }).toThrow()
        }
        const missingPolicy = { ...evidence, reservedNames: [] }
        expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(missingPolicy, originalKey, cut.codeId, budgets)))
          .toThrow('migration_stdio_call_reserved_names')
        const foreign = plan.rows.map(item => item === owner ? { ...item, values: { ...item.values, user_id: randomUUID() } } : item)
        expect(() => { validateLegacyMigrationFixedMcpOperation(parent, foreign, budgets) }).toThrow('migration_fixed_mcp_operation_owner_missing')
      }
      if (label.includes('text Skill')) {
        if (!callAction) throw new Error('Original combined text Skill call missing')
        const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction.values.operation_id)
        const owner = plan.rows.find(item => item.table === 'pe_user_skills')
        if (!parent || !owner) throw new Error('Original text Skill owner missing')
        const selected = z.array(skillSelection).parse(JSON.parse(parent.values.skill_selection ?? ''))
        const first = selected[0]
        if (!first) throw new Error('Original text Skill selection missing')
        expect(owner.values.enabled).toBe('false')
        expect(owner.values.revision).toBe('2')
        expect(first.revision).toBe(1)
        for (const item of [{ ...first, skillId: randomUUID() }, { ...first, digest: '0'.repeat(64) },
          { ...first, revision: 3 }, { ...first, name: 'changed original name' }]) {
          const changed = { ...parent, values: { ...parent.values, skill_selection: JSON.stringify([item]) } }
          expect(() => { validateLegacyMigrationSkillOperation(changed, plan.rows, budgets) }).toThrow()
        }
      }
      if (stdioContext) {
        if (!callAction) throw new Error('Original combined fixed STDIO call missing')
        const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction.values.operation_id)
        const owner = plan.rows.find(item => item.table === 'pe_stdio_mcp_connections')
        if (!parent || !owner) throw new Error('Original fixed STDIO owner missing')
        expect(owner.values.enabled).toBe('false')
        expect(owner.values.revision).toBe('4')
        expect(plan.rows.filter(item => item.table === 'pe_stdio_mcp_calls')).toHaveLength(0)
        for (const item of [{ connectionId: randomUUID(), revision: 1 }, { connectionId: owner.values.id, revision: 2 },
          { connectionId: owner.values.id, revision: 5 }]) {
          const changed = { ...parent, values: { ...parent.values, stdio_mcp_selection: JSON.stringify([item]) } }
          expect(() => { validateLegacyMigrationStdioOperation(changed, plan.rows, budgets) }).toThrow()
        }
        const missingPolicy = { ...evidence, reservedNames: evidence.reservedNames?.filter(name => name !== 'mcp__stdio__whoami') }
        expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(missingPolicy, originalKey, cut.codeId, budgets)))
          .toThrow('migration_stdio_call_reserved_names')
      }
      if (sshContext && originalSshKey) {
        if (!callAction) throw new Error('Original combined SSH call missing')
        const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction.values.operation_id)
        const owner = plan.rows.find(item => item.table === 'pe_ssh_connections')
        const credential = plan.rows.find(item => item.table === 'pe_ssh_credential_versions')
        if (!parent || !owner || !credential) throw new Error('Original SSH metadata owner missing')
        expect(owner.values.enabled).toBe('false')
        expect(owner.values.revision).toBe('4')
        expect(plan.rows.filter(item => ['pe_ssh_calls', 'pe_ssh_execute_actions'].includes(item.table))).toHaveLength(0)
        const selected = z.array(sshSelection).parse(JSON.parse(parent.values.ssh_selection ?? '')), first = selected[0]
        if (!first) throw new Error('Original SSH frozen selection missing')
        for (const item of [{ ...first, connectionId: randomUUID() }, { ...first, credentialRevision: 2 },
          { ...first, host: 'changed.example' }]) {
          const changed = { ...parent, values: { ...parent.values, ssh_selection: JSON.stringify([item]) } }
          expect(() => { validateLegacyMigrationSshOperation(changed, plan.rows, budgets) }).toThrow()
        }
        const wrongKey = createLegacyMigrationSshContext({ ...originalSshKey, key: randomBytes(32).toString('base64url') }, cut.codeId)
        expect(() => validateLegacyMigrationSsh(credential, plan.rows, budgets, cut.cut, wrongKey))
          .toThrow('migration_ssh_original_credential_unavailable')
        const missingPolicy = { ...evidence, reservedNames: evidence.reservedNames?.filter(name => name !== 'ssh_execute_propose') }
        expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(missingPolicy, originalKey, cut.codeId, budgets)))
          .toThrow('migration_stdio_call_reserved_names')
      }
      if (label === 'dispatch acknowledgement loss') {
        for (const field of ['dispatch', 'query'] as const) {
          const changed = structuredClone(evidence), takeover = changed.takeovers?.[0]
          if (takeover?.phase !== 'after-dispatch-ack-loss') throw new Error('Original lost-acknowledgement witness missing')
          if (field === 'dispatch') takeover.discardedStartReply.dispatchDigest = '0'.repeat(64)
          else {
            const query = takeover.recoveryQueries[0]
            if (!query) throw new Error('Original recovery query missing')
            query.path = `/stdio/v2/executions/${randomUUID()}`
          }
          expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(changed, originalKey, cut.codeId, budgets)))
            .toThrow('migration_stdio_takeover_dispatch_changed')
        }
      }
      if (label === 'catalog history') {
        const oldCatalog = plan.rows.find(item => item.table === 'pe_stdio_v2_catalogs' && item.values.config_revision === '1')
        if (!oldCatalog || !callAction) throw new Error('Original historical catalog absent')
        const changed = plan.rows.map(item => item.table === 'pe_stdio_v2_connections'
          ? { ...item, values: { ...item.values, current_catalog_id: oldCatalog.values.id ?? null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, changed, budgets, cut.cut, context)).toThrow()
        const missing = plan.rows.filter(item => item !== oldCatalog)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, missing, budgets, cut.cut, context)).toThrow()
      }
      if (label === 'mixed inventory with unallocated closure') {
        const unallocated = plan.rows.find(item => item.table === 'pe_stdio_v2_actions'
          && item.values.phase === 'discover' && item.values.state === 'cancelled')
        if (!unallocated) throw new Error('Original unallocated action missing')
        for (const [table, field, value] of [['pe_cloud_executions', 'runner_instance_id', randomUUID()],
          ['pe_stdio_v2_actions', 'continuation_queued', 'true'], ['pe_stdio_v2_no_start_closures', 'receipt_digest', '0'.repeat(64)]]) {
          if (!table || !field || !value) throw new Error('Owned unallocated mutation case missing')
          const changed = plan.rows.map(item => item.table === table && (item.values.id === unallocated.values.id
            || item.values.stdio_action_id === unallocated.values.id || item.values.action_id === unallocated.values.id)
            ? { ...item, values: { ...item.values, [field]: value } } : item)
          expect(() => validateLegacyMigrationStdioDiscovery(unallocated, changed, budgets, cut.cut, context)).toThrow()
        }
      }
      if (label === 'prepared discovery closures') {
        const closed = plan.rows.find(item => item.table === 'pe_stdio_v2_actions'
          && item.values.phase === 'discover' && item.values.state === 'cancelled')
        if (!closed) throw new Error('Original prepared discovery closure missing')
        const inventedCatalog = plan.rows.map(item => item.table === 'pe_stdio_v2_catalogs'
          ? { ...item, values: { ...item.values, action_id: closed.values.id ?? null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(closed, inventedCatalog, budgets, cut.cut, context)).toThrow()
        const changedCheckTime = plan.rows.map(item => item.table === 'pe_stdio_v2_management_requests'
          && item.values.request_id === closed.values.request_id ? { ...item, values: { ...item.values, created_at: cut.cut } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(closed, changedCheckTime, budgets, cut.cut, context)).toThrow()
      }
      if (label === 'failed discovery') {
        const failed = plan.rows.find(item => item.table === 'pe_stdio_v2_actions'
          && item.values.phase === 'discover' && item.values.state === 'failed')
        if (!failed) throw new Error('Original failed discovery missing')
        const inventedCatalog = plan.rows.map(item => item.table === 'pe_stdio_v2_catalogs'
          ? { ...item, values: { ...item.values, action_id: failed.values.id ?? null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(failed, inventedCatalog, budgets, cut.cut, context)).toThrow()
        const missingQuietProof = plan.rows.map(item => item.table === 'pe_stdio_v2_results' && item.values.action_id === failed.values.id
          ? { ...item, values: { ...item.values, stop_evidence: null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(failed, missingQuietProof, budgets, cut.cut, context)).toThrow()
      }
      if (label === 'started cancellation') {
        if (!callAction || callAction.values.state !== 'cancelled') throw new Error('Original started cancellation missing')
        const changedFlags = plan.rows.map(item => ['pe_stdio_v2_actions', 'pe_cloud_executions'].includes(item.table)
          ? { ...item, values: { ...item.values, cancel_requested: 'false' } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, changedFlags, budgets, cut.cut, context)).toThrow()
        const missingQuietProof = plan.rows.map(item => item.table === 'pe_stdio_v2_results' && item.values.action_id === callAction.values.id
          ? { ...item, values: { ...item.values, stop_evidence: null } } : item)
        expect(() => validateLegacyMigrationStdioDiscovery(callAction, missingQuietProof, budgets, cut.cut, context)).toThrow()
      }
      if (cloudContext) {
        const legacy = plan.rows.find(item => item.table === 'pe_cloud_executions' && item.values.execution_kind === 'legacy_command')
        if (!legacy) throw new Error('Original mixed legacy Cloud cancellation missing')
        expect(() => validateLegacyMigrationCloudCancellation(legacy, plan.rows, budgets, cut.cut, cloudContext))
          .toThrow('migration_cloud_cancel_later_writer_unqualified')
        const premature = plan.rows.map(item => ['pe_sandbox_instances', 'pe_mount_slots'].includes(item.table)
          ? { ...item, values: { ...item.values, created_at: legacy.values.created_at ?? null } } : item)
        expect(() => validateLegacyMigrationCloudCancellation(legacy, premature, budgets, cut.cut, cloudContext, context))
          .toThrow('migration_cloud_cancel_later_writer_unqualified')
        expect(() => validateLegacyMigrationCloudCancellation({ ...legacy, values: { ...legacy.values, pod_uid: randomUUID() } },
          plan.rows, budgets, cut.cut, cloudContext, context)).toThrow('migration_cloud_cancel_original_executor_missing')
      }
      const changedKey = Buffer.from(originalKey); changedKey[0] = (changedKey[0] ?? 0) ^ 1
      expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(evidence, changedKey, cut.codeId, budgets)))
        .toThrow('migration_stdio_approval_binding_changed')
      for (const field of ['capturedSpec', 'podStopped'] as const) {
        const changed = structuredClone(evidence), proof = changed.requests.find(item => item.actionId === originalAction.values.id)
        if (!proof) throw new Error('Original STDIO proof missing')
        if (field === 'capturedSpec') proof.capturedSpec.nodeName = 'changed-node'
        else proof.podStopped.metadata = { uid: randomUUID(), name: 'changed', namespace: 'changed' }
        expect(() => prepare(createLegacyMigrationStdioDiscoveryContext(changed, originalKey, cut.codeId, budgets))).toThrow()
      }
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
      createdRole = true
      await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`); createdDatabase = true
      await mkdir(join(root, 'bundle'), { mode: 0o700 })
      for (const file of files) if (file.kind === 'file' && file.sourcePath !== null) {
        const destination = join(root, 'bundle', file.sourcePath)
        await mkdir(dirname(destination), { mode: 0o700, recursive: true })
        await writeFile(destination, await readFile(join(originalRoot, 'detached-files', file.sourcePath)),
          { mode: file.mode, flag: 'wx' })
        await chmod(destination, file.mode)
      }
      await writeFile(join(root, 'source-url'), sourceUrl.href, { mode: 0o600, flag: 'wx' })
      await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
      const keys = generateKeyPairSync('ed25519'), payload = JSON.stringify(cut)
      await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-stdio-fixture',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
      await privateJson(join(root, 'cut.json'), { keyId: 'owned-stdio-fixture', payload,
        signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
      const imported = await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(),
        limits: budgets, phaseTimeoutMs: 30000, mode: 'migrate', outputFile: join(root, 'stdio-output.json'),
        failureEvidenceFile: join(root, 'stdio-failure.json'), evidenceFile: join(root, 'cut.json'), trustedEvidenceKeysFile: join(root, 'keys.json'),
        source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: sourceUrl.pathname.slice(1),
          expectedCatalogSha256: cut.catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 },
        histories, attachmentSources: [], attachmentSourceRoots: {}, files, initializeCurrent: true,
        ...(cloudContext === undefined ? {} : { cloudCancellation: { evidenceFile: join(originalRoot, 'cloud-cancel-original-evidence.json') } }),
        ...(stdioContext === undefined ? {} : { stdio: { requestEvidenceFile: join(originalRoot, 'fixed-stdio-original-evidence.json') } }),
        ...(sshContext === undefined ? {} : { ssh: { keyFile: join(originalRoot, 'ssh-original-key-declaration.json') } }),
        ...(remoteContext === undefined ? {} : { mcp: { keyFile: join(originalRoot, 'mcp-key.json'),
          requestEvidenceFile: join(originalRoot, 'mcp-evidence.json') } }),
        stdioDiscovery: { evidenceFile: join(originalRoot, 'discovery-evidence.json'), originalApprovalKeyFile: join(originalRoot, 'original-approval-key') },
        target: { urlFile: join(root, 'target-url'), expectedDatabase: database, statementTimeoutMs: 5000 },
        storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: 1000, sourceGid: 1000,
          sourceOwners: [...new Map(files.map(file => [`${file.uid}:${file.gid}`, { uid: file.uid, gid: file.gid }])).values()],
          targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'stdio')
      const completed = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), systemMigrationComplete: z.literal(false),
        storage: z.object({ roots: z.object({ workspaceRoot: z.string(), skillLibraryRoot: z.string() }).loose() }).loose() })
        .loose().parse(imported)
      expect(completed.version).toBe(CURRENT_SCHEMA_VERSION)
      const proof = evidence.requests.find(item => item.actionId === originalAction.values.id)
      if (!proof) throw new Error('Original STDIO proof missing')
      const actionId = stdioActionRequestV2.shape.actionId.parse(proof.actionId)
      const identities = new IdentityService(target, 60000), actor = await identities.login('migration-bob', password)
      const approval = await identities.login('migration-bob', password, 'approval')
      const authority = new StdioAuthorizationServiceV2(target, { limits: evidence.limits, approvalKey: originalKey,
        approvalLifetimeMs: 60000, capture: async () => { throw new Error('Retained consumer attempted new capture') } })
      try {
        const actions = new StdioActionServiceV2(target, { limits: evidence.limits, maxReplyBytes: 262144, maxPageSize: 8 })
        const detail = await actions.detail(actor.token, { actionId }), listed = await actions.list(actor.token, { offset: 0, limit: 8 })
        expect(detail.state).toBe('succeeded')
        const listedItems = [...listed.items]
        for (let offset = listed.items.length; offset < evidence.requests.length; offset += 8) {
          listedItems.push(...(await actions.list(actor.token, { offset, limit: 8 })).items)
        }
        expect(listedItems).toHaveLength(evidence.requests.length)
        expect(listedItems.map(item => item.actionId).sort()).toEqual(evidence.requests.map(item => item.actionId).sort())
        const view = await authority.inspect(approval.token, actionId)
        expect(view.decision).toBe('once')
        const receipt = stdioStartPermitV2.parse((await target.query<{ permit: unknown }>('SELECT permit FROM pe_stdio_v2_start_permits WHERE action_id=$1', [actionId])).rows[0]?.permit)
        const before = (await target.query<{ value: unknown }>(`SELECT jsonb_agg(to_jsonb(r)) AS value FROM (
          SELECT action_id,permit,issued_at,expires_at FROM pe_stdio_v2_start_permits WHERE action_id=$1) r`, [actionId])).rows[0]?.value
        expect(await authority.authorize(actionId, receipt.authorizationRequestId, receipt.executorOwner))
          .toEqual({ grantOnce: false, permit: receipt })
        const freshReceipt = await authority.authorize(actionId,
          stdioCheckRequestV2.shape.requestId.parse(randomUUID()), receipt.executorOwner)
        expect(freshReceipt.grantOnce).toBe(false)
        await expect(authority.authorize(actionId, receipt.authorizationRequestId, stdioExecutorOwnerV2.parse({ kind: 'cloud', runnerInstanceId: randomUUID() })))
          .rejects.toMatchObject({ code: 'stdio_v2_executor_owner_changed' })
        await expect(authority.inspect(actor.token, actionId)).rejects.toMatchObject({ code: 'account_unauthorized' })
        for (const callProof of evidence.requests.filter(item => item.actionId !== proof.actionId)) {
          const callId = stdioActionRequestV2.shape.actionId.parse(callProof.actionId)
          const noStart = plan.rows.find(item => item.table === 'pe_stdio_v2_no_start_closures' && item.values.action_id === callId)
          const retainedAction = plan.rows.find(item => item.table === 'pe_stdio_v2_actions' && item.values.id === callId)
          expect((await actions.detail(actor.token, { actionId: callId })).state).toBe(retainedAction?.values.state)
          const retainedDecision = plan.rows.find(item => item.table === 'pe_stdio_v2_decisions' && item.values.action_id === callId)
          const hasPreparation = plan.rows.some(item => item.table === 'pe_stdio_v2_preparations' && item.values.action_id === callId)
          if (!hasPreparation) {
            await expect(authority.inspect(approval.token, callId)).rejects.toMatchObject({ code: 'stdio_v2_not_prepared' })
            await expect(authority.authorize(callId, stdioCheckRequestV2.shape.requestId.parse(randomUUID()),
              stdioExecutorOwnerV2.parse({ kind: 'cloud', runnerInstanceId: randomUUID() })))
              .rejects.toMatchObject({ code: 'stdio_v2_not_prepared' })
            continue
          }
          expect((await authority.inspect(approval.token, callId)).decision).toBe(retainedDecision?.values.decision ?? null)
          const storedPermit = (await target.query<{ permit: unknown }>(
            'SELECT permit FROM pe_stdio_v2_start_permits WHERE action_id=$1', [callId])).rows[0]?.permit
          if (noStart) {
            expect(storedPermit).toBeUndefined()
            const preparedRow = plan.rows.find(item => item.table === 'pe_stdio_v2_preparations' && item.values.action_id === callId)
            if (!preparedRow) throw new Error('Original rejected preparation absent')
            const prepared = stdioPreparedV2.parse(JSON.parse(preparedRow.values.prepared ?? ''))
            const originalRefusal = originalNoStartRefusals?.find(item => item.actionId === callId)
            if (originalNoStartRefusals && !originalRefusal) throw new Error('Original no-start refusal result missing')
            await expect(authority.authorize(callId, stdioCheckRequestV2.shape.requestId.parse(randomUUID()),
              { kind: 'cloud', runnerInstanceId: prepared.capture.runnerInstanceId }))
              .rejects.toMatchObject({ code: originalRefusal?.code ?? 'stdio_v2_action_not_startable' })
            expect((await target.query('SELECT action_id FROM pe_stdio_v2_start_permits WHERE action_id=$1', [callId])).rowCount).toBe(0)
            continue
          }
          const takeover = evidence.takeovers?.find(item => item.actionId === callId)
          if (takeover) {
            const store = new StdioCloudWorkerStoreV2(target, { limits: evidence.limits, leaseMs: 30000, maxActive: 2, maxCandidates: 8 })
            await expect(store.snapshot(takeover.oldLease)).rejects.toMatchObject({ code: 'stdio_v2_lease_lost' })
            const preparedRow = plan.rows.find(item => item.table === 'pe_stdio_v2_preparations' && item.values.action_id === callId)
            if (!preparedRow) throw new Error('Original takeover preparation absent')
            const prepared = stdioPreparedV2.parse(JSON.parse(preparedRow.values.prepared ?? ''))
            await expect(authority.authorizeLeased(takeover.oldLease, stdioCheckRequestV2.shape.requestId.parse(randomUUID()),
              { kind: 'cloud', runnerInstanceId: prepared.capture.runnerInstanceId })).rejects.toMatchObject({ code: 'stdio_v2_lease_lost' })
          }
          const callPermit = stdioStartPermitV2.parse(storedPermit)
          expect(await authority.authorize(callId, callPermit.authorizationRequestId, callPermit.executorOwner))
            .toEqual({ grantOnce: false, permit: callPermit })
          expect((await authority.authorize(callId, stdioCheckRequestV2.shape.requestId.parse(randomUUID()),
            callPermit.executorOwner)).grantOnce).toBe(false)
        }
        const connections = new StdioConnectionServiceV2(target, evidence.limits, evidence.management)
        const enabled = await connections.toggle(actor.token, { requestId: stdioCheckRequestV2.shape.requestId.parse(randomUUID()),
          connectionId: stdioCheckRequestV2.shape.connectionId.parse(proof.connectionId),
          expectedRevision: Number(plan.rows.find(item => item.table === 'pe_stdio_v2_connections')?.values.revision),
          enabled: label !== 'failed discovery' })
        expect(enabled.enabled).toBe(label !== 'failed discovery')
        if (label === 'failed discovery') {
          await expect(connections.toggle(actor.token, { requestId: stdioCheckRequestV2.shape.requestId.parse(randomUUID()),
            connectionId: stdioCheckRequestV2.shape.connectionId.parse(proof.connectionId), expectedRevision: 2, enabled: true }))
            .rejects.toMatchObject({ code: 'stdio_v2_catalog_required' })
        }
        const filesService = new FileService(target, completed.storage.roots.workspaceRoot); await filesService.init()
        const discovery = new StdioAdmissionServiceV2(target, filesService, { limits: evidence.limits, management: evidence.management,
          maxPendingPerUser: 8, deployments: { cloud: evidence.deploymentPin } })
        const sourceRequest = plan.rows.find(item => item.table === 'pe_stdio_v2_management_requests' && item.values.purpose === 'check')
        if (!sourceRequest) throw new Error('Original discovery receipt missing')
        const retryInput = stdioCheckRequestV2.parse(JSON.parse(sourceRequest.values.request ?? ''))
        expect(await discovery.check(actor.token, retryInput)).toEqual(stdioV2Schemas.checkReceipt.parse(JSON.parse(sourceRequest.values.receipt ?? '')))
        const selection = new StdioOperationAdmissionV2(filesService, { limits: evidence.limits,
          admission: evidence.admission ?? { maxConnections: 8, maxTools: 16, maxSnapshotBytes: 65536, maxDescriptionBytes: 8192 },
          maxReplyBytes: 262144, cloudDeployment: evidence.deploymentPin })
        if (callAction) {
          const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction.values.operation_id)
          if (!parent) throw new Error('Original call operation missing')
          const frozen: unknown = JSON.parse(parent.values.stdio_v2_selection ?? '')
          expect(selection.restore(frozen, evidence.reservedNames ?? [])).toEqual(frozen)
          const currentGroups = await transaction(target, client => selection.select(client, actor.user.userId,
            sessionId.parse(proof.sessionId), { kind: 'cloud' }, evidence.reservedNames ?? []))
          if (label === 'catalog history' || label === 'writer history' || label.startsWith('mixed inventory')) {
            const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
            const originalApi = label === 'catalog history'
              ? z.object({ history: z.object({ currentSelection: z.unknown() }).loose() }).loose().parse(rawApi)
              : { history: z.object({ currentSelection: z.unknown() }).loose().parse(rawApi) }
            expect(currentGroups).toEqual(originalApi.history.currentSelection)
            expect(currentGroups).not.toEqual(frozen)
            expect(plan.rows.filter(item => item.table === 'pe_stdio_v2_configurations'))
              .toHaveLength(label.includes('all STDIO closures') ? 6 : ['catalog history', 'writer history'].includes(label) ? 2 : 4)
            expect(plan.rows.filter(item => item.table === 'pe_stdio_v2_catalogs'))
              .toHaveLength(label.includes('all STDIO closures') ? 5 : ['catalog history', 'writer history'].includes(label) ? 2 : 4)
          } else expect(currentGroups).toEqual(frozen)
          const tasks = new TaskStore(target, { ...taskLimits, mcpEnabled: label.includes('fixed MCP') || label.includes('text Skill'),
            stdioMcpEnabled: stdioContext !== undefined,
            sshEnabled: sshContext !== undefined,
            stdioV2Admission: { selection, reservedNames: evidence.reservedNames ?? [] } })
          const retry = await tasks.accept(actor.user, sessionId.parse(proof.sessionId), requestId.parse(parent.values.request_id),
            parent.values.input ?? '', actor.token)
          expect(z.object({ operationId: z.uuid() }).loose().parse(retry).operationId).toBe(parent.values.id)
          expect(await tasks.claim(sessionId.parse(proof.sessionId))).toBeNull()
          expect((await target.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM pe_operations WHERE source_stdio_v2_action_id=$1 OR source_stdio_v2_no_start_action_id=$1', [callAction.values.id])).rows[0]?.n).toBe('1')
          if (label === 'three-turn chain') {
            const chain = (await target.query<{ calls: number; max_calls: number; error_code: string }>(
              'SELECT calls,max_calls,error_code FROM pe_mcp_action_chains WHERE root_operation_id=$1',
              [callAction.values.root_operation_id])).rows[0]
            expect(chain).toEqual({ calls: 3, max_calls: 8, error_code: 'stdio_v2_start_never_authorized' })
            const continuations = (await target.query<{ id: string; input: string }>(
              'SELECT id,input FROM pe_operations WHERE mcp_root_operation_id=$1 ORDER BY id',
              [callAction.values.root_operation_id])).rows
            expect(continuations).toHaveLength(3)
            const bodies = continuations.map((item) => {
              const original = plan.rows.find(row => row.table === 'pe_operations' && row.values.id === item.id)
              expect(item.input).toBe(original?.values.input)
              return z.object({ chainStopped: z.boolean(), errorCode: z.string().nullable() }).loose().parse(JSON.parse(item.input))
            })
            expect(bodies.filter(item => item.chainStopped)).toHaveLength(1)
            expect(bodies.filter(item => !item.chainStopped && item.errorCode === null)).toHaveLength(2)
          }
          if (label === 'writer history') {
            const slot = (await target.query<{ generation: string; stop_pod_uid: string }>(
              'SELECT generation::text AS generation,stop_pod_uid FROM pe_mount_slots WHERE user_id=$1', [actor.user.userId])).rows[0]
            const latest = plan.rows.find(item => item.table === 'pe_mount_slots')
            expect(slot).toEqual({ generation: '2', stop_pod_uid: latest?.values.stop_pod_uid })
            expect((await target.query('SELECT session_id FROM pe_sandbox_instances')).rowCount).toBe(1)
            expect(plan.rows.filter(item => item.table === 'pe_stdio_v2_results')).toHaveLength(4)
            const historical = evidence.requests.find(item => item.historicalWriter)
            expect(historical?.historicalWriter?.slot.values.generation).toBe('1')
            expect(historical?.historicalWriter?.slot.values.stop_pod_uid).not.toBe(slot?.stop_pod_uid)
          }
        } else if (label === 'prepared discovery closures' || label === 'failed discovery') {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const originalApi = z.object({ currentSelection: z.unknown() }).loose().parse(rawApi)
          expect(await transaction(target, client => selection.select(client, actor.user.userId,
            sessionId.parse(proof.sessionId), { kind: 'cloud' }, []))).toEqual(originalApi.currentSelection)
          expect(plan.rows.filter(item => item.table === 'pe_stdio_v2_catalogs')).toHaveLength(1)
          expect(plan.rows.filter(item => item.table === 'pe_operations')).toHaveLength(0)
        } else {
          await expect(transaction(target, client => selection.select(client, actor.user.userId,
            sessionId.parse(proof.sessionId), { kind: 'cloud' }, []))).rejects.toMatchObject({ code: 'stdio_v2_schema_unsupported' })
        }
        if (remoteKey && remoteEvidence) {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const original = z.object({ remoteMcp: z.object({ created: z.object({ connectionId: mcpConnectionId }).loose(),
            current: z.unknown(), listed: z.unknown(), succeeded: z.object({ checkId: mcpCheckId, catalogId: mcpCatalogId }).loose(),
            failed: z.object({ checkId: mcpCheckId }).loose(), catalog: z.unknown(), succeededCancel: z.unknown(),
            failedCancel: z.unknown(), queued: z.unknown(), queuedFailure: z.unknown(), checkInput: z.unknown(),
            failedInput: z.unknown(), frozenSelection: z.array(z.object({ connectionId: z.uuid() }).loose()),
            management: z.object({ maxConnections: z.number(), maxPendingTickets: z.number(), maxActiveChecks: z.number(),
              maxDrafts: z.number(), maxDraftsPerHour: z.number(), maxTools: z.number(), maxCatalogBytes: z.number(),
              maxToolBytes: z.number(), ticketLifetimeMs: z.number(), checkLifetimeMs: z.number(), draftLifetimeMs: z.number(),
              retentionMs: z.number(), checkLeaseMs: z.number() }).strict(), remoteToolActionsStarted: z.literal(false),
          }).loose() }).loose().parse(rawApi).remoteMcp
          const service = new McpConnectionService(target, remoteKey.key, { ...original.management,
            assertEndpoint: () => { throw new Error('Retained remote consumer attempted endpoint admission') } })
          const before = (await target.query('SELECT * FROM pe_mcp_checks ORDER BY id')).rows
          expect(await service.get(actor.user, original.created.connectionId)).toEqual(original.current)
          expect(await service.list(actor.user)).toEqual(original.listed)
          expect(await service.check(actor.user, original.succeeded.checkId)).toEqual(original.succeeded)
          expect(await service.check(actor.user, original.failed.checkId)).toEqual(original.failed)
          expect(await service.getCatalog(actor.user, original.succeeded.catalogId)).toEqual(original.catalog)
          expect(await service.cancelCheck(actor.user, original.succeeded.checkId)).toEqual(original.succeededCancel)
          expect(await service.cancelCheck(actor.user, original.failed.checkId)).toEqual(original.failedCancel)
          expect(await service.startCheck(actor.user, original.checkInput)).toEqual(original.queued)
          expect(await service.startCheck(actor.user, original.failedInput)).toEqual(original.queuedFailure)
          expect(await service.claimCheck(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
          expect(await transaction(target, client => service.admissionCatalogs(client, actor.user))).toEqual([])
          const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
          await expect(service.check(foreign, original.succeeded.checkId)).rejects.toMatchObject({ code: 'mcp_check_not_found' })
          await expect(service.getCatalog(foreign, original.succeeded.catalogId)).rejects.toMatchObject({ code: 'mcp_catalog_not_found' })
          const parent = plan.rows.find(item => item.table === 'pe_operations' && item.values.id === callAction?.values.operation_id)
          expect(JSON.parse(parent?.values.remote_mcp_selection ?? 'null')).toEqual(original.frozenSelection)
          expect((await target.query('SELECT * FROM pe_mcp_checks ORDER BY id')).rows).toEqual(before)
        }
        if (label === 'package Skill selection') {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const original = z.object({ packageSkill: z.object({ requestId: z.uuid(), archiveDigest: z.string(), sizeBytes: z.number(),
            installed: z.unknown(), disabled: z.unknown(), read: z.unknown(), selected: z.unknown(), snapshot: z.unknown(),
            frozenSelection: z.array(skillSelection), packageScriptsExecuted: z.literal(false) }).loose() }).loose()
            .parse(rawApi).packageSkill
          const selected = original.frozenSelection[0]
          if (!selected || selected.kind !== 'package') throw new Error('Original package consumer selection absent')
          const service = new SkillService(target, completed.storage.roots.workspaceRoot, completed.storage.roots.skillLibraryRoot)
          await service.init()
          const retained = (await target.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows
          expect(await service.read(actor.user, original.requestId)).toEqual(original.read)
          expect(await service.readSelected(actor.user.userId, selected, original.requestId)).toEqual(original.selected)
          expect(await service.snapshot(actor.user.userId, original.frozenSelection)).toEqual(original.snapshot)
          expect(await service.toggle(actor.user, original.requestId, false)).toEqual(original.disabled)
          await expect(service.readSelected(randomUUID(), selected, original.requestId)).rejects.toMatchObject({ code: 'skill_not_found' })
          expect((await service.issueUploadTicket(actor.user, original.requestId, original.sizeBytes, original.archiveDigest,
            'http://127.0.0.1'))).toEqual({ state: 'ready', item: original.disabled })
          expect((await target.query('SELECT * FROM pe_skill_package_versions ORDER BY id')).rows).toEqual(retained)
        }
        if (label.includes('fixed MCP') || label.includes('text Skill')) {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const result = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(), enabled: z.boolean() }).loose()
          const original = z.object({ fixedMcp: z.object({
            installInput: z.object({ requestId: z.uuid(), name: z.string() }).strict(), installed: result,
            listed: z.object({ items: z.array(result) }).loose(),
            updates: z.array(z.object({ input: z.object({ connectionId: z.uuid(), requestId: z.uuid(),
              baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict(), receipt: result }).strict()),
          }).loose() }).loose().parse(rawApi).fixedMcp
          const tasks = new TaskStore(target, { ...taskLimits, mcpEnabled: true })
          const service = new PersonalMcpService(tasks, '', '', 5000)
          const owners = (await target.query('SELECT * FROM pe_mcp_connections ORDER BY id')).rows
          const updates = (await target.query('SELECT * FROM pe_mcp_updates ORDER BY request_id')).rows
          const operations = (await target.query('SELECT * FROM pe_operations ORDER BY id')).rows
          expect((await service.list(actor.user)).items).toEqual(original.listed.items)
          expect(await service.install(actor.user, original.installInput.requestId, original.installInput.name)).toEqual(original.installed)
          for (const update of original.updates) {
            expect(await service.toggle(actor.user, update.input.connectionId, update.input.requestId,
              update.input.baseRevision, update.input.enabled)).toEqual(update.receipt)
            await expect(service.toggle(actor.user, update.input.connectionId, update.input.requestId,
              update.input.baseRevision, !update.input.enabled)).rejects.toMatchObject({ code: 'request_id_conflict' })
          }
          const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
          expect((await service.list(foreign)).items).toEqual([])
          expect((await target.query('SELECT * FROM pe_mcp_connections ORDER BY id')).rows).toEqual(owners)
          expect((await target.query('SELECT * FROM pe_mcp_updates ORDER BY request_id')).rows).toEqual(updates)
          expect((await target.query('SELECT * FROM pe_operations ORDER BY id')).rows).toEqual(operations)
        }
        if (label.includes('text Skill')) {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const original = z.object({ textSkill: z.object({ input: z.object({ id: z.uuid(), name: z.string(),
            description: z.string(), instructions: z.string() }).strict(), selected: z.unknown(), snapshot: z.unknown(),
          disabled: z.unknown(), read: z.unknown(), frozenSelection: z.array(skillSelection) }).loose() }).loose().parse(rawApi).textSkill
          const selected = original.frozenSelection[0]
          if (!selected) throw new Error('Original text Skill frozen selection missing')
          const service = new SkillService(target, completed.storage.roots.workspaceRoot)
          await service.init()
          const owners = (await target.query('SELECT * FROM pe_user_skills ORDER BY id')).rows
          expect(await service.read(actor.user, original.input.id)).toEqual(original.read)
          expect(await service.readSelected(actor.user.userId, selected, original.input.id)).toEqual(original.selected)
          expect(await service.snapshot(actor.user.userId, original.frozenSelection)).toEqual(original.snapshot)
          expect(await service.toggle(actor.user, original.input.id, false)).toEqual(original.disabled)
          expect(await service.install(actor.user, original.input.id, original.input.name, original.input.description,
            original.input.instructions)).toEqual(original.disabled)
          await expect(service.readSelected(randomUUID(), selected, original.input.id)).rejects.toMatchObject({ code: 'skill_not_found' })
          expect(await readFile(join(completed.storage.roots.workspaceRoot, 'extensions', actor.user.userId,
            `${original.input.id}.md`), 'utf8')).toBe(original.input.instructions)
          expect((await target.query('SELECT * FROM pe_user_skills ORDER BY id')).rows).toEqual(owners)
        }
        if (stdioContext) {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const result = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(), enabled: z.boolean() }).loose()
          const original = z.object({ fixedStdio: z.object({ installInput: z.object({ requestId: z.uuid(), name: z.string() }).strict(),
            installed: result, listed: z.object({ items: z.array(result) }).loose(), metadataRunnerRequests: z.literal(0),
            workerStarted: z.literal(false), callsCreated: z.literal(0),
            updates: z.array(z.object({ requestId: z.uuid(), input: z.object({ id: z.uuid(),
              baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict(), receipt: result }).loose()),
          }).strict() }).loose().parse(rawApi).fixedStdio
          const service = new StdioMcpService(new TaskStore(target, taskLimits), null, randomUUID(), 60000)
          const owners = (await target.query('SELECT * FROM pe_stdio_mcp_connections ORDER BY id')).rows
          const updates = (await target.query('SELECT * FROM pe_stdio_mcp_updates ORDER BY request_id')).rows
          try {
            expect((await service.list(actor.user)).items).toEqual(original.listed.items)
            expect(await service.install(actor.user, original.installInput.requestId, original.installInput.name))
              .toEqual(original.installed)
            for (const update of original.updates) {
              expect(await service.toggle(actor.user, update.input.id, update.requestId,
                update.input.baseRevision, update.input.enabled)).toEqual(update.receipt)
              await expect(service.toggle(actor.user, update.input.id, update.requestId,
                update.input.baseRevision, !update.input.enabled)).rejects.toMatchObject({ code: 'request_id_conflict' })
            }
            expect(await service.calls(actor.user)).toEqual({ items: [] })
            expect((await service.list(identity.parse({ ...actor.user, userId: randomUUID() }))).items).toEqual([])
            expect((await target.query('SELECT * FROM pe_stdio_mcp_connections ORDER BY id')).rows).toEqual(owners)
            expect((await target.query('SELECT * FROM pe_stdio_mcp_updates ORDER BY request_id')).rows).toEqual(updates)
          } finally { await service.close() }
        }
        if (sshContext && originalSshKey) {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const original = z.object({ sshMetadata: z.object({ keyId: z.string(), input: sshCreateTicketRequest,
            installed: z.unknown(), listed: z.object({ items: z.array(z.unknown()) }).loose(), frozenSelection: z.array(sshSelection),
            workerStarted: z.literal(false), actionsCreated: z.literal(0), callsCreated: z.literal(0),
            updates: z.array(z.object({ requestId: z.uuid(), input: z.object({ connectionId: z.uuid(),
              baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict(), receipt: z.unknown() }).strict()),
          }).strict() }).loose().parse(rawApi).sshMetadata
          const service = new SshConnectionService(target, originalSshKey.key, 'legacy.example:22', { ticketLifetimeMs: 10000 })
          const owners = (await target.query('SELECT * FROM pe_ssh_connections ORDER BY id')).rows
          const credentials = (await target.query<{ connection_id: string; credential_revision: number; encrypted_credential: Buffer }>(
            'SELECT * FROM pe_ssh_credential_versions ORDER BY connection_id,credential_revision')).rows
          const management = (await target.query('SELECT * FROM pe_ssh_management_requests ORDER BY request_id')).rows
          expect((await service.list(actor.user)).items).toEqual(original.listed.items)
          expect((await service.list(identity.parse({ ...actor.user, userId: randomUUID() }))).items).toEqual([])
          for (const update of original.updates) {
            expect(await service.toggle(actor.user, update.input.connectionId, update.requestId,
              update.input.baseRevision, update.input.enabled)).toEqual(update.receipt)
            await expect(service.toggle(actor.user, update.input.connectionId, update.requestId,
              update.input.baseRevision, !update.input.enabled)).rejects.toMatchObject({ code: 'request_id_conflict' })
          }
          for (const credential of credentials) {
            const source = capture.tables.pe_ssh_credential_versions?.find(item => item.connection_id === credential.connection_id
              && item.credential_revision === String(credential.credential_revision))
            if (!source) throw new Error('Original SSH ciphertext missing')
            expect(Buffer.from(credential.encrypted_credential).toString('hex')).toBe(source.encrypted_credential?.slice(2))
          }
          expect((await target.query('SELECT * FROM pe_ssh_connections ORDER BY id')).rows).toEqual(owners)
          expect((await target.query('SELECT * FROM pe_ssh_credential_versions ORDER BY connection_id,credential_revision')).rows)
            .toEqual(credentials)
          expect((await target.query('SELECT * FROM pe_ssh_management_requests ORDER BY request_id')).rows).toEqual(management)
          expect((await target.query<{ n: string }>('SELECT count(*)::text AS n FROM pe_ssh_calls')).rows[0]?.n).toBe('0')
          expect((await target.query<{ n: string }>('SELECT count(*)::text AS n FROM pe_ssh_execute_actions')).rows[0]?.n).toBe('0')
        }
        if (cloudContext) {
          const rawApi: unknown = JSON.parse(await readFile(join(originalRoot, 'original-ready-stdio-results.json'), 'utf8'))
          const original = z.object({ cloudCancellation: z.object({ executionId: z.uuid(), originalRequest: z.uuid(), input: z.string(),
            operationId: z.uuid(), commandTimeoutMs: z.number().int().positive(), listed: z.unknown(), terminal: z.unknown() }).loose() })
            .loose()
            .parse(rawApi).cloudCancellation
          const configuration = z.object({ hostKubeconfig: z.string() }).loose()
            .parse(JSON.parse(await readFile(join(originalRoot, '..', 'resources.json'), 'utf8')))
          const kube = await KubernetesClient.fromFile(configuration.hostKubeconfig)
          let transportRequests = 0
          kube.call = async () => { transportRequests++; throw new Error('Retained terminal command attempted Kubernetes') }
          const tasks = new TaskStore(target, { ...taskLimits, executionEnabled: true })
          const sandboxes = new SandboxManager(kube, filesService, target, 'F'.repeat(43), {
            namespace: `pe-e5-current-unused-${randomUUID().replaceAll('-', '')}`, image: evidence.deploymentPin.imageReference,
            localRoot: join(root, 'current-cloud-unused'), nodeRoot: join(root, 'current-node-unused'),
            readyTimeoutMs: 1000, maxExecutions: 8,
          })
          const service = new ExecutionService(tasks, sandboxes, 1, 100, 60000, original.commandTimeoutMs)
          const executions = (await target.query('SELECT * FROM pe_cloud_executions ORDER BY id')).rows
          const operations = (await target.query('SELECT * FROM pe_operations ORDER BY id')).rows
          try {
            expect(await service.list(actor.user)).toEqual(original.listed)
            expect(await service.cancel(actor.user, original.executionId)).toEqual(original.terminal)
            const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
            expect(await service.list(foreign)).toEqual({ items: [] })
            await expect(service.cancel(foreign, original.executionId)).rejects.toMatchObject({ code: 'execution_not_found' })
            expect(await tasks.accept(actor.user, sessionId.parse(proof.sessionId), requestId.parse(original.originalRequest),
              original.input, actor.token)).toMatchObject({ operationId: original.operationId, state: 'failed' })
            expect(await tasks.claim(sessionId.parse(proof.sessionId))).toBeNull()
            expect((await target.query('SELECT * FROM pe_cloud_executions ORDER BY id')).rows).toEqual(executions)
            expect((await target.query('SELECT * FROM pe_operations ORDER BY id')).rows).toEqual(operations)
            expect(transportRequests).toBe(0)
          } finally { await service.close() }
        }
        const after = (await target.query<{ value: unknown }>(`SELECT jsonb_agg(to_jsonb(r)) AS value FROM (
          SELECT action_id,permit,issued_at,expires_at FROM pe_stdio_v2_start_permits WHERE action_id=$1) r`, [actionId])).rows[0]?.value
        expect(after).toEqual(before)
        await privateJson(join(root, 'ordinary-consumers.json'), { detail, listed, view, retainedPermit: receipt,
          grantOnceRetried: false, grantOnceFreshRequest: false, enabled,
          originalSchemaSelectionRefusal: label === 'discovery' ? 'stdio_v2_schema_unsupported' : null,
          originalCallContinuationUnique: Boolean(callAction), originalFrozenSelectionRestored: Boolean(callAction),
          originalFixedMcpSelectionRetained: label.includes('fixed MCP') || label.includes('text Skill'),
          originalTextSkillBytesRetained: label.includes('text Skill'),
          originalFixedStdioMetadataRetained: stdioContext !== undefined,
          originalSshCiphertextRetained: sshContext !== undefined,
          permitUnchanged: true, sourceModified: false,
          ownedFixture: true, productionMigration: false, schemaVersion: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
      } finally { await identities.logout(actor.token); await identities.logout(approval.token) }
    } finally {
      await Promise.all([source.end(), target.end()])
      if (createdDatabase) await admin.query(`DROP DATABASE "${database}"`)
      if (createdRole) await admin.query(`DROP ROLE "${role}"`)
      await admin.end()
    }
  }, 90000)

}

let finalInventoryCleanupConfirmed = true
let finalInventoryUnsafe: unknown
beforeEach(() => {
  if (finalInventoryUnsafe !== undefined || !finalInventoryCleanupConfirmed) {
    throw new Error('Previous final inventory cleanup is unconfirmed', { cause: finalInventoryUnsafe })
  }
})

/** Cancel unfinished work and retain its owners until actual resource absence is confirmed. */
function ownedFinalInventory(context: TestContext,
  run: (owner: OwnedMaintenanceTask) => Promise<void>): Promise<void> {
  if (finalInventoryUnsafe !== undefined || !finalInventoryCleanupConfirmed) throw new Error('Previous final inventory cleanup is unconfirmed')
  finalInventoryCleanupConfirmed = false
  const drain = new MaintenanceDrain(context.signal, (error) => { finalInventoryUnsafe ??= error })
  const owner: OwnedMaintenanceTask = { signal: drain.signal, drain, profileStopped: true,
    confirmCleanup: () => {
      drain.confirmed()
      if (finalInventoryUnsafe === undefined) finalInventoryCleanupConfirmed = true
    } }
  const completion = Promise.resolve().then(() => run(owner)).finally(() => {
    if (owner.postgres === undefined) { drain.begin(); owner.confirmCleanup() }
  })
  const observed = completion.then(() => undefined, (_caseFailure: unknown) => undefined)
  context.onTestFinished(async () => {
    if (drain.isConfirmed()) return
    drain.begin()
    await drain.step('fixture completion and cleanup', 25000, () => observed)
    if (!finalInventoryCleanupConfirmed || finalInventoryUnsafe !== undefined) {
      throw new AggregateError(drain.issues.map(issue => issue.error), 'Final inventory cleanup is unconfirmed')
    }
  }, 30000)
  return completion
}

async function verifyFinalOriginalNineInventory(owner: OwnedMaintenanceTask): Promise<void> {
  const { signal } = owner
  signal.throwIfAborted()
  const originalRoot = process.env.PE_EMPLOYEE5_FINAL_NINE_INVENTORY
  if (!originalRoot) throw new Error('Final original owner inventory required')
  const capture = z.object({ format: z.literal('power-evolve-legacy-offline'), version: z.literal(2),
    source: z.object({ schema: z.literal(37), ddlSha256: z.string(), snapshotId: z.uuid(), codeId: z.string(),
      stoppedAt: z.string(), cut: z.string() }).strict(), snapshot: z.string(), catalogSha256: z.string(), sha256: z.string(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.string().nullable()))) }).strict()
    .parse(JSON.parse(await readFile(join(originalRoot, 'capture.json'), 'utf8')))
  const files = z.array(z.object({ area: z.enum(['workspace', 'home', 'skill-text', 'skill-package', 'office']), owner: z.uuid(),
    resource: z.string(), path: z.string(), kind: z.enum(['directory', 'file']), sourcePath: z.string().nullable(),
    bytes: z.string().nullable(), sha256: z.string().nullable(), mode: z.number(), uid: z.number(), gid: z.number() }).strict())
    .parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
  const evidence = legacyMigrationStdioDiscoveryEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'discovery-evidence.json'), 'utf8')))
  const resolutions = legacyMigrationCloudResolutionEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'resolution-evidence.json'), 'utf8')))
  const provenance = z.object({ originalRowsUnchanged: z.literal(true), productionSource: z.literal(false),
    originalRoots: z.tuple([z.string(), z.string(), z.string()]) }).loose()
    .parse(JSON.parse(await readFile(join(originalRoot, 'provenance.json'), 'utf8')))
  const payload = await readFile(join(originalRoot, 'cut-payload.json'), 'utf8')
  const originalSourceUrl = new URL((await readFile(join(originalRoot, 'readonly-url-private'), 'utf8')).trim())
  const suffix = randomUUID().replaceAll('-', '')
  const database = `pe_employee5_v2_target_${suffix}`, role = `pe_employee5_v2_owner_${suffix}`, originalTargetUrl = new URL(adminUrl)
  originalTargetUrl.pathname = `/${database}`; originalTargetUrl.username = role; originalTargetUrl.password = randomUUID()
  signal.throwIfAborted()
  const root = await mkdtemp(join(originalRoot, 'schema5-consumer-'))
  signal.throwIfAborted()
  const postgres = new MaintenancePg(originalSourceUrl, originalTargetUrl, adminUrl, `e5-final-${suffix}`, owner.drain)
  owner.postgres = postgres
  const { admin, target, sourceUrl, targetUrl } = postgres
  let caseFailed = false, caseCause: unknown
  try {
    await postgres.prepare()
    signal.throwIfAborted()
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    signal.throwIfAborted()
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`)
    signal.throwIfAborted()
    await mkdir(join(root, 'bundle'), { mode: 0o700 })
    for (const file of files) if (file.sourcePath !== null) {
      signal.throwIfAborted()
      const destination = join(root, 'bundle', file.sourcePath)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, await readFile(join(originalRoot, 'detached-files', file.sourcePath)), { mode: file.mode, flag: 'wx' })
      await chmod(destination, file.mode)
    }
    await writeFile(join(root, 'source-url'), sourceUrl.href, { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
    const keys = generateKeyPairSync('ed25519')
    await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-final-nine',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(root, 'cut.json'), { keyId: 'owned-final-nine', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    const completed = z.object({ version: z.literal(CURRENT_SCHEMA_VERSION), systemMigrationComplete: z.literal(false),
      storage: z.object({ roots: z.object({ workspaceRoot: z.string(), skillLibraryRoot: z.string() }).loose() }).loose() }).loose()
      .parse(await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
        phaseTimeoutMs: 30000, mode: 'migrate', outputFile: join(root, 'final-nine-output.json'),
        failureEvidenceFile: join(root, 'final-nine-failure.json'),
        evidenceFile: join(root, 'cut.json'), trustedEvidenceKeysFile: join(root, 'keys.json'), initializeCurrent: true,
        source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: sourceUrl.pathname.slice(1),
          expectedCatalogSha256: capture.catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 },
        histories: capture.tables.pe_sessions?.map(row => ({ sessionId: row.id, encoding: 'pg-logical' })),
        attachmentSources: [], attachmentSourceRoots: {}, files,
        mcp: { keyFile: join(originalRoot, 'mcp-key.json'), requestEvidenceFile: join(originalRoot, 'mcp-evidence.json') },
        ssh: { keyFile: join(originalRoot, 'ssh-original-key-declaration.json') },
        stdio: { requestEvidenceFile: join(originalRoot, 'fixed-stdio-original-evidence.json') },
        cloudCancellation: { evidenceFile: join(originalRoot, 'cloud-cancel-original-evidence.json') },
        cloudResolution: { evidenceFile: join(originalRoot, 'resolution-evidence.json') },
        stdioDiscovery: { evidenceFile: join(originalRoot, 'discovery-evidence.json'), originalApprovalKeyFile: join(originalRoot, 'original-approval-key') },
        target: { urlFile: join(root, 'target-url'), expectedDatabase: database, statementTimeoutMs: 5000 },
        storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: 1000, sourceGid: 1000,
          sourceOwners: [...new Map(files.map(file => [`${file.uid}:${file.gid}`, { uid: file.uid, gid: file.gid }])).values()],
          targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'final-nine', 0, owner))
    signal.throwIfAborted()
    const ownerTables = ['pe_sandbox_instances', 'pe_cloud_execution_resolutions', 'pe_stdio_v2_preparations', 'pe_stdio_v2_decisions',
      'pe_stdio_v2_start_permits', 'pe_stdio_v2_dispatches', 'pe_stdio_v2_results', 'pe_stdio_v2_catalogs', 'pe_stdio_v2_observations']
    const retainedRows = async () => {
      const rows: Record<string, Array<Record<string, string | null>>> = {}
      for (const table of ownerTables) {
        const layout = LEGACY_SOURCE_LAYOUT[table]
        if (!layout) throw new Error('Original owner layout missing')
        const projection = Object.entries(layout).map(([column, field]) => field.kind === 'timestamptz'
          ? `to_char("${column}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${column}"`
          : `"${column}"::text AS "${column}"`).join(',')
        signal.throwIfAborted()
        rows[table] = (await target.query<Record<string, string | null>>(`SELECT ${projection} FROM "${table}"`)).rows
      }
      return rows
    }
    const before = await retainedRows()
    for (const table of ownerTables) {
      expect(before[table]?.length).toBeGreaterThan(0)
      expect(before[table]?.map(row => legacyRowDigest(table, row)).sort())
        .toEqual(capture.tables[table]?.map(row => legacyRowDigest(table, row)).sort())
    }
    const identities = new IdentityService(target, 60000), actors = []
    try {
      for (const username of ['migration-bob', 'employee5-final-inventory']) {
        signal.throwIfAborted()
        actors.push(await identities.login(username, password))
      }
      const actions = new StdioActionServiceV2(target, { limits: evidence.limits, maxReplyBytes: 262144, maxPageSize: 8 })
      const approvalKey = Buffer.from((await readFile(join(originalRoot, 'original-approval-key'), 'utf8')).trim(), 'hex')
      const authority = new StdioAuthorizationServiceV2(target, { limits: evidence.limits, approvalKey, approvalLifetimeMs: 60000,
        capture: async () => { throw new Error('Final retained consumer attempted new capture') } })
      for (const proof of evidence.requests) {
        signal.throwIfAborted()
        const actor = actors.find(item => item.user.userId === proof.userId)
        if (!actor) throw new Error('Original STDIO account missing')
        const actionId = stdioActionRequestV2.shape.actionId.parse(proof.actionId)
        signal.throwIfAborted()
        const detail = await actions.detail(actor.token, { actionId })
        expect(['succeeded', 'failed', 'cancelled', 'rejected']).toContain(detail.state)
        signal.throwIfAborted()
        const permit = (await target.query<{ permit: unknown }>('SELECT permit FROM pe_stdio_v2_start_permits WHERE action_id=$1', [actionId])).rows[0]
        if (permit) {
          const original = stdioStartPermitV2.parse(permit.permit)
          signal.throwIfAborted()
          expect(await authority.authorize(actionId, original.authorizationRequestId, original.executorOwner))
            .toEqual({ grantOnce: false, permit: original })
        }
      }
      const added = z.object({ packageSkill: z.object({ requestId: z.uuid(), read: z.unknown(), selected: z.unknown(),
        snapshot: z.unknown(), frozenSelection: z.array(skillSelection) }).loose(),
      remoteMcp: z.object({ created: z.object({ connectionId: mcpConnectionId }).loose(), current: z.unknown(),
        succeeded: z.object({ checkId: mcpCheckId, catalogId: mcpCatalogId }).loose(), failed: z.object({ checkId: mcpCheckId }).loose(),
        catalog: z.unknown(), management: z.record(z.string(), z.number()) }).loose() }).loose()
        .parse(JSON.parse(await readFile(join(provenance.originalRoots[1], 'original-ready-stdio-results.json'), 'utf8')))
      const addedActor = actors[1], selected = added.packageSkill.frozenSelection[0]
      if (!addedActor || !selected) throw new Error('Final original package account missing')
      const skills = new SkillService(target, completed.storage.roots.workspaceRoot, completed.storage.roots.skillLibraryRoot)
      signal.throwIfAborted()
      await skills.init()
      signal.throwIfAborted()
      expect(await skills.read(addedActor.user, added.packageSkill.requestId)).toEqual(added.packageSkill.read)
      signal.throwIfAborted()
      expect(await skills.readSelected(addedActor.user.userId, selected, added.packageSkill.requestId)).toEqual(added.packageSkill.selected)
      signal.throwIfAborted()
      expect(await skills.snapshot(addedActor.user.userId, added.packageSkill.frozenSelection)).toEqual(added.packageSkill.snapshot)
      const mcpKey = legacyMigrationMcpKey.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-key.json'), 'utf8')))
      const remote = new McpConnectionService(target, mcpKey.key, { ...remoteMcpLimits,
        assertEndpoint: () => { throw new Error('Final retained consumer attempted remote endpoint admission') } })
      signal.throwIfAborted()
      expect(await remote.get(addedActor.user, added.remoteMcp.created.connectionId)).toEqual(added.remoteMcp.current)
      signal.throwIfAborted()
      expect(await remote.check(addedActor.user, added.remoteMcp.succeeded.checkId)).toEqual(added.remoteMcp.succeeded)
      signal.throwIfAborted()
      expect(await remote.check(addedActor.user, added.remoteMcp.failed.checkId)).toEqual(added.remoteMcp.failed)
      signal.throwIfAborted()
      expect(await remote.getCatalog(addedActor.user, added.remoteMcp.succeeded.catalogId)).toEqual(added.remoteMcp.catalog)
      const proof = resolutions.requests[0]
      if (!proof) throw new Error('Final original resolution missing')
      const originalParams = z.object({ username: z.string(), password: z.string() }).loose()
        .parse(JSON.parse(await readFile(join(provenance.originalRoots[2], '..', 'parameters-private.json'), 'utf8')))
      const originalResolution = z.object({ resources: z.object({ claim: z.string() }).loose() }).loose()
        .parse(JSON.parse(await readFile(join(provenance.originalRoots[2], '..', 'original-resolution-results.json'), 'utf8')))
      signal.throwIfAborted()
      const actor = await identities.login(originalParams.username, originalParams.password)
      actors.push(actor)
      signal.throwIfAborted()
      const approval = await identities.login(originalParams.username, originalParams.password, 'approval')
      actors.push(approval)
      signal.throwIfAborted()
      const filesService = new FileService(target, completed.storage.roots.workspaceRoot); await filesService.init()
      const kube = await KubernetesClient.fromFile('/Users/jingchao/agent_work/main_agent/power-evolve-migration-evidence/private/k3s-migration-kubeconfig.yaml')
      const actualCall = kube.call.bind(kube); let apiCalls = 0
      kube.call = async <T>(...args: Parameters<KubernetesClient['call']>): Promise<T> => { apiCalls += 1; return actualCall<T>(...args) }
      const manager = new SandboxManager(kube, filesService, target, randomUUID(), { namespace: proof.namespace,
        image: evidence.deploymentPin.imageReference, localRoot: completed.storage.roots.workspaceRoot, nodeRoot: '',
        volumeClaimName: originalResolution.resources.claim, readyTimeoutMs: 1000, maxExecutions: 1 })
      const resolution = new CloudExecutionResolutionService(target, manager,
        async () => { throw new Error('Final resolution attempted duplicate continuation') }, resolutions.commandTimeoutMs, 1000, 100)
      signal.throwIfAborted()
      expect(await resolution.status(actor.user, resolutionRequestId.parse(proof.requestId))).toEqual(proof.status)
      signal.throwIfAborted()
      expect((await resolution.inspect(actor.user, resolutionExecutionId.parse(proof.executionId))).canStop).toBe(false)
      signal.throwIfAborted()
      expect(await resolution.resolve(actor.user, proof.request, approval.token)).toEqual(proof.status.receipt)
      signal.throwIfAborted()
      expect(await resolution.poll(new AbortController().signal)).toBe(false)
      expect(apiCalls).toBe(0)
      signal.throwIfAborted()
      expect(await retainedRows()).toEqual(before)
      await privateJson(join(root, 'ordinary-consumers.json'), { version: CURRENT_SCHEMA_VERSION, ownerTables, sourceRowsUnchanged: true,
        originalRowsUnchanged: true, stdioCohorts: evidence.requests.length, resolutionCohorts: resolutions.requests.length,
        packageAndRemoteSelection: true, apiCalls, systemMigrationComplete: false })
    } finally {
      for (const actor of actors) if (!signal.aborted) {
        await owner.drain.attempt('identity logout', 5000, async () => {
          signal.throwIfAborted(); await identities.logout(actor.token)
        })
      }
    }
  } catch (error) { caseFailed = true; caseCause = error }
  finally {
    owner.drain.begin()
    if (owner.profile !== undefined) {
      await owner.drain.attempt('final Profile join', 10000, () => owner.profile!.join())
      owner.profileStopped = owner.profile.stopped()
    }
    await postgres.cleanup(database, role, owner.profileStopped)
    if (!owner.drain.issues.length) owner.confirmCleanup()
  }
  if (owner.drain.issues.length) {
    throw new AggregateError([...(caseFailed ? [caseCause] : []), ...owner.drain.issues.map(issue => issue.error)],
      'Final inventory case or cleanup failed', { cause: caseFailed ? caseCause : owner.drain.issues[0]?.error })
  }
  if (caseFailed) throw caseCause
}

test('current final original nine owner inventory uses one maintenance entry and ordinary consumers', (context) => {
  return ownedFinalInventory(context, verifyFinalOriginalNineInventory)
}, 90000)

async function verifyOriginalFixedStdioConsumer(originalRoot: string, expectedState: 'succeeded' | 'failed' | 'uncertain'): Promise<void> {
  const capture = z.object({ format: z.literal('power-evolve-legacy-offline'), version: z.literal(2),
    source: z.object({ schema: z.literal(37), ddlSha256: z.string(), snapshotId: z.uuid(), codeId: z.string(),
      stoppedAt: z.string(), cut: z.string() }).strict(), snapshot: z.string(), catalogSha256: z.string(), sha256: z.string(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.string().nullable()))) }).strict()
    .parse(JSON.parse(await readFile(join(originalRoot, 'capture.json'), 'utf8')))
  const files = z.array(z.object({ area: z.enum(['workspace', 'home']), owner: z.uuid(), resource: z.uuid(), path: z.literal(''),
    kind: z.literal('directory'), sourcePath: z.null(), bytes: z.null(), sha256: z.null(),
    mode: z.number().int(), uid: z.number().int(), gid: z.number().int() }).strict())
    .parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
  const evidence = legacyMigrationStdioStartedCallEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'stdio-call-original-evidence.json'), 'utf8')))
  const rows = Object.entries(capture.tables).flatMap(([table, values]) => values.map(value => ({ table, sourceTable: table,
    values: value, sourceSha256: legacyRowDigest(table, value) })))
  const row = rows.find(item => item.table === 'pe_stdio_mcp_calls'), proof = evidence.startedRequests[0]
  if (!row || !proof) throw new Error('Original started call inventory missing')
  expect(row.values.state).toBe(expectedState)
  if (expectedState === 'failed') {
    expect(row.values.result).toBeNull()
    expect(row.values.error_code).toBe('mcp_process_failed')
    expect(proof.terminal.status).toMatchObject({ state: 'failed', errorCode: 'mcp_process_failed' })
  } else if (expectedState === 'uncertain') {
    expect(row.values.result).toBeNull()
    expect(row.values.error_code).toBe('dispatch_result_unknown')
    expect(proof.uncertainty?.observation).toEqual({ state: 'uncertain', reason: 'dispatch_result_unknown' })
    expect(proof.terminal.status).toMatchObject({ state: 'succeeded', result: { text: `user:${proof.userId}` } })
  }
  const context = createLegacyMigrationStdioCallContext(evidence, capture.source.codeId, budgets)
  expect(validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut, context)).toBe(true)
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut)).toThrow('migration_stdio_call_original_evidence_missing')
  const mutated = (change: (value: z.infer<typeof legacyMigrationStdioStartedCallEvidence>) => void) => {
    const copy = structuredClone(evidence); change(copy)
    return createLegacyMigrationStdioCallContext(copy, capture.source.codeId, budgets)
  }
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated(value => value.startedRequests.push(proof)))).toThrow('migration_stdio_call_original_inventory')
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated((value) => { value.startedRequests[0]!.dispatch.request.digest = '0'.repeat(64) })))
    .toThrow('migration_stdio_call_original_started_identity')
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated((value) => { value.startedRequests[0]!.terminal.status.instanceId = randomUUID() })))
    .toThrow('migration_stdio_call_original_started_identity')
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated((value) => { value.startedRequests[0]!.podStopped = proof.podReady })))
    .toThrow('migration_stdio_call_original_started_stop')
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated((value) => { value.startedRequests[0]!.handle.podUid = randomUUID() })))
    .toThrow('migration_stdio_call_original_started_identity')
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated((value) => { value.startedRequests[0]!.observations = proof.observations.filter(item => item.kind !== 'services') })))
    .toThrow('migration_stdio_call_original_started_cleanup')
  expect(() => validateLegacyMigrationStdioCall(row, rows.map(item => item.table === 'pe_operations'
    && item.values.source_stdio_mcp_call_id === proof.callId ? { ...item, values: { ...item.values, input: 'changed result' } } : item),
  budgets, capture.source.cut, context)).toThrow('migration_stdio_call_original_continuation')
  expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
    mutated((value) => { value.startedRequests[0]!.probes[0]!.serviceUid = randomUUID() })))
    .toThrow('migration_stdio_call_original_started_timeline')
  if (expectedState === 'uncertain') {
    expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut,
      mutated((value) => { delete value.startedRequests[0]!.uncertainty })))
      .toThrow('migration_stdio_call_original_started_outcome')
  } else if (expectedState === 'failed') {
    expect(() => validateLegacyMigrationStdioCall(row, rows, budgets, capture.source.cut, mutated((value) => {
      const outcome = value.startedRequests[0]!.terminal.status
      if (outcome.state === 'failed') outcome.errorCode = 'mcp_timeout'
    }))).toThrow('migration_stdio_call_original_started_outcome')
  }
  const original = z.object({ ownedFixture: z.literal(true), productionSource: z.literal(false), userId: z.uuid(), sessionId: z.uuid(),
    installInput: z.object({ requestId: z.uuid(), name: z.string() }).strict(), installed: z.unknown(),
    updateInput: z.object({ id: z.uuid(), baseRevision: z.literal(1), enabled: z.literal(false) }).strict(),
    updateRequest: z.uuid(), disabled: z.unknown(), listed: z.object({ items: z.array(z.unknown()) }).loose(),
    status: z.unknown(), calls: z.unknown(), originalRequest: z.uuid(), input: z.string(),
    accepted: z.object({ operationId: z.uuid() }).loose(), continuation: z.object({ operationId: z.uuid() }).loose(),
  }).loose().parse(JSON.parse(await readFile(join(originalRoot, 'original-fixed-stdio-results.json'), 'utf8')))
  const sourceUrl = new URL((await readFile(join(originalRoot, 'readonly-url-private'), 'utf8')).trim())
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 }), suffix = randomUUID().replaceAll('-', '')
  const database = `pe_employee5_v2_target_${suffix}`, role = `pe_employee5_v2_owner_${suffix}`, targetUrl = new URL(adminUrl)
  targetUrl.pathname = `/${database}`; targetUrl.username = role; targetUrl.password = randomUUID()
  const target = new Pool({ connectionString: targetUrl.href, max: 2 }), root = await mkdtemp(join(originalRoot, 'schema5-consumer-'))
  let createdRole = false, createdDatabase = false
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    createdRole = true
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`); createdDatabase = true
    await mkdir(join(root, 'bundle'), { mode: 0o700 })
    await writeFile(join(root, 'source-url'), sourceUrl.href, { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
    const keys = generateKeyPairSync('ed25519'), payload = await readFile(join(originalRoot, 'cut-payload.json'), 'utf8')
    await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-fixed-stdio',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(root, 'cut.json'), { keyId: 'owned-fixed-stdio', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    expect(await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
      phaseTimeoutMs: 30000, mode: 'migrate', outputFile: join(root, 'fixed-stdio-started-output.json'),
      failureEvidenceFile: join(root, 'fixed-stdio-started-failure.json'), evidenceFile: join(root, 'cut.json'),
      trustedEvidenceKeysFile: join(root, 'keys.json'), initializeCurrent: true,
      source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: sourceUrl.pathname.slice(1),
        expectedCatalogSha256: capture.catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 },
      histories: capture.tables.pe_sessions?.map(value => ({ sessionId: value.id, encoding: 'pg-logical' })),
      attachmentSources: [], attachmentSourceRoots: {}, files,
      stdio: { requestEvidenceFile: join(originalRoot, 'fixed-stdio-original-evidence.json') },
      stdioCalls: { evidenceFile: join(originalRoot, 'stdio-call-original-evidence.json') },
      target: { urlFile: join(root, 'target-url'), expectedDatabase: database, statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: files[0]?.uid,
        sourceGid: files[0]?.gid, sourceOwners: files.map(file => ({ uid: file.uid, gid: file.gid })),
        targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'fixed-stdio-started'))
      .toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false, tableCounts: { pe_stdio_mcp_calls: '1' } })
    const ownerTables = ['pe_stdio_mcp_calls', 'pe_stdio_mcp_connections', 'pe_stdio_mcp_updates', 'pe_operations']
    const retained = async () => {
      const inventory: Record<string, Array<Record<string, string | null>>> = {}
      for (const table of ownerTables) {
        const layout = LEGACY_TARGET_LAYOUT[table]
        if (!layout) throw new Error('Original owner layout absent')
        for (const column of Object.keys(LEGACY_SOURCE_LAYOUT[table] ?? {}).filter(key => !(key in layout))) {
          expect(capture.tables[table]?.every(value => value[column] === null)).toBe(true)
        }
        const projection = Object.entries(layout).map(([column, field]) => field.kind === 'timestamptz'
          ? `to_char("${column}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${column}"`
          : `"${column}"::text AS "${column}"`).join(',')
        inventory[table] = (await target.query<Record<string, string | null>>(`SELECT ${projection} FROM "${table}"`)).rows
      }
      return inventory
    }
    const before = await retained()
    for (const table of ownerTables) expect(before[table]?.map(value => legacyRowDigest(table, value)).sort())
      .toEqual(capture.tables[table]?.map(value => legacyRowDigest(table, value)).sort())
    const identities = new IdentityService(target, 60000), actor = await identities.login('employee5-fixed-stdio-started', password)
    const tasks = new TaskStore(target, { ...taskLimits, executionEnabled: true, stdioMcpEnabled: true })
    const service = new StdioMcpService(tasks, null, randomUUID(), 60000)
    try {
      expect(await service.status(actor.user, proof.callId)).toEqual(original.status)
      expect(await service.calls(actor.user)).toEqual(original.calls)
      expect((await service.list(actor.user)).items).toEqual(original.listed.items)
      expect(await service.install(actor.user, original.installInput.requestId, original.installInput.name)).toEqual(original.installed)
      expect(await service.toggle(actor.user, original.updateInput.id, original.updateRequest, 1, false)).toEqual(original.disabled)
      await expect(service.toggle(actor.user, original.updateInput.id, original.updateRequest, 1, true))
        .rejects.toMatchObject({ code: 'request_id_conflict' })
      const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
      expect(await service.calls(foreign)).toEqual({ items: [] })
      await expect(service.status(foreign, proof.callId)).rejects.toMatchObject({ code: 'stdio_mcp_call_not_found' })
      expect(await tasks.accept(actor.user, sessionId.parse(original.sessionId), requestId.parse(original.originalRequest),
        original.input, actor.token)).toMatchObject({ operationId: original.accepted.operationId, state: 'failed' })
      expect(await tasks.claim(randomUUID())).toBeNull()
      expect(before.pe_operations?.find(value => value.id === original.continuation.operationId)?.source_stdio_mcp_call_id)
        .toBe(proof.callId)
      expect(await retained()).toEqual(before)
      await privateJson(join(root, 'ordinary-consumers.json'), { ownedFixture: true, productionMigration: false,
        schemaVersion: CURRENT_SCHEMA_VERSION, exactOriginalRowsRetained: true, originalStatusAndContinuationRead: true,
        currentDisabledConnectionAndExactOldReceiptsRead: true, originalCallNotRedispatched: true,
        physicalPodStop: 'KUBELET_STOPPED', originalOutcome: expectedState,
        independentRunnerOutcomeDoesNotRewriteOriginalUncertainty: expectedState === 'uncertain', systemMigrationComplete: false })
    } finally { await service.close(); await identities.logout(actor.token) }
  } finally {
    await target.end()
    if (createdDatabase) await admin.query(`DROP DATABASE "${database}"`)
    if (createdRole) await admin.query(`DROP ROLE "${role}"`)
    await admin.end()
  }
}

test('current actual original started fixed STDIO success migrates and ordinary consumers preserve closure', async () => {
  const root = process.env.PE_EMPLOYEE5_FIXED_STDIO_STARTED
  if (!root) throw new Error('Actual original success source required')
  await verifyOriginalFixedStdioConsumer(root, 'succeeded')
}, 90000)

for (const outcome of ['failed', 'uncertain'] as const) {
  const root = process.env[outcome === 'failed' ? 'PE_EMPLOYEE5_FIXED_STDIO_FAILED' : 'PE_EMPLOYEE5_FIXED_STDIO_UNCERTAIN']
  test(`current actual original fixed STDIO ${outcome} migrates and ordinary consumers preserve original outcome`, async () => {
    if (!root) throw new Error('Actual original terminal source required')
    await verifyOriginalFixedStdioConsumer(root, outcome)
  }, 90000)
}

for (const outcome of ['cancelled', 'expired'] as const) {
  const originalRoot = process.env[outcome === 'cancelled' ? 'PE_EMPLOYEE5_REMOTE_CHECK_CANCELLED' : 'PE_EMPLOYEE5_REMOTE_CHECK_EXPIRED']
  test(`current actual original remote MCP started check ${outcome} migrates and fences late completion`, async () => {
    if (!originalRoot) throw new Error('Actual original check closure source required')
    const capture = z.object({ format: z.literal('power-evolve-legacy-offline'), version: z.literal(2),
      source: z.object({ schema: z.literal(37), ddlSha256: z.string(), snapshotId: z.uuid(), codeId: z.string(),
        stoppedAt: z.string(), cut: z.string() }).strict(), snapshot: z.string(), catalogSha256: z.string(), sha256: z.string(),
      tables: z.record(z.string(), z.array(z.record(z.string(), z.string().nullable()))) }).strict()
      .parse(JSON.parse(await readFile(join(originalRoot, 'capture.json'), 'utf8')))
    const files = z.array(z.object({ area: z.enum(['workspace', 'home']), owner: z.uuid(), resource: z.uuid(), path: z.literal(''),
      kind: z.literal('directory'), sourcePath: z.null(), bytes: z.null(), sha256: z.null(),
      mode: z.number().int(), uid: z.number().int(), gid: z.number().int() }).strict())
      .parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
    const key = legacyMigrationMcpKey.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-key.json'), 'utf8')))
    const evidence = legacyMigrationMcpEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-evidence.json'), 'utf8')))
    const rows = Object.entries(capture.tables).flatMap(([table, values]) => values.map(value => ({ table, sourceTable: table,
      values: value, sourceSha256: legacyRowDigest(table, value) })))
    const row = rows.find(item => item.table === 'pe_mcp_checks'), proof = evidence.checkClosures?.[0]
    if (!row || !proof) throw new Error('Actual original fenced check inventory absent')
    const context = createLegacyMigrationMcpContext(key, evidence, capture.source.codeId, budgets)
    expect(validateLegacyMigrationRemoteMcp(row, rows, budgets, capture.source.cut, context)).toBe(true)
    expect(row.values).toMatchObject({ state: outcome, lease_epoch: '1', lease_owner: null, lease_until: null,
      catalog_id: null, discovered_tools: null, error_code: outcome === 'expired' ? 'mcp_check_expired' : null })
    const mutated = (change: (value: z.infer<typeof legacyMigrationMcpEvidence>) => void) => {
      const copy = structuredClone(evidence); change(copy)
      return createLegacyMigrationMcpContext(key, copy, capture.source.codeId, budgets)
    }
    const validate = (changed: ReturnType<typeof mutated>) =>
      validateLegacyMigrationRemoteMcp(row, rows, budgets, capture.source.cut, changed)
    expect(() => validate(mutated((value) => { delete value.checkClosures }))).toThrow('migration_mcp_check_worker_closure_missing')
    expect(() => validate(mutated((value) => { value.checkClosures!.push(proof) }))).toThrow('migration_mcp_check_worker_inventory')
    expect(() => validate(mutated((value) => { value.checkClosures![0]!.sourceRowSha256 = '0'.repeat(64) })))
      .toThrow('migration_mcp_check_worker_inventory')
    expect(() => validate(mutated((value) => { value.checkClosures![0]!.snapshot.lease.ownerId = randomUUID() })))
      .toThrow('migration_mcp_check_closure_identity')
    expect(() => validate(mutated((value) => { value.checkClosures![0]!.peer.ready.url = 'http://127.0.0.1:1/' })))
      .toThrow('migration_mcp_check_closure_identity')
    expect(() => validate(mutated((value) => { value.checkClosures![0]!.peer.closure.pid++ })))
      .toThrow('migration_mcp_check_closure_process')
    expect(() => validate(mutated((value) => { value.checkClosures![0]!.peer.http[0]!.instanceId = randomUUID() })))
      .toThrow('migration_mcp_check_closure_process')
    expect(() => validate(mutated((value) => { value.checkClosures![0]!.transition.completed = {} })))
      .toThrow()
    expect(() => validateLegacyMigrationRemoteMcp({ ...row, values: { ...row.values, state: 'succeeded' } },
      rows, budgets, capture.source.cut, context)).toThrow('migration_mcp_check_closure_terminal')
    const original = z.object({ ownedFixture: z.literal(true), productionSource: z.literal(false),
      checkInput: mcpCheckRequest, queued: z.unknown(), checked: z.object({ checkId: mcpCheckId }).loose(),
      terminalCancel: z.unknown(), oldCheckReplay: z.unknown(), create: mcpCreateRequest,
      uploaded: z.object({ item: z.object({ connectionId: mcpConnectionId }).loose() }).loose(),
      toggleInput: mcpToggleRequest, disabled: z.unknown(), current: z.unknown(), listed: z.unknown(),
    }).loose().parse(JSON.parse(await readFile(join(originalRoot, 'original-remote-mcp-check-results.json'), 'utf8')))
    const sourceUrl = new URL((await readFile(join(originalRoot, 'readonly-url-private'), 'utf8')).trim())
    const admin = new Pool({ connectionString: adminUrl.href, max: 1 }), suffix = randomUUID().replaceAll('-', '')
    const database = `pe_employee5_v2_target_${suffix}`, role = `pe_employee5_v2_owner_${suffix}`, targetUrl = new URL(adminUrl)
    targetUrl.pathname = `/${database}`; targetUrl.username = role; targetUrl.password = randomUUID()
    const target = new Pool({ connectionString: targetUrl.href, max: 2 }), root = await mkdtemp(join(originalRoot, 'current-schema-consumer-'))
    let createdRole = false, createdDatabase = false
    try {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
      createdRole = true
      await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`); createdDatabase = true
      await mkdir(join(root, 'bundle'), { mode: 0o700 })
      await writeFile(join(root, 'source-url'), sourceUrl.href, { mode: 0o600, flag: 'wx' })
      await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
      const keys = generateKeyPairSync('ed25519'), payload = await readFile(join(originalRoot, 'cut-payload.json'), 'utf8')
      await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-remote-check-closure',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
      await privateJson(join(root, 'cut.json'), { keyId: 'owned-remote-check-closure', payload,
        signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
      expect(await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
        phaseTimeoutMs: 30000, mode: 'migrate', outputFile: join(root, 'remote-check-closure-output.json'),
        failureEvidenceFile: join(root, 'remote-check-closure-failure.json'), evidenceFile: join(root, 'cut.json'),
        trustedEvidenceKeysFile: join(root, 'keys.json'), initializeCurrent: true,
        source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: sourceUrl.pathname.slice(1),
          expectedCatalogSha256: capture.catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 },
        histories: capture.tables.pe_sessions?.map(value => ({ sessionId: value.id, encoding: 'pg-logical' })),
        attachmentSources: [], attachmentSourceRoots: {}, files,
        mcp: { keyFile: join(originalRoot, 'mcp-key.json'), requestEvidenceFile: join(originalRoot, 'mcp-evidence.json') },
        target: { urlFile: join(root, 'target-url'), expectedDatabase: database, statementTimeoutMs: 5000 },
        storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: files[0]?.uid,
          sourceGid: files[0]?.gid, sourceOwners: files.map(file => ({ uid: file.uid, gid: file.gid })),
          targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'remote-check-closure'))
        .toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false, tableCounts: { pe_mcp_checks: '1', pe_mcp_catalog_versions: '0' } })
      const ownerTables = ['pe_mcp_checks', 'pe_mcp_remote_connections', 'pe_mcp_configuration_versions',
        'pe_mcp_credential_versions', 'pe_mcp_credential_tickets', 'pe_mcp_management_requests', 'pe_mcp_catalog_versions']
      const retained = async () => {
        const inventory: Record<string, Array<Record<string, string | null>>> = {}
        for (const table of ownerTables) {
          const layout = LEGACY_TARGET_LAYOUT[table]
          if (!layout) throw new Error('Original owner layout absent')
          const projection = Object.entries(layout).map(([column, field]) => field.kind === 'timestamptz'
            ? `to_char("${column}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${column}"`
            : `"${column}"::text AS "${column}"`).join(',')
          inventory[table] = (await target.query<Record<string, string | null>>(`SELECT ${projection} FROM "${table}"`)).rows
        }
        return inventory
      }
      const before = await retained()
      for (const table of ownerTables) expect(before[table]?.map(value => legacyRowDigest(table, value)).sort())
        .toEqual(capture.tables[table]?.map(value => legacyRowDigest(table, value)).sort())
      const identities = new IdentityService(target, 60000), actor = await identities.login('employee5-remote-mcp-check-closure', password)
      const remote = new McpConnectionService(target, key.key, { ...remoteMcpLimits,
        assertEndpoint: () => { throw new Error('Historical receipt attempted endpoint admission') } })
      try {
        expect(await remote.check(actor.user, original.checked.checkId)).toEqual(original.checked)
        expect(await remote.cancelCheck(actor.user, original.checked.checkId)).toEqual(original.terminalCancel)
        expect(await remote.startCheck(actor.user, original.checkInput)).toEqual(original.oldCheckReplay)
        expect(await remote.receipt(actor.user, original.create.requestId)).toEqual({ result: original.uploaded })
        expect(await remote.get(actor.user, original.uploaded.item.connectionId)).toEqual(original.current)
        expect(await remote.list(actor.user)).toEqual(original.listed)
        expect(await remote.toggle(actor.user, original.toggleInput)).toEqual(original.disabled)
        const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
        await expect(remote.check(foreign, original.checked.checkId)).rejects.toMatchObject({ code: 'mcp_check_not_found' })
        const originalLease = { ...proof.lease, checkId: mcpCheckId.parse(proof.lease.checkId),
          ownerId: mcpLeaseOwnerId.parse(proof.lease.ownerId) }
        await expect(remote.finishCheck(originalLease, proof.finishAttempt.outcome)).rejects.toMatchObject({ code: 'mcp_check_lease_lost' })
        expect(await remote.claimCheck(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
        expect(await retained()).toEqual(before)
        await privateJson(join(root, 'ordinary-consumers.json'), { ownedFixture: true, productionMigration: false,
          schemaVersion: CURRENT_SCHEMA_VERSION, originalOutcome: outcome, originalSourceRowDigestsRetained: true,
          originalCheckNotReclaimed: true, originalLateResultNotPublished: true, originalPeerAndWorkerStopped: true,
          systemMigrationComplete: false })
      } finally { await identities.logout(actor.token) }
    } finally {
      await target.end()
      if (createdDatabase) await admin.query(`DROP DATABASE "${database}"`)
      if (createdRole) await admin.query(`DROP ROLE "${role}"`)
      await admin.end()
    }
  })
}

for (const branch of ['draft', 'history'] as const) {
  const originalRoot = process.env[branch === 'draft' ? 'PE_EMPLOYEE5_REMOTE_CATALOG_DRAFT' : 'PE_EMPLOYEE5_REMOTE_CATALOG_HISTORY']
  test(`current actual original remote MCP ${branch} catalogs migrate and ordinary consumers retain publication`, async () => {
    if (!originalRoot) throw new Error('Actual original catalog source required')
    await verifyOriginalRemoteMcpCatalogConsumer(originalRoot, branch)
  }, 90000)
}

async function verifyOriginalRemoteMcpCatalogConsumer(originalRoot: string, branch: 'draft' | 'history'): Promise<void> {
  const capture = z.object({ format: z.literal('power-evolve-legacy-offline'), version: z.literal(2),
    source: z.object({ schema: z.literal(37), ddlSha256: z.string(), snapshotId: z.uuid(), codeId: z.string(),
      stoppedAt: z.string(), cut: z.string() }).strict(), snapshot: z.string(), catalogSha256: z.string(), sha256: z.string(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.string().nullable()))) }).strict()
    .parse(JSON.parse(await readFile(join(originalRoot, 'capture.json'), 'utf8')))
  const files = z.array(z.object({ area: z.enum(['workspace', 'home']), owner: z.uuid(), resource: z.uuid(), path: z.literal(''),
    kind: z.literal('directory'), sourcePath: z.null(), bytes: z.null(), sha256: z.null(),
    mode: z.number().int(), uid: z.number().int(), gid: z.number().int() }).strict())
    .parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
  const key = legacyMigrationMcpKey.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-key.json'), 'utf8')))
  const evidence = legacyMigrationMcpEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-evidence.json'), 'utf8')))
  const rows = Object.entries(capture.tables).flatMap(([table, values]) => values.map(value => ({ table, sourceTable: table,
    values: value, sourceSha256: legacyRowDigest(table, value) })))
  const context = createLegacyMigrationMcpContext(key, evidence, capture.source.codeId, budgets)
  const owned = rows.filter(row => row.table.startsWith('pe_mcp_'))
  for (const row of owned) expect(validateLegacyMigrationRemoteMcp(row, rows, budgets, capture.source.cut, context)).toBe(true)
  const closureRow = rows.find(row => row.table === 'pe_mcp_checks' && row.values.state === 'cancelled')
  if (!closureRow) throw new Error('Original started cancellation absent')
  const changed = (edit: (input: z.infer<typeof legacyMigrationMcpEvidence>) => void) => {
    const copy = structuredClone(evidence); edit(copy)
    return createLegacyMigrationMcpContext(key, copy, capture.source.codeId, budgets)
  }
  const validate = (input: ReturnType<typeof changed>) =>
    validateLegacyMigrationRemoteMcp(closureRow, rows, budgets, capture.source.cut, input)
  expect(() => validate(changed((input) => { input.checkClosures!.pop() }))).toThrow('migration_mcp_check_worker_inventory')
  const success = rows.find(row => row.table === 'pe_mcp_checks' && row.values.id === evidence.checkRuns?.[0]?.checkId)
  if (!success) throw new Error('Actual original successful directory absent')
  expect(() => validateLegacyMigrationRemoteMcp(success, rows, budgets, capture.source.cut,
    changed((input) => { input.checkRuns![0]!.outcome = { tools: [] } }))).toThrow('migration_mcp_check_worker_catalog')
  if (branch === 'draft') {
    expect(capture.tables.pe_mcp_drafts).toHaveLength(3)
    const drafts = rows.filter(row => row.table === 'pe_mcp_drafts'), first = drafts[0], second = drafts[1]
    if (!first || !second) throw new Error('Independent encrypted drafts absent')
    expect(() => validateLegacyMigrationRemoteMcp({ ...first, values: { ...first.values,
      credential_sealed: second.values.credential_sealed ?? null } }, rows, budgets, capture.source.cut, context))
      .toThrow('migration_mcp_credential_unavailable')
  } else {
    expect(evidence.catalogRaces).toHaveLength(2)
    expect(() => validate(changed((input) => { delete input.catalogRaces }))).toThrow('migration_mcp_catalog_race_inventory')
    expect(() => validate(changed((input) => { input.catalogRaces!.push(input.catalogRaces![0]!) })))
      .toThrow('migration_mcp_catalog_race_inventory')
    expect(() => validate(changed((input) => { input.catalogRaces![0]!.secondCheckId = randomUUID() })))
      .toThrow('migration_mcp_catalog_race_identity')
    expect(() => validate(changed((input) => { input.catalogRaces![0]!.afterSecond = { ...z.record(z.string(), z.json())
      .parse(input.catalogRaces![0]!.afterSecond), currentCatalogId: randomUUID() } }))).toThrow('migration_mcp_catalog_race_publisher')
    expect(() => validate(changed((input) => { input.catalogRaces![0]!.firstFinishedAt = capture.source.cut })))
      .toThrow('migration_mcp_catalog_race_timeline')
    expect(() => validate(changed((input) => { delete input.checkClosures![0]!.catalogHistory })))
      .toThrow('migration_mcp_check_catalog_history_missing')
    expect(() => validate(changed((input) => { input.checkClosures![0]!.catalogHistory!.after.catalogs.pop() })))
      .toThrow('migration_mcp_check_catalog_history')
    const connection = rows.find(row => row.table === 'pe_mcp_remote_connections')
    const oldCatalog = rows.find(row => row.table === 'pe_mcp_catalog_versions'
      && row.values.id !== connection?.values.current_catalog_id)
    if (!connection || !oldCatalog) throw new Error('Original historical catalog absent')
    expect(() => validateLegacyMigrationRemoteMcp(connection, rows.map(row => row === connection ? { ...row,
      values: { ...row.values, current_catalog_id: oldCatalog.values.id ?? null } } : row), budgets, capture.source.cut, context))
      .toThrow('migration_mcp_catalog_race_publisher')
  }
  const original = z.object({ ownedFixture: z.literal(true), productionSource: z.literal(false), branch: z.enum(['draft', 'history']),
    sessionId: z.uuid(), create: mcpCreateRequest,
    admission: z.object({ maxTools: z.number().int().positive(), maxSnapshotBytes: z.number().int().positive(),
      maxToolBytes: z.number().int().positive(), maxDescriptionBytes: z.number().int().positive() }).strict(),
    uploaded: z.object({ item: z.object({ connectionId: mcpConnectionId }).loose() }).loose(),
    records: z.array(z.object({ kind: z.enum(['draft', 'formal']), input: z.json(), checked: z.object({ checkId: mcpCheckId }).loose(),
      terminalCancel: z.unknown(), replay: z.unknown() }).loose()),
    catalogReads: z.array(z.object({ catalogId: mcpCatalogId }).loose()), current: z.unknown(), listed: z.unknown(),
    admitted: z.array(z.unknown()) }).loose().parse(JSON.parse(await readFile(join(originalRoot, 'original-remote-mcp-catalog-results.json'), 'utf8')))
  const sourceUrl = new URL((await readFile(join(originalRoot, 'readonly-url-private'), 'utf8')).trim())
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 }), suffix = randomUUID().replaceAll('-', '')
  const database = `pe_employee5_v2_target_${suffix}`, role = `pe_employee5_v2_owner_${suffix}`, targetUrl = new URL(adminUrl)
  targetUrl.pathname = `/${database}`; targetUrl.username = role; targetUrl.password = randomUUID()
  const target = new Pool({ connectionString: targetUrl.href, max: 2 }), root = await mkdtemp(join(originalRoot, 'current-catalog-consumer-'))
  let createdRole = false, createdDatabase = false
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    createdRole = true
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`); createdDatabase = true
    await mkdir(join(root, 'bundle'), { mode: 0o700 })
    await writeFile(join(root, 'source-url'), sourceUrl.href, { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
    const keys = generateKeyPairSync('ed25519'), payload = await readFile(join(originalRoot, 'cut-payload.json'), 'utf8')
    await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-remote-catalogs',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(root, 'cut.json'), { keyId: 'owned-remote-catalogs', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    expect(await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
      phaseTimeoutMs: 30000, mode: 'migrate', outputFile: join(root, 'remote-catalogs-output.json'),
      failureEvidenceFile: join(root, 'remote-catalogs-failure.json'), evidenceFile: join(root, 'cut.json'),
      trustedEvidenceKeysFile: join(root, 'keys.json'), initializeCurrent: true,
      source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: sourceUrl.pathname.slice(1),
        expectedCatalogSha256: capture.catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 },
      histories: capture.tables.pe_sessions?.map(value => ({ sessionId: value.id, encoding: 'pg-logical' })),
      attachmentSources: [], attachmentSourceRoots: {}, files,
      mcp: { keyFile: join(originalRoot, 'mcp-key.json'), requestEvidenceFile: join(originalRoot, 'mcp-evidence.json') },
      target: { urlFile: join(root, 'target-url'), expectedDatabase: database, statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: files[0]?.uid,
        sourceGid: files[0]?.gid, sourceOwners: files.map(file => ({ uid: file.uid, gid: file.gid })),
        targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'remote-catalogs'))
      .toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false })
    expect((await target.query<{ version: number }>('SELECT version FROM pe_schema')).rows).toEqual([{ version: CURRENT_SCHEMA_VERSION }])
    const tables = ['pe_mcp_checks', 'pe_mcp_drafts', 'pe_mcp_remote_connections', 'pe_mcp_configuration_versions',
      'pe_mcp_credential_versions', 'pe_mcp_credential_tickets', 'pe_mcp_management_requests', 'pe_mcp_catalog_versions']
    const retained = async () => {
      const inventory: Record<string, Array<Record<string, string | null>>> = {}
      for (const table of tables) {
        const layout = LEGACY_TARGET_LAYOUT[table]
        if (!layout) throw new Error('Original owner layout absent')
        const columns = Object.entries(layout).map(([column, field]) => field.kind === 'timestamptz'
          ? `to_char("${column}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${column}"`
          : `"${column}"::text AS "${column}"`).join(',')
        inventory[table] = (await target.query<Record<string, string | null>>(`SELECT ${columns} FROM "${table}"`)).rows
      }
      return inventory
    }
    const before = await retained()
    for (const table of tables) expect(before[table]?.map(value => legacyRowDigest(table, value)).sort())
      .toEqual(capture.tables[table]?.map(value => legacyRowDigest(table, value)).sort())
    const identities = new IdentityService(target, 60000), actor = await identities.login('employee5-remote-mcp-catalog-branches', password)
    const remote = new McpConnectionService(target, key.key, { ...remoteMcpLimits,
      assertEndpoint: () => { throw new Error('Historical request attempted endpoint admission') } })
    try {
      const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
      for (const record of original.records) {
        expect(await remote.check(actor.user, record.checked.checkId)).toEqual(record.checked)
        expect(await remote.cancelCheck(actor.user, record.checked.checkId)).toEqual(record.terminalCancel)
        expect(record.kind === 'draft' ? await remote.startDraftCheck(actor.user, mcpDraftRequest.parse(record.input))
          : await remote.startCheck(actor.user, mcpCheckRequest.parse(record.input))).toEqual(record.replay)
        await expect(remote.check(foreign, record.checked.checkId)).rejects.toMatchObject({ code: 'mcp_check_not_found' })
      }
      for (const catalog of original.catalogReads) {
        expect(await remote.getCatalog(actor.user, catalog.catalogId)).toEqual(catalog)
        await expect(remote.getCatalog(foreign, catalog.catalogId)).rejects.toMatchObject({ code: 'mcp_catalog_not_found' })
      }
      expect(await remote.receipt(actor.user, original.create.requestId)).toEqual({ result: original.uploaded })
      expect(await remote.get(actor.user, original.uploaded.item.connectionId)).toEqual(original.current)
      expect(await remote.list(actor.user)).toEqual(original.listed)
      expect(await transaction(target, client => remote.admissionCatalogs(client, actor.user))).toEqual(original.admitted)
      for (const proof of evidence.checkClosures ?? []) {
        const lease = { ...proof.lease, checkId: mcpCheckId.parse(proof.checkId), ownerId: mcpLeaseOwnerId.parse(proof.lease.ownerId) }
        await expect(remote.checkSnapshot(lease)).rejects.toMatchObject({ code: 'mcp_check_lease_lost' })
        await expect(remote.finishCheck(lease, proof.finishAttempt.outcome)).rejects.toMatchObject({ code: 'mcp_check_lease_lost' })
      }
      expect(await remote.claimCheck(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
      const tasks = new TaskStore(target, { maxEventBytes: 262144, leaseMs: 60000, maxPendingPerUser: 8,
        maxActivePerUser: 1, executionEnabled: true, remoteMcpAdmission: original.admission })
      const id = requestId.parse(randomUUID()), accepted = await tasks.accept(actor.user, sessionId.parse(original.sessionId),
        id, 'Read the imported current directory', actor.token)
      expect(await tasks.accept(actor.user, sessionId.parse(original.sessionId), id, 'Read the imported current directory', actor.token))
        .toEqual(accepted)
      const selected = (await target.query<{ remote_mcp_selection: unknown }>('SELECT remote_mcp_selection FROM pe_operations')).rows
      expect(selected).toHaveLength(1)
      const frozen = z.array(z.object({ catalogId: z.uuid() }).loose()).parse(selected[0]?.remote_mcp_selection)
      if (branch === 'draft') expect(frozen).toEqual([])
      else expect(frozen.map(item => item.catalogId))
        .toEqual([z.object({ currentCatalogId: z.uuid() }).loose().parse(original.current).currentCatalogId])
      expect(await retained()).toEqual(before)
      await privateJson(join(root, 'ordinary-consumers.json'), { ownedFixture: true, productionMigration: false,
        schemaVersion: CURRENT_SCHEMA_VERSION, originalBranch: branch, originalCheckCount: original.records.length,
        originalCatalogCount: original.catalogReads.length, originalRowDigestsRetained: true,
        originalLateResultNotPublished: true, noOriginalCheckReclaimed: true, originalCurrentDirectoryFrozen: true,
        noRemoteDispatch: true, systemMigrationComplete: false })
    } finally { await identities.logout(actor.token) }
  } finally {
    await target.end()
    if (createdDatabase) await admin.query(`DROP DATABASE "${database}"`)
    if (createdRole) await admin.query(`DROP ROLE "${role}"`)
    await admin.end()
  }
}

async function verifyOriginalRemoteMcpConsumer(originalRoot: string, expectedState: 'succeeded' | 'failed' | 'uncertain'): Promise<void> {
  const capture = z.object({ format: z.literal('power-evolve-legacy-offline'), version: z.literal(2),
    source: z.object({ schema: z.literal(37), ddlSha256: z.string(), snapshotId: z.uuid(), codeId: z.string(),
      stoppedAt: z.string(), cut: z.string() }).strict(), snapshot: z.string(), catalogSha256: z.string(), sha256: z.string(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.string().nullable()))) }).strict()
    .parse(JSON.parse(await readFile(join(originalRoot, 'capture.json'), 'utf8')))
  const files = z.array(z.object({ area: z.enum(['workspace', 'home']), owner: z.uuid(), resource: z.uuid(), path: z.literal(''),
    kind: z.literal('directory'), sourcePath: z.null(), bytes: z.null(), sha256: z.null(),
    mode: z.number().int(), uid: z.number().int(), gid: z.number().int() }).strict())
    .parse(JSON.parse(await readFile(join(originalRoot, 'physical-files.json'), 'utf8')))
  const key = legacyMigrationMcpKey.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-key.json'), 'utf8')))
  const evidence = legacyMigrationMcpEvidence.parse(JSON.parse(await readFile(join(originalRoot, 'mcp-evidence.json'), 'utf8')))
  const rows = Object.entries(capture.tables).flatMap(([table, values]) => values.map(value => ({ table, sourceTable: table,
    values: value, sourceSha256: legacyRowDigest(table, value) })))
  const row = rows.find(item => item.table === 'pe_mcp_actions'), proof = evidence.actionRuns?.[0]
  if (!row || !proof) throw new Error('Actual original action/callback inventory missing')
  const context = createLegacyMigrationMcpContext(key, evidence, capture.source.codeId, budgets)
  expect(validateLegacyMigrationRemoteMcp(row, rows, budgets, capture.source.cut, context)).toBe(true)
  const expectedCode = expectedState === 'failed' ? 'mcp_tool_error' : expectedState === 'uncertain' ? 'mcp_timeout' : null
  expect(row.values).toMatchObject({ state: expectedState, decision: 'once', permission_id: null, lease_epoch: '1',
    lease_owner: null, lease_until: null, error_code: expectedCode, dispatch_id: proof.dispatch.dispatchId })
  const changed = (change: (value: z.infer<typeof legacyMigrationMcpEvidence>) => void) => {
    const copy = structuredClone(evidence); change(copy)
    return createLegacyMigrationMcpContext(key, copy, capture.source.codeId, budgets)
  }
  const validate = (value: ReturnType<typeof changed>) => validateLegacyMigrationRemoteMcp(row, rows, budgets, capture.source.cut, value)
  expect(() => validate(changed((value) => { delete value.actionRuns }))).toThrow('migration_mcp_action_worker_closure_missing')
  expect(() => validate(changed((value) => { value.actionRuns!.push(proof) }))).toThrow('migration_mcp_action_worker_inventory')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.sourceRowSha256 = '0'.repeat(64) })))
    .toThrow('migration_mcp_action_worker_inventory')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.dispatch.dispatchId = randomUUID() })))
    .toThrow('migration_mcp_action_started_identity')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.finish.lease.ownerId = mcpLeaseOwnerId.parse(randomUUID()) })))
    .toThrow('migration_mcp_action_started_identity')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.finish.outcome = { result: { content: [] } } })))
    .toThrow('migration_mcp_action_started_outcome')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.peer.closure.pid++ })))
    .toThrow('migration_mcp_action_started_process_identity')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.peer.closure.closedAt = proof.sourceProcess.startedAt })))
    .toThrow('migration_mcp_action_started_timeline')
  expect(() => validate(changed((value) => { value.actionRuns![0]!.snapshot.serverUrl = 'https://changed.invalid/mcp' })))
    .toThrow('migration_mcp_action_started_identity')
  if ('result' in proof.finish.outcome) {
    expect(() => validate(changed((value) => { value.actionRuns![0]!.limits.maxResultBytes = 1 })))
      .toThrow('migration_mcp_action_started_outcome')
  }
  expect(() => validateLegacyMigrationRemoteMcp(row, rows.map(item => item.table === 'pe_operations'
    && item.values.source_mcp_action_id === proof.actionId ? { ...item, values: { ...item.values, input: '{}' } } : item),
  budgets, capture.source.cut, context)).toThrow('migration_mcp_action_continuation_result')
  if (expectedState === 'uncertain') {
    expect(row.values.result).toBeNull()
    expect(proof.finish.outcome).toEqual({ errorCode: 'mcp_timeout' })
    expect(() => validate(changed((value) => { delete value.actionRuns![0]!.replyWithheld })))
      .toThrow('migration_mcp_action_started_outcome')
    expect(() => validate(changed((value) => { value.actionRuns![0]!.replyWithheld!.instanceId = randomUUID() })))
      .toThrow('migration_mcp_action_started_outcome')
    expect(() => validateLegacyMigrationRemoteMcp({ ...row, values: { ...row.values, state: 'succeeded', error_code: null } },
      rows, budgets, capture.source.cut, context)).toThrow('migration_mcp_action_started_outcome')
  } else if (expectedState === 'failed') {
    expect('result' in proof.finish.outcome && proof.finish.outcome.result.isError).toBe(true)
    expect(() => validateLegacyMigrationRemoteMcp({ ...row, values: { ...row.values, error_code: 'mcp_result_schema_invalid' } },
      rows, budgets, capture.source.cut, context)).toThrow('migration_mcp_action_started_outcome')
  }
  const original = z.object({ ownedFixture: z.literal(true), productionSource: z.literal(false), userId: z.uuid(), sessionId: z.uuid(),
    uploaded: z.object({ item: z.object({ connectionId: mcpConnectionId }).loose() }).loose(),
    checked: z.object({ checkId: mcpCheckId, catalogId: mcpCatalogId }).loose(), catalog: z.unknown(),
    toggleInput: mcpToggleRequest, disabled: z.unknown(), current: z.unknown(), listed: z.unknown(), status: z.unknown(),
    create: mcpCreateRequest, terminalCancel: mcpActionReceipt, originalRequest: z.uuid(), input: z.string(),
    accepted: z.object({ operationId: z.uuid() }).loose(), continuation: z.object({ operationId: z.uuid() }).loose(),
  }).loose().parse(JSON.parse(await readFile(join(originalRoot, 'original-remote-mcp-started-results.json'), 'utf8')))
  const originalApprovalRead = z.object({ readonly: z.literal(true),
    approvals: z.object({ items: z.array(z.unknown()) }).strict() }).strict()
    .parse(JSON.parse(await readFile(join(originalRoot, 'original-terminal-approval-read.json'), 'utf8')))
  const sourceUrl = new URL((await readFile(join(originalRoot, 'readonly-url-private'), 'utf8')).trim())
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 }), suffix = randomUUID().replaceAll('-', '')
  const database = `pe_employee5_v2_target_${suffix}`, role = `pe_employee5_v2_owner_${suffix}`, targetUrl = new URL(adminUrl)
  targetUrl.pathname = `/${database}`; targetUrl.username = role; targetUrl.password = randomUUID()
  const target = new Pool({ connectionString: targetUrl.href, max: 2 }), root = await mkdtemp(join(originalRoot, 'schema5-consumer-'))
  let createdRole = false, createdDatabase = false
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${targetUrl.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`)
    createdRole = true
    await admin.query(`CREATE DATABASE "${database}" OWNER "${role}"`); createdDatabase = true
    await mkdir(join(root, 'bundle'), { mode: 0o700 })
    await writeFile(join(root, 'source-url'), sourceUrl.href, { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'target-url'), targetUrl.href, { mode: 0o600, flag: 'wx' })
    const keys = generateKeyPairSync('ed25519'), payload = await readFile(join(originalRoot, 'cut-payload.json'), 'utf8')
    await privateJson(join(root, 'keys.json'), { version: 1, keys: [{ keyId: 'owned-remote-mcp-started',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
    await privateJson(join(root, 'cut.json'), { keyId: 'owned-remote-mcp-started', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') })
    expect(await launch(root, { format: 'power-evolve-legacy-maintenance', version: 2, migrationId: randomUUID(), limits: budgets,
      phaseTimeoutMs: 30000, mode: 'migrate', outputFile: join(root, 'remote-mcp-started-output.json'),
      failureEvidenceFile: join(root, 'remote-mcp-started-failure.json'), evidenceFile: join(root, 'cut.json'),
      trustedEvidenceKeysFile: join(root, 'keys.json'), initializeCurrent: true,
      source: { purpose: 'offline-readonly-export', urlFile: join(root, 'source-url'), expectedDatabase: sourceUrl.pathname.slice(1),
        expectedCatalogSha256: capture.catalogSha256, identity: capture.source, batchRows: 20, statementTimeoutMs: 5000 },
      histories: capture.tables.pe_sessions?.map(value => ({ sessionId: value.id, encoding: 'pg-logical' })),
      attachmentSources: [], attachmentSourceRoots: {}, files,
      mcp: { keyFile: join(originalRoot, 'mcp-key.json'), requestEvidenceFile: join(originalRoot, 'mcp-evidence.json') },
      target: { urlFile: join(root, 'target-url'), expectedDatabase: database, statementTimeoutMs: 5000 },
      storage: { bundleRoot: join(root, 'bundle'), candidateRoot: join(root, 'candidate'), sourceUid: files[0]?.uid,
        sourceGid: files[0]?.gid, sourceOwners: files.map(file => ({ uid: file.uid, gid: file.gid })),
        targetUid: process.getuid?.(), targetGid: process.getgid?.() } }, 'remote-mcp-started'))
      .toMatchObject({ version: CURRENT_SCHEMA_VERSION, systemMigrationComplete: false, tableCounts: { pe_mcp_actions: '1', pe_operations: '2', pe_mcp_permissions: '0' } })
    const ownerTables = ['pe_mcp_actions', 'pe_mcp_action_chains', 'pe_mcp_permissions', 'pe_mcp_remote_connections',
      'pe_mcp_configuration_versions', 'pe_mcp_credential_versions', 'pe_mcp_catalog_versions', 'pe_mcp_checks',
      'pe_mcp_management_requests', 'pe_operations']
    const retained = async () => {
      const inventory: Record<string, Array<Record<string, string | null>>> = {}
      for (const table of ownerTables) {
        const layout = LEGACY_TARGET_LAYOUT[table]
        if (!layout) throw new Error('Original owner layout absent')
        for (const column of Object.keys(LEGACY_SOURCE_LAYOUT[table] ?? {}).filter(name => !(name in layout))) {
          expect(capture.tables[table]?.every(value => value[column] === null)).toBe(true)
        }
        const projection = Object.entries(layout).map(([column, field]) => field.kind === 'timestamptz'
          ? `to_char("${column}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "${column}"`
          : `"${column}"::text AS "${column}"`).join(',')
        inventory[table] = (await target.query<Record<string, string | null>>(`SELECT ${projection} FROM "${table}"`)).rows
      }
      return inventory
    }
    const before = await retained()
    for (const table of ownerTables) expect(before[table]?.map(value => legacyRowDigest(table, value)).sort())
      .toEqual(capture.tables[table]?.map(value => legacyRowDigest(table, value)).sort())
    const identities = new IdentityService(target, 60000), actor = await identities.login('employee5-remote-mcp-started', password)
    const approval = await identities.login('employee5-remote-mcp-started', password, 'approval')
    const tasks = new TaskStore(target, { ...taskLimits, executionEnabled: true })
    const actions = new McpActionStore(tasks, key.key, { maxArgumentBytes: 65536, maxResultBytes: 65536,
      maxCallsPerChain: 8, maxPendingPerUser: 8, chainLifetimeMs: 15000, approvalLifetimeMs: 15000, leaseMs: 15000, listLimit: 8 })
    const remote = new McpConnectionService(target, key.key, { ...remoteMcpLimits,
      assertEndpoint: () => { throw new Error('Historical receipt attempted endpoint admission') } })
    const actionId = mcpActionId.parse(proof.actionId)
    try {
      expect(await actions.status(actor.user, actionId)).toEqual(original.status)
      expect(await actions.approvals(actor.user)).toEqual(originalApprovalRead.approvals)
      expect(await actions.cancel(actor.user, actionId, { token: actor.token, audience: 'agent' })).toEqual(original.terminalCancel)
      expect(await actions.decide(actor.user, actionId, row.values.request_digest!, 'once', approval.token)).toEqual(original.terminalCancel)
      await expect(actions.decide(actor.user, actionId, row.values.request_digest!, 'persistent', approval.token))
        .rejects.toMatchObject({ code: 'mcp_action_already_decided' })
      const foreign = identity.parse({ ...actor.user, userId: randomUUID() })
      await expect(actions.status(foreign, actionId)).rejects.toMatchObject({ code: 'mcp_action_not_found' })
      expect(await actions.claim(mcpLeaseOwnerId.parse(randomUUID()))).toBeNull()
      expect(await remote.get(actor.user, original.uploaded.item.connectionId)).toEqual(original.current)
      expect(await remote.list(actor.user)).toEqual(original.listed)
      expect(await remote.getCatalog(actor.user, original.checked.catalogId)).toEqual(original.catalog)
      expect(await remote.check(actor.user, original.checked.checkId)).toEqual(original.checked)
      expect(await remote.receipt(actor.user, original.create.requestId)).toEqual({ result: original.uploaded })
      expect(await remote.toggle(actor.user, original.toggleInput)).toEqual(original.disabled)
      await expect(remote.toggle(actor.user, { ...original.toggleInput, enabled: true })).rejects.toMatchObject({ code: 'request_id_conflict' })
      expect(await tasks.accept(actor.user, sessionId.parse(original.sessionId), requestId.parse(original.originalRequest),
        original.input, actor.token)).toMatchObject({ operationId: original.accepted.operationId, state: 'failed' })
      expect(await tasks.claim(randomUUID())).toBeNull()
      expect(before.pe_operations?.filter(value => value.source_mcp_action_id === proof.actionId)).toHaveLength(1)
      expect(before.pe_operations?.find(value => value.id === original.continuation.operationId)?.source_mcp_action_id).toBe(proof.actionId)
      expect(await retained()).toEqual(before)
      await privateJson(join(root, 'ordinary-consumers.json'), { ownedFixture: true, productionMigration: false, schemaVersion: CURRENT_SCHEMA_VERSION,
        originalKnownResultAndUniqueContinuationRead: true, originalOnceDecisionAndNullPermissionRetained: true,
        oldReceiptAndCatalogReadWithCurrentConnectionDisabled: true, exactOriginalOwnerRowsRetained: true,
        actionNotRedispatched: true, originalWorkerAndOwnedPeerProcessClosed: true, originalOutcome: expectedState,
        originalUncertaintyNotRewritten: expectedState === 'uncertain', systemMigrationComplete: false })
    } finally { await identities.logout(actor.token); await identities.logout(approval.token) }
  } finally {
    await target.end()
    if (createdDatabase) await admin.query(`DROP DATABASE "${database}"`)
    if (createdRole) await admin.query(`DROP ROLE "${role}"`)
    await admin.end()
  }
}

test('current actual original remote MCP started action migrates and ordinary consumers preserve original result', async () => {
  const root = process.env.PE_EMPLOYEE5_REMOTE_MCP_STARTED
  if (!root) throw new Error('Actual original remote MCP source required')
  await verifyOriginalRemoteMcpConsumer(root, 'succeeded')
})

for (const outcome of ['failed', 'uncertain'] as const) {
  const root = process.env[outcome === 'failed' ? 'PE_EMPLOYEE5_REMOTE_MCP_FAILED' : 'PE_EMPLOYEE5_REMOTE_MCP_UNCERTAIN']
  test(`current actual original remote MCP ${outcome} migrates and ordinary consumers preserve original outcome`, async () => {
    if (!root) throw new Error('Actual original remote MCP outcome source required')
    await verifyOriginalRemoteMcpConsumer(root, outcome)
  })
}
