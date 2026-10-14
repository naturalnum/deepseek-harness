/** Trusted platform profile: identity, durable tasks/events, and credentialed model egress. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Pool } from 'pg'
import { createRequest, filesListRequest, fileReadRequest, filePutRequest, sessionFilesListRequest, sessionFileReadRequest, sessionFilePutRequest, listRequest, loginRequest, modelsListRequest, pageRequest, promptRequest, sessionId, sessionRequest, settingsUpdateRequest, builtinSkillInstallRequest, skillInstallRequest, skillRequest, skillResourceRequest, skillToggleRequest, skillUploadTicketRequest, sshCreateTicketRequest, sshToggleRequest, sshCheckRequest, sshCallRefRequest, sshExecuteProposeRequest, sshExecuteRefRequest, settings, workspaceCreateRequest, PlatformError } from '../contracts.ts'
import { bearer, readJson, sendFailure, sendJson } from '../http.ts'
import { initializeDatabase, transaction } from './database.ts'
import { hashPassword, IdentityService } from './identity.ts'
import { AccountSettingsService, seedModel, seedNewUser } from './account-settings.ts'
import { loadAccountManagementConfig, loadAccountBootstrapConfig } from './account-config.ts'
import { bootstrapAccount } from './account-bootstrap.ts'
import { AccountService } from './accounts.ts'
import { routeAccount, ACCOUNT_ROUTES } from './account-routes.ts'
import { accountLoginRequest } from '../account-contracts.ts'
import { revokeAccountExecutions } from './account-execution-revocation.ts'
import { TaskStore } from './tasks.ts'
import { NativeSessionWriter } from './native-session-writer.ts'
import { routeNativeWriter } from './native-writer-routes.ts'
import { NativeExecutionFrames } from './native-execution-frames.ts'
import { NativeExecutionAuthority } from './native-execution-authority.ts'
import { NativeInputLedger } from './native-input-ledger.ts'
import { NativeInputCommit } from './native-input-commit.ts'
import { NativePreparedCancel } from './native-prepared-cancel.ts'
import { NativeArchiveInputCancel } from './native-archive-input.ts'
import { NativeInputOwnerRouting } from './native-input-owner-routing.ts'
import { NativeTurnContinuationV2 } from './native-turn-continuation-v2.ts'
import { NativeTurnAdvanceIntentV2 } from './native-turn-advance-intent-v2.ts'
import { loadNativeInputOwnerRoutingConfig } from '../native-input-owner-routing-config.ts'
import { nativeInputFrameRequest, nativeInputPendingRequest, nativeInputPendingResponse } from '../native-input-commit-contracts.ts'
import { nativeExecutionFrame } from '../native-execution-frame-contracts.ts'
import { nativeInputQueueCommand } from '../native-input-ledger-contracts.ts'
import { nativeConsumedInputRecovery } from '../native-consumed-input-recovery-contracts.ts'
import { EventStore } from './events.ts'
import { NativeSessionRead, nativeFollowRequest, nativePageRequest } from './native-session-read.ts'
import { NativeAssistantStore } from './native-assistant-store.ts'
import { NativeRetainedIntentStore } from './native-retained-intent-store.ts'
import { NativeRetainedIntentCipher } from './native-retained-intent-cipher.ts'
import { NATIVE_RETAINED_ROUTES } from '../native-retained-intent-contracts.ts'
import { NativeAssistantRead, nativeAssistantPosition } from './native-assistant-read.ts'
import { pruneNativeAssistant, releaseNativeAssistant } from './native-assistant-lifecycle.ts'
import { NativeWorkspaceRead } from './native-workspace-read.ts'
import { nativeDirectoryList, nativeDirectoryCreate, nativeWorkspaceCreate, nativeWorkspaceRename,
  nativeWorkspaceDelete, nativeWorkspaceOrder, nativeSessionOrder, nativeSessionArchive, nativeSessionGrouping } from '../native-workspace-contracts.ts'
import { requestId } from '../contracts.ts'
import { NativeSessionCommands } from './native-session-commands.ts'
import { nativeSessionRename, nativeSessionFork, nativeSessionSearch } from '../native-session-contracts.ts'
import { NativePreferences, nativePreferenceNamespace, nativePreferenceWrite, nativeModelSelect } from './native-preferences.ts'
import { NativeFileRead, nativeFileRequest, nativeFileTextRequest, nativeFileBytesRequest } from './native-files.ts'
import { FileService } from './files.ts'
import { NativeAttachments } from './native-attachments.ts'
import { LegacyMigrationImageReader } from './legacy-migration-v2-image-reader.ts'
import { NativeImageReader } from './native-images.ts'
import { readNativeImageResponse, readNativeBrowserImageResponse } from './native-image-route.ts'
import { DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES, DEFAULT_MAX_IMAGE_DIMENSION, DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION, DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_COMPRESSION_CONCURRENCY, MAX_IMAGE_COMPRESSION_CONCURRENCY } from '@deepseek-ai/dsh-attachment-local'
import { nativeFileAttachment, NATIVE_FILE_MAX_BYTES } from '../native-attachment-contracts.ts'
import { FileDownloadService } from './file-downloads.ts'
import { loadOfficePreviewConfig } from './office-preview-config.ts'
import { OfficePreviewService } from './office-previews.ts'
import { OFFICE_PREVIEW_ROUTES, officePreviewSourcePrepareRequest, officePreviewRefRequest,
  officePreviewCancelRequest } from '@power-evolve/contracts/office-preview'
import { FILE_DOWNLOAD_MAX_FILES, FILE_DOWNLOAD_MAX_SOURCE_BYTES, FILE_DOWNLOAD_PLATFORM_PATH,
  fileDownloadPrepareRequest } from '@power-evolve/contracts/file-download'
import { fileDownloadDisposition, parseFileDownloadQuery, writeFileDownload } from '../file-download-http.ts'
import { SkillService } from './skills.ts'
import { readRuntimeSkill, readRuntimeSkillResource } from './runtime-skills.ts'
import { ConnectorService } from './connectors.ts'
import { PluginService } from './plugins.ts'
import { PersonalMcpService } from './mcp.ts'
import { McpConnectionService } from './mcp-connections.ts'
import { McpActionStore } from './mcp-actions.ts'
import { loadMcpPlatformConfig, assertMcpPlatformEndpoint } from './mcp-platform-config.ts'
import { routeMcpManagement, routeMcpApproval } from './mcp-routes.ts'
import { mcpActionId, mcpActionRequest } from '../mcp-action-contracts.ts'
import { mcpLeaseOwnerId } from '../mcp-contracts.ts'
import { McpCheckWorker } from './mcp-check-worker.ts'
import { McpActionWorker } from './mcp-action-worker.ts'
import { StdioMcpService } from './stdio-mcp.ts'
import { StdioRunnerOrchestrator } from './stdio-runner.ts'
import { loadStdioPlatformConfigV2 } from './stdio-v2-platform-config.ts'
import { StdioOperationAdmissionV2 } from './stdio-v2-operation-admission.ts'
import { createStdioCloudServicesV2, STDIO_PRODUCT_RESERVED_NAMES_V2 } from './stdio-v2-services.ts'
import { stdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioActionRequestV2, stdioApprovalRequestV2, stdioCheckRequestV2,
  stdioReceiptRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { SshConnectionService } from './ssh.ts'
import { sshManagementRequests } from '../ssh-management-contracts.ts'
import { SshCallStore } from './ssh-calls.ts'
import { SshAuthenticationCheck } from './ssh-check.ts'
import { SshExecuteService } from './ssh-execute.ts'
import { SshRunnerOrchestrator, type SshRunnerConfig } from './ssh-runner.ts'
import { ExecutionService } from './executions.ts'
import { cloudShellProposeRequest, cloudShellExecutionRequest, cloudShellCancelRequest } from '../cloud-shell-contracts.ts'
import { routeExecutionResolutionRead, routeExecutionResolutionApproval } from './execution-resolution-routes.ts'
import { LoginAdmission } from './login-admission.ts'
import { KubernetesClient } from './kubernetes.ts'
import { SandboxManager } from './sandbox.ts'
import { proxyModel } from './model.ts'
import { nativeToolRegistration, registerNativeToolNames } from './native-tool-catalog.ts'
import { NativeRuntimeAuthority } from './native-runtime-authority.ts'
import { routeNativeRuntime } from './native-runtime-routes.ts'
import { proxyNativeWebSearch } from './native-web-search.ts'
import { NativeInteractive, nativeInteractiveOpen } from './native-interactive.ts'
import { cleanupNativeRuntime, nativeRuntimeCleanupRequest } from './native-runtime-cleanup.ts'
import { NativeSubagents } from './native-subagents.ts'
import { nativePresetSelection, selectNativePreset } from './native-preset-selection.ts'
import { serveUi } from '../ui.ts'
import { serveTrustedAccountUi } from '../trusted-account-ui.ts'

const accountUiDirectory = fileURLToPath(new URL('../../../client-account/lib/trusted/', import.meta.url))

export const name = 'power-evolve-platform'
export const inject = ['webServer']

/** Platform settings contain file references; profile dumps do not contain secret values. */
export const Config = schema.object({
  databaseUrlFile: schema.string().required(), workerTokenFile: schema.string().required(),
  nativeIntentKeyFile: schema.string().required(),
  nativeIntentMaxRequestBytes: schema.number().step(1).min(1).default(8_388_608),
  nativeIntentMaxPendingPerSession: schema.number().step(1).min(1).default(64),
  nativeIntentMaxRecordsPerSession: schema.number().step(1).min(1).default(65536),
  nativeIntentMaxRetainedBytesPerSession: schema.number().step(1).min(1).default(268_435_456),
  workspaceRoot: schema.string().required(),
  attachmentRoot: schema.string().required(),
  legacyImageMaxBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_BYTES),
  legacyImageMaxPixels: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_PIXELS),
  legacyImageMaxLedgerBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8_388_608),
  legacyImageReadTimeoutMs: schema.number().step(1).min(1).max(2_147_483_647).default(15_000),
  nativeUploadMaxFilesPerSession: schema.number().step(1).min(1).max(256).default(64),
  nativeUploadMaxFilesPerUser: schema.number().step(1).min(1).max(100000).default(4096),
  nativeUploadMaxBytesPerUser: schema.number().step(1).min(1).default(268435456),
  nativeImageMaxBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_BYTES),
  nativeImageMaxImagesPerMessage: schema.number().step(1).min(1).max(32).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
  nativeImageMaxMessageBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
  nativeImageMaxPixels: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_PIXELS),
  nativeImageMaxDimension: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_IMAGE_DIMENSION),
  nativeImageNormalizedMaxPixels: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS),
  nativeImageNormalizedMaxDimension: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
  nativeImageNormalizedMaxBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
  nativeImageCompressionConcurrency: schema.number().step(1).min(1).max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
    .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
  nativeImageMaxLedgerBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8_388_608),
  nativeUploadTimeoutMs: schema.number().step(1).min(1000).default(60000),
  nativeAssistantMaxOpeningBytes: schema.number().step(1).min(512).default(8_388_608),
  nativeAssistantMaxBaselineChunks: schema.number().step(1).min(1).default(8192),
  nativeAssistantMaxPacketItems: schema.number().step(1).min(1).default(256),
  nativeAssistantMaxPacketBytes: schema.number().step(1).min(512).default(2_097_152),
  nativeAssistantMaxCanonicalReadBytes: schema.number().step(1).min(1).default(8_388_608),
  fileDownloadMaxFiles: schema.number().step(1).min(1).max(FILE_DOWNLOAD_MAX_FILES).default(1),
  fileDownloadMaxTotalBytes: schema.number().step(1).min(1).max(FILE_DOWNLOAD_MAX_SOURCE_BYTES).default(32 * 1024 * 1024),
  fileDownloadMaxConcurrentTransfers: schema.number().step(1).min(1).default(4),
  fileDownloadMaxUserConcurrentTransfers: schema.number().step(1).min(1).default(2),
  fileDownloadTransferTimeoutMs: schema.number().step(1).min(1).default(60_000),
  modelKeyFile: schema.string().required(), connectorKeyFile: schema.string().required(), seedUsersFile: schema.string().default(''),
  accountManagementFile: schema.string().default(''), accountBootstrapFile: schema.string().default(''),
  modelUrl: schema.string().required(), hostOrigin: schema.string().required(), platformOrigin: schema.string().required(),
  mcpUrl: schema.string().default(''), mcpTokenFile: schema.string().default(''),
  remoteMcpConfigFile: schema.string().default(''),
  stdioV2ConfigFile: schema.string().default(''),
  officePreviewConfigFile: schema.string().default(''), officePreviewKubeconfigFile: schema.string().default(''),
  mcpTimeoutMs: schema.number().min(1000).default(5000),
  sshCredentialKeyFile: schema.string().default(''), sshDestinationAllowlist: schema.string().default(''),
  sshMaxConnections: schema.number().step(1).min(1).max(8).default(8),
  sshMaxPendingTickets: schema.number().step(1).min(1).default(8),
  sshTicketLifetimeMs: schema.number().step(1).min(1000).default(300000),
  sshMaxCompletedMismatches: schema.number().step(1).min(1).default(3),
  sshRunnerKubeconfigFile: schema.string().default(''), sshRunnerNamespace: schema.string().default(''),
  sshRunnerImage: schema.string().default(''), sshRunnerRuntimeClass: schema.string().default('gvisor'),
  sshRunnerImagePullSecretName: schema.string().default(''),
  sshRunnerIngressCidrs: schema.string().default(''),
  sshRunnerReadyTimeoutMs: schema.number().min(1000).default(30000),
  sshRunnerLeaseMs: schema.number().min(1000).default(90000),
  sshRunnerPollMs: schema.number().step(1).min(100).default(500),
  connectorUrl: schema.string().required(), connectorTimeoutMs: schema.number().min(1000).required(),
  connectorPollMs: schema.number().min(100).required(),
  sandboxKubeconfigFile: schema.string().default(''), sandboxKeyFile: schema.string().default(''),
  sandboxNamespace: schema.string().default(''), sandboxImage: schema.string().default(''),
  sandboxLocalRoot: schema.string().default(''), sandboxNodeRoot: schema.string().default(''),
  sandboxVolumeClaimName: schema.string().default(''),
  sandboxReadyTimeoutMs: schema.number().min(1000).default(60000),
  sandboxConcurrency: schema.number().step(1).min(1).default(4),
  sandboxPollMs: schema.number().min(100).default(500), sandboxIdleMs: schema.number().min(1000).default(300000),
  sandboxCommandTimeoutMs: schema.number().step(1).min(1000).max(300000).default(60000),
  sandboxMaxExecutions: schema.number().step(1).min(1).max(65536).default(4096),
  nativeWriterLeaseMs: schema.number().step(1).min(1000).max(300000).default(30000),
  nativeInputOwnerRoutingFile: schema.string().default(''),
  nativeInputMaxCohortInputs: schema.number().step(1).min(1).max(2147483647).default(128),
  nativeInputMaxAcceptedAuditBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2097152),
  nativeInputMaxRevisionBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(262144),
  nativeInputMaxCommandBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4194304),
  nativeInputMaxFrameBytes: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2097152),
  leaseMs: schema.number().min(1000).required(), tokenLifetimeMs: schema.number().min(1000).required(),
  maxPendingPerUser: schema.number().step(1).min(1).required(), maxActivePerUser: schema.number().step(1).min(1).required(),
  maxWorkspacesPerUser: schema.number().step(1).min(1).default(16),
  maxDirectoriesPerUser: schema.number().step(1).min(1).default(256),
  nativeTitleMaxBytes: schema.number().step(1).min(1).default(4096),
  nativeSearchResultLimit: schema.number().step(1).min(1).max(20).default(20),
  nativeSearchSnippetChars: schema.number().step(1).min(1).max(8192).default(240),
  nativeSearchDeadlineMs: schema.number().step(1).min(1).max(2_147_483_647).default(5000),
  nativeSearchMaxSessions: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256),
  nativeSearchMaxEvents: schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(100_000),
  nativeSearchMaxBytes: schema.number().step(1).min(1024).max(Number.MAX_SAFE_INTEGER).default(67_108_864),
  nativeAssistantMaxBatchItems: schema.number().step(1).min(1).default(32),
  nativeAssistantMaxBatchBytes: schema.number().step(1).min(1).default(1_048_576),
  nativeAssistantMaxItemBytes: schema.number().step(1).min(1).default(1_048_576),
  nativeAssistantMaxActiveBytes: schema.number().step(1).min(1).default(4_194_304),
  nativeAssistantMaxRingItems: schema.number().step(1).min(1).default(1024),
  nativeAssistantMaxRingBytes: schema.number().step(1).min(1).default(4_194_304),
  nativeAssistantTtlMs: schema.number().step(1).min(1).default(20_000),
  maxSkillsPerUser: schema.number().step(1).min(1).max(256).default(64),
  skillLibraryRoot: schema.string().default(''),
  preinstalledSkills: schema.array(schema.string()).default([]),
  enabledBuiltinSkills: schema.array(schema.string()).default(['builtin.pdf']),
  maxHistoryBytes: schema.number().step(1).min(1024).required(), maxHistoryEvents: schema.number().step(1).min(1).required(),
  maxEventBytes: schema.number().step(1).min(1024).required(), maxRequestBytes: schema.number().step(1).min(1024).required(),
  nativeWebSearchUrl: schema.string().default('https://api.deepseek.com/anthropic/v1/messages'),
  nativeWebSearchMaxUses: schema.number().step(1).min(1).default(5),
  nativeSubagentMaxChildren: schema.number().step(1).min(1).default(32),
  nativeSubagentMaxDepth: schema.number().step(1).min(1).default(8),
  nativeInteractiveLifetimeMs: schema.number().step(1).min(1000).default(900000),
  nativeInteractiveMaxActivePerUser: schema.number().step(1).min(1).default(4),
  nativeSubagentLifetimeMs: schema.number().step(1).min(1000).default(600000),
  modelTimeoutMs: schema.number().min(1000).required(), maxModelResponseBytes: schema.number().min(1024).required(),
  readyFile: schema.string().required(), databasePoolSize: schema.number().step(1).min(1).required(),
  databaseTimeoutMs: schema.number().min(100).required(), loginWindowMs: schema.number().step(1).min(1000).required(),
  loginAttemptsPerWindow: schema.number().step(1).min(1).required(),
  loginTrackedAccounts: schema.number().step(1).min(1).required(),
  loginGlobalAttemptsPerWindow: schema.number().step(1).min(1).required(),
})
/** Validated Platform profile configuration; private resources are referenced by file path. */
export type Config = ReturnType<typeof Config>

const seedUsers = z.array(z.object({
  username: z.string().min(1).max(80), password: z.string().min(16).max(256), settings,
  models: z.array(seedModel).min(1).max(16).optional(),
}).strict()).max(100)

/** Enforce upload origin and methods; return true only after completing the preflight response. */
function uploadPreflight(req: IncomingMessage, res: ServerResponse, hostOrigin: string): boolean {
  if (req.headers.origin !== hostOrigin) throw new PlatformError(403, 'invalid_origin')
  res.setHeader('access-control-allow-origin', hostOrigin)
  res.setHeader('vary', 'Origin')
  res.setHeader('cache-control', 'no-store')
  if (req.method === 'OPTIONS') {
    if (req.headers['access-control-request-method'] !== 'POST') throw new PlatformError(405, 'method_not_allowed')
    res.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '300' })
    res.end()
    return true
  }
  if (req.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
  return false
}

/** Register the platform only after its schema and configured users are ready. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const instanceId = randomUUID()
  await NativeAttachments.validateRoot(config.attachmentRoot, [config.workspaceRoot,
    ...(config.sandboxLocalRoot ? [resolve(config.sandboxLocalRoot)] : []),
    ...(config.skillLibraryRoot ? [resolve(config.skillLibraryRoot)] : [])])
  const remoteMcpConfig = await loadMcpPlatformConfig(config.remoteMcpConfigFile)
  const stdioV2Config = await loadStdioPlatformConfigV2(config.stdioV2ConfigFile)
  if (stdioV2Config && (!config.sandboxKubeconfigFile || !config.sandboxVolumeClaimName
    || config.sandboxNodeRoot || config.sandboxImage !== stdioV2Config.settings.cloudDeployment.imageReference
    || config.maxRequestBytes < stdioV2Config.settings.limits.maxInputBytes)) {
    throw new Error('STDIO v2 requires its reviewed Sandbox image, PVC and complete request budget')
  }
  const officePreviewConfig = await loadOfficePreviewConfig(config.officePreviewConfigFile, config.officePreviewKubeconfigFile,
    [config.workspaceRoot, config.attachmentRoot,
      ...(config.sandboxLocalRoot ? [join(resolve(config.sandboxLocalRoot), 'homes')] : []),
      ...(config.skillLibraryRoot || config.sandboxLocalRoot
        ? [join(resolve(config.skillLibraryRoot || config.sandboxLocalRoot), 'skill-packages')] : [])])
  if (config.accountBootstrapFile && !config.accountManagementFile) throw new Error('Account bootstrap requires management configuration')
  const [accountManagement, accountBootstrap] = await Promise.all([
    config.accountManagementFile ? loadAccountManagementConfig(config.accountManagementFile) : Promise.resolve(null),
    loadAccountBootstrapConfig(config.accountBootstrapFile),
  ])
  const [databaseUrl, workerToken, modelKey, connectorKey, seeds, mcpToken, sshKey, nativeIntentKey] = await Promise.all([
    readFile(config.databaseUrlFile, 'utf8'), readFile(config.workerTokenFile, 'utf8'),
    readFile(config.modelKeyFile, 'utf8'), readFile(config.connectorKeyFile, 'utf8'),
    config.seedUsersFile ? readFile(config.seedUsersFile, 'utf8') : Promise.resolve('[]'),
    config.mcpTokenFile ? readFile(config.mcpTokenFile, 'utf8') : Promise.resolve(''),
    config.sshCredentialKeyFile ? readFile(config.sshCredentialKeyFile, 'utf8') : Promise.resolve(''),
    readFile(config.nativeIntentKeyFile, 'utf8'),
  ])
  // Reject a malformed private journal key before schema or account writes.
  new NativeRetainedIntentCipher(nativeIntentKey.trim())
  const pool = new Pool({ connectionString: databaseUrl.trim(), max: config.databasePoolSize,
    connectionTimeoutMillis: config.databaseTimeoutMs, query_timeout: config.databaseTimeoutMs,
    statement_timeout: config.databaseTimeoutMs })
  // Keep readiness independent of busy task workers and bound outage probes to one second.
  const healthPool = new Pool({ connectionString: databaseUrl.trim(), max: 1,
    connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 })
  let databaseReady = true
  const databaseAvailability = { get ready() { return databaseReady } }
  const databaseUnavailable = (error: unknown) => {
    if (!databaseReady) return
    databaseReady = false
    ctx.logger.error('Platform PostgreSQL connection lost (%s)',
      error instanceof Error ? error.message : 'unknown error')
  }
  pool.on('error', databaseUnavailable)
  healthPool.on('error', databaseUnavailable)
  const mcpShutdown = new Set<() => Promise<void>>()
  // Cordis disposers run concurrently; trusted worker writes must settle before this pool enters ending.
  ctx.effect(() => async () => {
    await Promise.allSettled([...mcpShutdown].map(stop => stop()))
    await pool.end()
  })
  ctx.effect(() => () => healthPool.end())
  await initializeDatabase(pool)
  const loginAdmission = new LoginAdmission(pool, config)
  await loginAdmission.initialize()
  const executionEnabled = config.sandboxKubeconfigFile.length > 0
  if (executionEnabled && (!config.sandboxKeyFile || !config.sandboxNamespace || !config.sandboxImage
    || !config.sandboxLocalRoot || Boolean(config.sandboxNodeRoot) === Boolean(config.sandboxVolumeClaimName))) {
    throw new Error('Incomplete Agent Sandbox configuration')
  }
  if (executionEnabled && resolve(config.workspaceRoot) !== join(resolve(config.sandboxLocalRoot), 'workspaces')) {
    throw new Error('Workspace and Sandbox roots differ')
  }
  const files = new FileService(pool, config.workspaceRoot, executionEnabled ? { uid: 1000, gid: 1000 } : undefined)
  const fileDownloads = new FileDownloadService(pool, files, {
    maxFiles: config.fileDownloadMaxFiles, maxTotalBytes: config.fileDownloadMaxTotalBytes,
    maxConcurrentTransfers: config.fileDownloadMaxConcurrentTransfers,
    maxUserConcurrentTransfers: config.fileDownloadMaxUserConcurrentTransfers,
    transferTimeoutMs: config.fileDownloadTransferTimeoutMs,
  })
  await files.init()
  const officePreviews = officePreviewConfig ? new OfficePreviewService(pool, files,
    await KubernetesClient.fromFile(config.officePreviewKubeconfigFile), officePreviewConfig) : null
  if (officePreviews && officePreviewConfig !== null) {
    const stop = new AbortController()
    const stopped = (): boolean => stop.signal.aborted
    const polling = (async () => {
      let unavailable = false
      const availability = { get unavailable() { return unavailable } }
      while (!stopped()) {
        try {
          await officePreviews.tick()
          if (availability.unavailable) ctx.logger.info('Office preview reconciliation resumed')
          unavailable = false
        } catch (_unavailable) {
          if (!stopped() && !availability.unavailable) ctx.logger.warn('Office preview reconciliation unavailable')
          unavailable = true
        }
        if (stopped()) return
        try { await delay(officePreviewConfig.pollMs, undefined, { signal: stop.signal }) }
        catch (error) { if (stopped()) return; throw error }
      }
    })()
    const close = async () => { stop.abort(); await Promise.allSettled([officePreviews.stop(), polling]) }
    mcpShutdown.add(close)
    ctx.effect(() => close)
  }
  const skillLibraryRoot = config.skillLibraryRoot || config.sandboxLocalRoot
  if (executionEnabled && resolve(skillLibraryRoot) !== resolve(config.sandboxLocalRoot)) {
    throw new Error('Skill library and Sandbox roots differ')
  }
  if (config.preinstalledSkills.length && !skillLibraryRoot) throw new Error('Missing Skill library root')
  const skills = new SkillService(pool, config.workspaceRoot, skillLibraryRoot, config.maxSkillsPerUser,
    config.enabledBuiltinSkills)
  await skills.init()
  const users = seedUsers.parse(JSON.parse(seeds))
  if (accountManagement && accountBootstrap?.mode === 'create') await bootstrapAccount(pool, accountBootstrap, accountManagement)
  for (const user of users) {
    await seedNewUser(pool, user.username, await hashPassword(user.password), user.settings, user.models)
  }
  if (accountManagement && accountBootstrap?.mode === 'existing') await bootstrapAccount(pool, accountBootstrap, accountManagement)
  const identities = new IdentityService(pool, config.tokenLifetimeMs)
  const accounts = accountManagement ? new AccountService(pool, identities, {
    platformOrigin: config.platformOrigin, workspaceRoot: config.workspaceRoot,
    management: accountManagement, revokeExecutions: revokeAccountExecutions,
  }) : null
  const accountSettings = new AccountSettingsService(pool)
  const stdioV2Selection = stdioV2Config ? new StdioOperationAdmissionV2(files, stdioV2Config.settings) : null
  const tasks: TaskStore = new TaskStore(pool, { ...config, executionEnabled, mcpEnabled: !!config.mcpUrl,
    archiveStopHistory: { maxHistoryEvents: config.maxHistoryEvents, maxHistoryBytes: config.maxHistoryBytes },
    nativeImageAdmission: { storage: { root: config.attachmentRoot,
      maxFilesPerSession: config.nativeUploadMaxFilesPerSession, maxFilesPerUser: config.nativeUploadMaxFilesPerUser,
      maxBytesPerUser: config.nativeUploadMaxBytesPerUser }, maxLedgerBytes: config.nativeImageMaxLedgerBytes,
    sdk: { maxImageBytes: config.nativeImageMaxBytes, maxImagesPerMessage: config.nativeImageMaxImagesPerMessage,
      maxMessageImageBytes: config.nativeImageMaxMessageBytes, maxImagePixels: config.nativeImageMaxPixels,
      maxImageDimension: config.nativeImageMaxDimension, normalizedImageMaxPixels: config.nativeImageNormalizedMaxPixels,
      normalizedImageMaxDimension: config.nativeImageNormalizedMaxDimension,
      normalizedImageMaxBytes: config.nativeImageNormalizedMaxBytes,
      imageCompressionConcurrency: config.nativeImageCompressionConcurrency } },
    ...(stdioV2Selection ? { stdioV2Admission: {
      selection: stdioV2Selection, reservedNames: STDIO_PRODUCT_RESERVED_NAMES_V2,
    } } : {}),
    ...(remoteMcpConfig ? { remoteMcpAdmission: remoteMcpConfig.settings.admission } : {}),
    stdioMcpEnabled: !!config.sshRunnerKubeconfigFile,
    sshEnabled: !!config.sshRunnerKubeconfigFile && !!config.sshCredentialKeyFile },
  (client, session, token): Promise<void> => nativeExecution.assertExecutionInTransaction(client, session, token),
  (client, sessionId, fallback) => nativeFrames.selectClaimInTransaction(client, sessionId, fallback))
  const nativeWriter = new NativeSessionWriter(tasks, { leaseMs: config.nativeWriterLeaseMs })
  const nativeInputLimits = { maxCohortInputs: config.nativeInputMaxCohortInputs,
    maxAcceptedAuditBytes: config.nativeInputMaxAcceptedAuditBytes, maxRevisionBytes: config.nativeInputMaxRevisionBytes,
    maxCommandBytes: config.nativeInputMaxCommandBytes, maxEventBytes: config.maxEventBytes,
    maxHistoryEvents: config.maxHistoryEvents, maxHistoryBytes: config.maxHistoryBytes }
  const nativeFrames: NativeExecutionFrames = new NativeExecutionFrames(tasks, nativeWriter, {
    maxFrameBytes: config.nativeInputMaxFrameBytes,
    maxCohortInputs: nativeInputLimits.maxCohortInputs,
    maxHistoryEvents: config.maxHistoryEvents, maxHistoryBytes: config.maxHistoryBytes })
  const nativeExecution: NativeExecutionAuthority = new NativeExecutionAuthority(
    (client, session, token) => nativeFrames.readExecutionInTransaction(client, session, token),
    { maxHistoryEvents: config.maxHistoryEvents, maxHistoryBytes: config.maxHistoryBytes,
      maxCohortInputs: nativeInputLimits.maxCohortInputs, maxFactBytes: config.nativeInputMaxFrameBytes })
  const mcp = new PersonalMcpService(tasks, config.mcpUrl, mcpToken.trim(), config.mcpTimeoutMs)
  const attachments = new NativeAttachments(pool, tasks, files, { root: config.attachmentRoot,
    maxFilesPerSession: config.nativeUploadMaxFilesPerSession, maxFilesPerUser: config.nativeUploadMaxFilesPerUser,
    maxBytesPerUser: config.nativeUploadMaxBytesPerUser })
  await attachments.init()
  const legacyImages = new LegacyMigrationImageReader(pool, tasks, { root: config.attachmentRoot,
    maxImageBytes: config.legacyImageMaxBytes, maxImagePixels: config.legacyImageMaxPixels,
    maxLedgerBytes: config.legacyImageMaxLedgerBytes })
  const nativeImages = new NativeImageReader(pool, tasks, { root: config.attachmentRoot,
    maxImageBytes: Math.max(config.legacyImageMaxBytes, config.nativeImageMaxBytes),
    maxImagePixels: Math.max(config.legacyImageMaxPixels, config.nativeImageMaxPixels),
    maxLedgerBytes: config.nativeImageMaxLedgerBytes }, legacyImages,
  { maxHistoryEvents: config.maxHistoryEvents, maxHistoryBytes: config.maxHistoryBytes })
  const remoteMcp = remoteMcpConfig ? new McpConnectionService(pool, remoteMcpConfig.credentialKey, {
    ...remoteMcpConfig.settings.management, assertEndpoint: endpoint => assertMcpPlatformEndpoint(remoteMcpConfig, endpoint),
  }) : null
  const remoteMcpActions = remoteMcpConfig
    ? new McpActionStore(tasks, remoteMcpConfig.credentialKey, remoteMcpConfig.settings.actions) : null
  if (remoteMcpConfig && remoteMcp && remoteMcpActions) {
    const { settings: remoteSettings, networkPolicy } = remoteMcpConfig
    const options = { ownerId: mcpLeaseOwnerId.parse(instanceId), pollMs: remoteSettings.pollMs,
      renewMs: remoteSettings.renewMs, budgets: remoteSettings.transport, networkPolicy }
    const checkWorker = new McpCheckWorker(remoteMcp, { ...options, toolLimits: remoteSettings.admission })
    const actionWorker = new McpActionWorker(remoteMcpActions, { ...options,
      snapshot: preparation => transaction(pool, client => remoteMcp.runtimeSnapshot(client, preparation.owner, {
        connectionId: preparation.tool.connectionId, revision: preparation.tool.connectionRevision,
        configurationRevision: preparation.tool.configurationRevision,
        credentialRevision: preparation.tool.credentialRevision, catalogId: preparation.tool.catalogId,
      })),
    })
    const jobs: [string, (signal: AbortSignal) => Promise<void>, number][] = [
      ['discovery', signal => checkWorker.run(signal), remoteSettings.pollMs],
      ['action', signal => actionWorker.run(signal), remoteSettings.pollMs],
      ['cleanup', async () => { await remoteMcp.prunePendingChecks(remoteSettings.cleanupBatchSize) }, remoteSettings.cleanupMs],
    ]
    for (const [label, work, intervalMs] of jobs) {
      ctx.effect(() => {
        const controller = new AbortController()
        const stopped = (): boolean => controller.signal.aborted
        const run = (async () => {
          while (!stopped()) {
            try { await work(controller.signal) }
            catch { ctx.logger.warn('Remote MCP %s worker restarting after uncertain persistence', label) }
            if (stopped()) return
            try { await delay(intervalMs, undefined, { signal: controller.signal }) }
            catch (error) { if (stopped()) return; throw error }
          }
        })()
        const stop = async () => { controller.abort(); await run }
        mcpShutdown.add(stop)
        return stop
      })
    }
  }
  const ssh = new SshConnectionService(pool, sshKey, config.sshDestinationAllowlist, {
    maxConnections: config.sshMaxConnections, maxPendingTickets: config.sshMaxPendingTickets,
    ticketLifetimeMs: config.sshTicketLifetimeMs, maxCompletedMismatches: config.sshMaxCompletedMismatches,
  })
  const sshRunnerEnabled = config.sshRunnerKubeconfigFile.length > 0
  if (config.sshRunnerImagePullSecretName && (!sshRunnerEnabled
    || !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(config.sshRunnerImagePullSecretName))) {
    throw new Error('Invalid Connector Runner image pull Secret reference')
  }
  if (sshRunnerEnabled && (!config.sshRunnerNamespace || !config.sshRunnerImage
    || !config.sshRunnerRuntimeClass || !config.sshRunnerIngressCidrs)) {
    throw new Error('Incomplete Connector Runner configuration')
  }
  let stdioRunner: StdioRunnerOrchestrator | null = null
  const sshServices = sshRunnerEnabled ? await (async () => {
    const kube = await KubernetesClient.fromFile(config.sshRunnerKubeconfigFile)
    const namespace = config.sshRunnerNamespace, serviceName = 'power-evolve-forbidden-listener'
    const servicePath = kube.resourcePath(namespace, 'services', serviceName)
    type ListenerService = { metadata?: { name?: string }
      spec?: { clusterIP?: string
        selector?: Record<string, string>
        ports?: Array<{ port?: number }> } }
    const service = await kube.call<ListenerService>('GET', servicePath)
    const probeIp = service.spec?.clusterIP
    if (service.metadata?.name !== serviceName || !probeIp || !isIP(probeIp)
      || service.spec?.selector?.['app.kubernetes.io/name'] !== serviceName
      || service.spec.ports?.[0]?.port !== 8080) throw new Error('SSH forbidden listener identity invalid')
    const proveForbiddenListener = async () => {
      try {
        const current = await kube.call<ListenerService>('GET', servicePath)
        if (current.spec?.clusterIP !== probeIp || current.spec.ports?.[0]?.port !== 8080) return false
        const health = await kube.call<{ healthy?: boolean }>('GET',
          kube.proxyPath(namespace, serviceName, '/health'), undefined, 3000)
        return health.healthy === true
      } catch (_unavailable) { return false }
    }
    if (!await proveForbiddenListener()) throw new Error('SSH forbidden listener unavailable')
    const runnerConfig = (): SshRunnerConfig => ({
      namespace, image: config.sshRunnerImage, runtimeClassName: config.sshRunnerRuntimeClass,
      ...(config.sshRunnerImagePullSecretName ? { imagePullSecretName: config.sshRunnerImagePullSecretName } : {}),
      controlKey: connectorKey.trim(), readyTimeoutMs: config.sshRunnerReadyTimeoutMs,
      platformIngressCidrs: config.sshRunnerIngressCidrs.split(',').map(value => value.trim()),
      forbiddenProbe: { ip: probeIp, port: 8080 }, proveForbiddenListener,
    })
    const runner = new SshRunnerOrchestrator(kube, runnerConfig())
    stdioRunner = new StdioRunnerOrchestrator(kube, runnerConfig())
    if (!ssh.available) return null
    return { execute: new SshExecuteService(tasks, new SshCallStore(pool), ssh, runner,
      sshKey, instanceId, config.sshRunnerLeaseMs, config.sshRunnerPollMs),
    check: new SshAuthenticationCheck(new SshCallStore(pool), ssh, runner,
      { ownerId: instanceId, requestKey: connectorKey.trim(), leaseMs: config.sshRunnerLeaseMs,
        pollMs: config.sshRunnerPollMs }) }
  })() : null
  const sshCheck = sshServices?.check ?? null
  const sshExecute = sshServices?.execute ?? null
  if (sshCheck) {
    const stop = new AbortController()
    const polling = (async () => {
      let nextCleanup = 0
      while (!stop.signal.aborted) {
        try { if (await sshCheck.pump()) continue }
        catch (_error) { /* Persisted state is reconciled on a later claim. */ }
        if (Date.now() >= nextCleanup) {
          nextCleanup = Date.now() + 10_000
          try { await sshCheck.cleanupPending() }
          catch (_unavailable) { /* Retry cleanup after DB recovery. */ }
        }
        try { await delay(config.sshRunnerPollMs, undefined, { signal: stop.signal }) }
        catch (_aborted) { /* Stop the loop on shutdown. */ }
      }
    })()
    ctx.effect(() => async () => { stop.abort(); await polling })
  }
  const sshAvailable = ssh.available && sshCheck !== null
  sshExecute?.start()
  ctx.effect(() => () => sshExecute?.close())
  const stdioMcp = new StdioMcpService(tasks, stdioRunner, instanceId, config.sshRunnerLeaseMs)
  stdioMcp.start()
  ctx.effect(() => () => stdioMcp.close())
  const events = new EventStore(tasks, config)
  const nativeAssistantLimits = {
    maxBatchItems: config.nativeAssistantMaxBatchItems, maxBatchBytes: config.nativeAssistantMaxBatchBytes,
    maxItemBytes: config.nativeAssistantMaxItemBytes, maxActiveBytes: config.nativeAssistantMaxActiveBytes,
    maxRingItems: config.nativeAssistantMaxRingItems, maxRingBytes: config.nativeAssistantMaxRingBytes,
    ttlMs: config.nativeAssistantTtlMs, maxEventBytes: config.maxEventBytes,
  }
  const nativeAssistant = new NativeAssistantStore(tasks, events, nativeAssistantLimits)
  const frameVerifier = (client: Parameters<NativeExecutionFrames['verifyInTransaction']>[0],
    request: Parameters<NativeExecutionFrames['verifyInTransaction']>[1]) => nativeFrames.verifyInTransaction(client, request)
  const nativeLedger = new NativeInputLedger(tasks, nativeWriter, events, nativeInputLimits, frameVerifier)
  const nativeInput = new NativeInputCommit(tasks, nativeLedger, nativeFrames, nativeAssistant, nativeWriter,
    { input: nativeInputLimits, presentation: nativeAssistantLimits })
  const nativePreparedCancel = new NativePreparedCancel(tasks, nativeLedger, nativeFrames, nativeAssistant, nativeWriter,
    { input: nativeInputLimits, presentation: nativeAssistantLimits })
  const nativeArchiveInputCancel = new NativeArchiveInputCancel(tasks, nativeLedger, nativeFrames, nativeAssistant, nativeWriter,
    { input: nativeInputLimits, presentation: nativeAssistantLimits })
  const nativeContinuation = new NativeTurnContinuationV2(tasks, nativeWriter, frameVerifier,
    { ...nativeInputLimits, leaseMs: config.leaseMs, maxActivePerUser: config.maxActivePerUser, assistant: nativeAssistantLimits },
    nativeFrames)
  const nativeAdvance = new NativeTurnAdvanceIntentV2(tasks, nativeWriter, frameVerifier,
    { maxAcceptedAuditBytes: nativeInputLimits.maxAcceptedAuditBytes, maxRevisionBytes: nativeInputLimits.maxRevisionBytes,
      maxCohortInputs: nativeInputLimits.maxCohortInputs, maxHistoryEvents: config.maxHistoryEvents,
      maxHistoryBytes: config.maxHistoryBytes, maxCommandBytes: nativeInputLimits.maxCommandBytes,
      assistant: nativeAssistantLimits }, nativeFrames)
  const nativeIntents = new NativeRetainedIntentStore(tasks, nativeWriter, {
    publication: nativeAssistant, input: nativeInput, preparedCancel: nativePreparedCancel,
    archiveCancel: nativeArchiveInputCancel, turn: nativeContinuation,
  }, nativeIntentKey.trim(), {
    maxRequestBytes: config.nativeIntentMaxRequestBytes, maxPendingPerSession: config.nativeIntentMaxPendingPerSession,
    maxRecordsPerSession: config.nativeIntentMaxRecordsPerSession,
    maxRetainedBytesPerSession: config.nativeIntentMaxRetainedBytesPerSession,
  })
  const nativeQueueRouting = config.nativeInputOwnerRoutingFile ? new NativeInputOwnerRouting(pool,
    await loadNativeInputOwnerRoutingConfig(config.nativeInputOwnerRoutingFile),
    (credential, command) => transaction(pool, client => nativeLedger.lookupQueueReceiptInTransaction(client, credential, command))) : null
  const runtimeAuthority = new NativeRuntimeAuthority(pool)
  const nativeInteractive = new NativeInteractive(tasks, runtimeAuthority, { lifetimeMs: config.nativeInteractiveLifetimeMs,
    maxActivePerUser: config.nativeInteractiveMaxActivePerUser, leaseMs: config.leaseMs })
  const nativeSubagents = new NativeSubagents(tasks, { maxChildren: config.nativeSubagentMaxChildren, maxDepth: config.nativeSubagentMaxDepth,
    lifetimeMs: config.nativeSubagentLifetimeMs, leaseMs: config.leaseMs })
  const nativeAssistantReader = new NativeAssistantRead(nativeAssistantLimits, {
    maxOpeningBytes: config.nativeAssistantMaxOpeningBytes, maxBaselineChunks: config.nativeAssistantMaxBaselineChunks,
    maxPacketItems: config.nativeAssistantMaxPacketItems, maxPacketBytes: config.nativeAssistantMaxPacketBytes,
    maxCanonicalBytes: config.nativeAssistantMaxCanonicalReadBytes,
  })
  ctx.effect(() => {
    const stop = new AbortController()
    const stopped = (): boolean => stop.signal.aborted
    const pruning = (async () => {
      while (!stopped()) {
        try { await pruneNativeAssistant(tasks) }
        catch (error) { ctx.logger.warn('Native presentation cleanup failed (%s)', error instanceof Error ? error.name : 'unknown') }
        try { await delay(1000, undefined, { signal: stop.signal }) }
        catch (error) { if (!stopped()) throw error }
      }
    })()
    return async () => { stop.abort(); await pruning }
  })
  const nativeSessions = new NativeSessionRead(pool, { maxImageBytes: config.nativeImageMaxBytes,
    maxImagesPerMessage: config.nativeImageMaxImagesPerMessage, maxMessageImageBytes: config.nativeImageMaxMessageBytes,
    maxImagePixels: config.nativeImageMaxPixels, maxImageDimension: config.nativeImageMaxDimension,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] })
  const nativeSessionCommands = new NativeSessionCommands(pool, { ...config, titleMaxBytes: config.nativeTitleMaxBytes,
    searchResultLimit: config.nativeSearchResultLimit, searchSnippetChars: config.nativeSearchSnippetChars,
    searchDeadlineMs: config.nativeSearchDeadlineMs, searchMaxSessions: config.nativeSearchMaxSessions,
    searchMaxEvents: config.nativeSearchMaxEvents, searchMaxBytes: config.nativeSearchMaxBytes })
  const nativePreferences = new NativePreferences(pool, config)
  const nativeWorkspaces = new NativeWorkspaceRead(pool, files, config.maxWorkspacesPerUser, config.maxDirectoriesPerUser)
  const nativeFiles = new NativeFileRead(pool, files)
  const connectors = new ConnectorService(tasks, config.connectorUrl,
    connectorKey.trim(), config.connectorTimeoutMs, config.connectorPollMs)
  const plugins = new PluginService(pool)
  await plugins.seedUsers(users.map(user => user.username))
  await connectors.seedPermissions(users.map(user => user.username))
  connectors.start()
  ctx.effect(() => () => connectors.close())
  const sandboxManager = executionEnabled ? new SandboxManager(
    await KubernetesClient.fromFile(config.sandboxKubeconfigFile), files, pool,
    (await readFile(config.sandboxKeyFile, 'utf8')).trim(), {
      namespace: config.sandboxNamespace, image: config.sandboxImage,
      localRoot: config.sandboxLocalRoot, nodeRoot: config.sandboxNodeRoot,
      ...(config.sandboxVolumeClaimName ? { volumeClaimName: config.sandboxVolumeClaimName } : {}),
      ...(stdioV2Config ? { stdioV2: { limits: stdioV2Config.settings.limits,
        maxReplyBytes: stdioV2Config.settings.maxReplyBytes } } : {}),
      readyTimeoutMs: config.sandboxReadyTimeoutMs,
      maxExecutions: config.sandboxMaxExecutions,
    }) : null
  const stdioV2 = sandboxManager && stdioV2Config && stdioV2Selection
    ? createStdioCloudServicesV2(pool, tasks, stdioV2Selection, files, sandboxManager,
      stdioV2Config, stdioWorkerIdV2.parse(instanceId)) : null
  let stdioWorkerReady = true
  if (stdioV2) {
    const stop = new AbortController()
    const polling = stdioV2.worker.run(stop.signal).catch((_workerStopped: unknown) => {
      if (!stop.signal.aborted) {
        stdioWorkerReady = false
        ctx.logger.error('STDIO v2 worker stopped unexpectedly')
      }
    })
    const close = async () => { stop.abort(); await stdioV2.worker.stop(); await polling }
    mcpShutdown.add(close)
    ctx.effect(() => close)
  }
  const executions = sandboxManager ? new ExecutionService(tasks, sandboxManager,
    config.sandboxConcurrency, config.sandboxPollMs, config.sandboxIdleMs, config.sandboxCommandTimeoutMs) : null
  if (executions) { executions.start(); ctx.effect(() => () => executions.close()) }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', config.platformOrigin)
    const path = url.pathname
    if (req.method === 'GET' && path === '/live') {
      sendJson(res, { live: true, service: 'platform', instanceId })
      return
    }
    if (req.method === 'GET' && path === '/health') {
      try {
        const versions = await healthPool.query<{ version: number }>('SELECT version FROM pe_schema')
        if (versions.rows.length !== 1) throw new Error('PowerEvolve schema version is unavailable')
        if (!databaseAvailability.ready) ctx.logger.info('Platform PostgreSQL connection recovered')
        databaseReady = true
        const version = versions.rows[0]
        if (!version) throw new Error('PowerEvolve schema version is unavailable')
        sendJson(res, { ready: stdioWorkerReady, service: 'platform', schema: version.version, executionEnabled,
          mcpAvailable: !!config.mcpUrl, remoteMcpAvailable: remoteMcp !== null,
          stdioMcpAvailable: stdioMcp.available, stdioV2Available: stdioV2 !== null && stdioWorkerReady,
          sshAvailable, officePreviewAvailable: officePreviews !== null, instanceId }, stdioWorkerReady ? 200 : 503)
      } catch (error) {
        databaseUnavailable(error)
        sendJson(res, { ready: false, service: 'platform', schema: null, database: 'unavailable',
          executionEnabled, mcpAvailable: !!config.mcpUrl, remoteMcpAvailable: remoteMcp !== null,
          stdioMcpAvailable: stdioMcp.available,
          stdioV2Available: false,
          sshAvailable, officePreviewAvailable: officePreviews !== null, instanceId }, 503)
      }
      return
    }
    if (req.method === 'GET' && path === '/config') { sendJson(res, { hostUrl: config.hostOrigin }); return }
    if (req.method === 'GET' && await serveTrustedAccountUi(path, res, accountUiDirectory)) return
    if (req.method === 'GET' && await serveUi(path, 'login', res, config.hostOrigin)) return
    if (req.method === 'GET' && path === FILE_DOWNLOAD_PLATFORM_PATH) {
      const token = bearer(req)
      const user = await identities.authenticate(token)
      const request = parseFileDownloadQuery(url)
      const abort = new AbortController()
      res.once('close', () => { abort.abort() })
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.fileDownloadTransferTimeoutMs)])
      const authorize = async (): Promise<void> => { await identities.authenticate(token) }
      try {
        const result = await fileDownloads.open(user, request, signal, authorize)
        res.writeHead(200, { 'content-type': result.view.contentType,
          'content-disposition': fileDownloadDisposition(result.view.fileName),
          'content-length': String(result.view.totalBytes), 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff' })
        await writeFileDownload(result.body, res, result.view.totalBytes, signal, authorize)
      } catch (error) {
        if (!(error instanceof PlatformError) && signal.aborted && signal.reason instanceof DOMException
          && signal.reason.name === 'TimeoutError') throw new PlatformError(504, 'download_timeout')
        throw error
      }
      return
    }
    if (path === '/skills/upload') {
      if (uploadPreflight(req, res, config.hostOrigin)) return
      if (req.headers['content-type'] !== 'application/zip') throw new PlatformError(415, 'invalid_content_type')
      const uploaded = await skills.upload(bearer(req), req)
      sendJson(res, uploaded.item, uploaded.created ? 201 : 200)
      return
    }
    if (path === '/ssh/upload' || path === '/mcp/connections/upload') {
      if (uploadPreflight(req, res, config.hostOrigin)) return
      if (req.headers['content-type'] !== 'application/octet-stream') throw new PlatformError(415, 'invalid_content_type')
      if (path === '/mcp/connections/upload') {
        if (!remoteMcp) throw new PlatformError(503, 'mcp_unavailable')
        sendJson(res, await remoteMcp.upload(bearer(req), req), 201)
      } else sendJson(res, await ssh.upload(bearer(req), req), 201)
      return
    }
    if (path === '/native/attachments/upload') {
      if (req.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
        throw new PlatformError(415, 'invalid_content_type')
      }
      const token = bearer(req), user = await identities.authenticate(token)
      const id = sessionId.parse(url.searchParams.get('sessionId'))
      const name = z.string().max(4096).optional().parse(url.searchParams.get('name') ?? undefined)
      const abort = new AbortController()
      const disconnected = () => { if (!res.writableEnded) abort.abort() }
      res.on('close', disconnected)
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.nativeUploadTimeoutMs)])
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of req) {
          if (!Buffer.isBuffer(chunk)) throw new PlatformError(400, 'invalid_upload_chunk')
          yield chunk
        }
      }
      try { sendJson(res, await attachments.upload(user, token, id, chunks(), name, signal)) }
      finally {
        res.off('close', disconnected)
        if (!req.complete) req.destroy()
      }
      return
    }
    if (req.method !== 'POST') throw new PlatformError(404, 'not_found')
    if (path === '/runtime/web-search/messages') {
      await proxyNativeWebSearch(tasks, { maxUses: config.nativeWebSearchMaxUses, url: config.nativeWebSearchUrl, apiKey: modelKey.trim(), timeoutMs: config.modelTimeoutMs,
        maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxModelResponseBytes }, req, res); return
    }
    if (path === '/model/v1/messages') {
      await proxyModel(tasks, {
        url: config.modelUrl, apiKey: modelKey.trim(), timeoutMs: config.modelTimeoutMs,
        maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxModelResponseBytes,
        ...(stdioV2Selection ? { stdioV2Admission: {
          selection: stdioV2Selection, reservedNames: STDIO_PRODUCT_RESERVED_NAMES_V2,
        } } : {}),
      }, req, res)
      return
    }
    if (path === '/identity/login' || path === '/identity/approval-login') {
      if (req.headers.origin !== undefined && req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      await loginAdmission.chargeGlobal()
      const input = loginRequest.parse(await readJson(req, 4096))
      await loginAdmission.chargeAccount(input.username)
      sendJson(res, await identities.login(input.username, input.password, path === '/identity/approval-login' ? 'approval' : 'agent'))
      return
    }
    if (path.startsWith('/account/')) {
      if (req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      if (!accounts) throw new PlatformError(503, 'account_unavailable')
      if (path === ACCOUNT_ROUTES.login) {
        await loginAdmission.chargeGlobal()
        const input = accountLoginRequest.parse(await readJson(req, 4096))
        await loginAdmission.chargeAccount(input.username)
        sendJson(res, await routeAccount(accounts, path, undefined, input, req.headers.origin))
      } else {
        const token = bearer(req)
        const input = await readJson(req, config.maxRequestBytes)
        sendJson(res, await routeAccount(accounts, path, token, input, req.headers.origin))
      }
      return
    }
    const token = bearer(req)
    if (path.startsWith('/office-preview/')) {
      if (!officePreviews) throw new PlatformError(503, 'office_render_unavailable')
      const input = await readJson(req, 4096)
      switch (path) {
        case OFFICE_PREVIEW_ROUTES.generation:
          z.object({}).strict().parse(input); sendJson(res, await officePreviews.generation(token)); return
        case OFFICE_PREVIEW_ROUTES.prepare:
          sendJson(res, await officePreviews.prepare(token, officePreviewSourcePrepareRequest.parse(input))); return
        case OFFICE_PREVIEW_ROUTES.status:
          sendJson(res, await officePreviews.status(token, officePreviewRefRequest.parse(input))); return
        case OFFICE_PREVIEW_ROUTES.content:
          sendJson(res, await officePreviews.content(token, officePreviewRefRequest.parse(input))); return
        case OFFICE_PREVIEW_ROUTES.cancel:
          sendJson(res, await officePreviews.cancel(token, officePreviewCancelRequest.parse(input))); return
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path.startsWith('/approvals/')) {
      if (req.headers.origin !== undefined && req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      const user = await identities.authenticate(token, 'approval')
      const input = await readJson(req, 4096)
      if (path.startsWith('/approvals/executions/')) {
        sendJson(res, await routeExecutionResolutionApproval(executions, path, user, input, token,
          req.headers.origin, config.platformOrigin)); return
      }
      if (path.startsWith('/approvals/mcp/')) {
        sendJson(res, await routeMcpApproval(remoteMcpActions, path, user, input, token)); return
      }
      if (path.startsWith('/approvals/stdio-v2/')) {
        if (!stdioV2) throw new PlatformError(503, 'stdio_v2_unavailable')
        switch (path) {
          case '/approvals/stdio-v2/list': sendJson(res, await stdioV2.actions.approvalList(token, listRequest.parse(input))); return
          case '/approvals/stdio-v2/inspect': sendJson(res, await stdioV2.authorization.inspect(token, stdioActionRequestV2.parse(input).actionId)); return
          case '/approvals/stdio-v2/decide': sendJson(res, await stdioV2.authorization.decide(token, stdioApprovalRequestV2.parse(input))); return
          default: throw new PlatformError(404, 'not_found')
        }
      }
      switch (path) {
        case '/approvals/me': z.object({}).strict().parse(input); sendJson(res, user); return
        case '/approvals/list': z.object({}).strict().parse(input); sendJson(res, await connectors.list(user)); return
        case '/approvals/permissions': z.object({}).strict().parse(input); sendJson(res, await connectors.permissions(user)); return
        case '/approvals/permission': {
          const value = z.object({ capability: z.enum(['trial_note_query', 'trial_note_append']), enabled: z.boolean() }).strict().parse(input)
          sendJson(res, await connectors.setPermission(user, value.capability, value.enabled)); return
        }
        case '/approvals/decide': {
          const value = z.object({ actionId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            approve: z.boolean() }).strict().parse(input)
          sendJson(res, await connectors.decide(user, value.actionId, value.fingerprint, value.approve, token)); return
        }
        case '/approvals/ssh-execute/list': {
          z.object({}).strict().parse(input)
          sendJson(res, sshExecute ? await sshExecute.approvals(user) : { items: [] }); return
        }
        case '/approvals/ssh-execute/decide': {
          if (!sshExecute) throw new PlatformError(503, 'ssh_unavailable')
          const value = z.object({ actionId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
            approve: z.boolean() }).strict().parse(input)
          sendJson(res, await sshExecute.decide(user, value.actionId, value.fingerprint, value.approve, token)); return
        }
        case '/approvals/ssh-execute/cancel': {
          if (!sshExecute) throw new PlatformError(503, 'ssh_unavailable')
          sendJson(res, await sshExecute.cancel(user, sshExecuteRefRequest.parse(input).actionId, { token, audience: 'approval' })); return
        }
        case '/approvals/logout': z.object({}).strict().parse(input); await identities.logout(token); sendJson(res, { ok: true }); return
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path === '/runtime/user/interactive/open') {
      sendJson(res, await nativeInteractive.open(token, nativeInteractiveOpen.parse(await readJson(req, config.maxRequestBytes)))); return
    }
    if (path === '/runtime/cleanup') {
      sendJson(res, await cleanupNativeRuntime(pool, token, nativeRuntimeCleanupRequest.parse(await readJson(req, config.maxRequestBytes)), config)); return
    }
    if (path.startsWith('/runtime/user/')) {
      sendJson(res, await routeNativeRuntime(runtimeAuthority, tasks, nativeIntents, path, token, await readJson(req, 4096), { limits: config, maxSessions: config.nativeIntentReconcileLimit })); return
    }
    if (path === '/runtime/claim' || path === '/runtime/claim-archive-stop'
      || path === NATIVE_RETAINED_ROUTES.reconcile || path === NATIVE_RETAINED_ROUTES.resolve) {
      const expected = Buffer.from(workerToken.trim())
      const supplied = Buffer.from(token)
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new PlatformError(401, 'unauthorized_worker')
      if (path === NATIVE_RETAINED_ROUTES.reconcile || path === NATIVE_RETAINED_ROUTES.resolve) {
        const input = await readJson(req, 4096)
        sendJson(res, path === NATIVE_RETAINED_ROUTES.reconcile
          ? await nativeIntents.reconcile(input) : await nativeIntents.resolve(input))
        return
      }
      const input = z.object({ workerId: z.uuid() }).strict().parse(await readJson(req, 4096))
      const claimed = path === '/runtime/claim' ? await tasks.claim(input.workerId) : await tasks.claimArchiveStop(input.workerId)
      sendJson(res, claimed); return
    }
    if (path === '/stdio-v2/config') {
      await identities.authenticate(token)
      z.object({}).strict().parse(await readJson(req, 4096))
      sendJson(res, stdioV2 && stdioV2Config && stdioWorkerReady
        ? { formatVersion: 2, available: true, limits: stdioV2Config.settings.limits,
          management: stdioV2Config.settings.management, maxReplyBytes: stdioV2Config.settings.maxReplyBytes }
        : { formatVersion: 2, available: false })
      return
    }
    if (path.startsWith('/stdio-v2/')) {
      if (!stdioV2 || !stdioV2Config) throw new PlatformError(503, 'stdio_v2_unavailable')
      const input = await readJson(req, stdioV2Config.settings.limits.maxInputBytes)
      const { requests, connections, discovery } = stdioV2
      switch (path) {
        case '/stdio-v2/actions/list': {
          const value = listRequest.extend({ sessionId: sessionId.optional() }).parse(input)
          sendJson(res, await stdioV2.actions.list(token, { offset: value.offset, limit: value.limit,
            ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }) })); return
        }
        case '/stdio-v2/actions/detail': sendJson(res, await stdioV2.actions.detail(token, stdioActionRequestV2.parse(input))); return
        case '/stdio-v2/actions/cancel': sendJson(res, await stdioV2.actions.cancel(token, stdioActionRequestV2.parse(input))); return
        case '/stdio-v2/connections/list': sendJson(res, await connections.list(token, requests.listRequest.parse(input))); return
        case '/stdio-v2/connections/create': sendJson(res, await connections.create(token, requests.create.parse(input))); return
        case '/stdio-v2/connections/update': sendJson(res, await connections.update(token, requests.update.parse(input))); return
        case '/stdio-v2/connections/toggle': sendJson(res, await connections.toggle(token, requests.toggle.parse(input))); return
        case '/stdio-v2/connections/delete': sendJson(res, await connections.remove(token, requests.remove.parse(input))); return
        case '/stdio-v2/connections/receipt': sendJson(res, await connections.receipt(token, stdioReceiptRequestV2.parse(input))); return
        case '/stdio-v2/connections/check': sendJson(res, await discovery.check(token, stdioCheckRequestV2.parse(input))); return
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path.startsWith('/runtime/')) {
      const input = await readJson(req, path.startsWith('/runtime/native-intents/') ? config.nativeIntentMaxRequestBytes
        : path.startsWith('/runtime/native-input/') || path.startsWith('/runtime/native-turn/')
          ? config.nativeInputMaxCommandBytes : config.maxRequestBytes)
      if (['/runtime/attachments/read', '/runtime/attachments/copy', '/runtime/stdio-v2/calls/propose',
        '/runtime/connectors/notes', '/runtime/connectors/prepare', '/runtime/mcp/actions/propose', '/runtime/mcp/call',
        '/runtime/stdio-mcp/call', '/runtime/ssh-execute/propose', '/runtime/executions/propose'].includes(path)) {
        await transaction(pool, client => tasks.executionAuthorized(client, token))
      }
      switch (path) {
        case NATIVE_RETAINED_ROUTES.prepare: sendJson(res, await nativeIntents.prepare(token, input)); return
        case NATIVE_RETAINED_ROUTES.execute: sendJson(res, await nativeIntents.execute(token, input)); return
        case '/runtime/native-input/admit':
        case '/runtime/native-input/claim':
        case '/runtime/native-input/cancel-prepared':
        case '/runtime/native-input/cancel-archive':
        case '/runtime/native-input/queue':
        case '/runtime/native-input/step':
        case '/runtime/native-turn/transition':
        case '/runtime/native-assistant': throw new PlatformError(410, 'native_retained_protocol_required')
        case '/runtime/native-input/pending': {
          const value = nativeInputPendingRequest.parse(input)
          const result = await transaction(pool, client => nativeLedger.readAcceptedPendingInTransaction(client,
            { writer: value.writer, operationToken: token }, value.limit))
          sendJson(res, nativeInputPendingResponse.parse(result)); return
        }
        case '/runtime/native-input/recover-prepared': {
          const value = nativeInputFrameRequest.parse(input)
          sendJson(res, await transaction(pool, client => nativeFrames.recoverPreparedInTransaction(client,
            { writer: value.writer, operationToken: token }))); return
        }
        case '/runtime/native-input/recover-consumed': {
          const value = nativeInputFrameRequest.parse(input)
          const result = await transaction(pool, client => nativeFrames.readConsumedInTransaction(client,
            { writer: value.writer, operationToken: token }))
          sendJson(res, nativeConsumedInputRecovery.parse({ version: 1, kind: 'claimed',
            frame: result.operationFrame, grant: result.storageGrant })); return
        }
        case '/runtime/native-input/frame': {
          const value = nativeInputFrameRequest.parse(input)
          const frame = await transaction(pool, async (client) => {
            const verified = await nativeFrames.verifyInTransaction(client,
              { kind: 'read', expected: null, authority: { writer: value.writer, operationToken: token } })
            const row = await client.query<{ frame: unknown }>(
              'SELECT frame_json AS frame FROM pe_native_turn_frames WHERE operation_id=$1 AND operation_epoch=$2',
              [verified.operationId, verified.operationEpoch])
            const result = nativeExecutionFrame.parse(row.rows[0]?.frame)
            await nativeFrames.verifyInTransaction(client, { kind: 'read', expected: {
              sessionId: result.sessionId, operationId: result.operationId, operationEpoch: result.operationEpoch,
              writerEpoch: result.writerEpoch, frozenSnapshotDigest: result.frozenSnapshotDigest },
            authority: { writer: value.writer, operationToken: token } })
            return result
          })
          sendJson(res, frame); return
        }
        case '/runtime/native-turn/prepare': sendJson(res, await nativeAdvance.prepare(token, input)); return
        case '/runtime/native-writer/acquire':
        case '/runtime/native-writer/renew':
        case '/runtime/native-writer/release':
          sendJson(res, await routeNativeWriter(nativeWriter, path, token, input)); return
        case '/runtime/attachments/image': {
          const abort = new AbortController(), disconnected = () => { abort.abort() }
          res.once('close', disconnected)
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(config.legacyImageReadTimeoutMs)])
          try { sendJson(res, await readNativeImageResponse(nativeImages, token, input, signal)) }
          finally { res.off('close', disconnected) }
          return
        }
        case '/runtime/attachments/read': {
          const request = z.object({ file: nativeFileAttachment, offset: z.number().int().min(1),
            limit: z.number().int().min(1).max(200) }).strict().parse(input)
          sendJson(res, await attachments.readText(token, request.file, request.offset, request.limit)); return
        }
        case '/runtime/attachments/copy': {
          const request = z.object({ file: nativeFileAttachment, callId: z.string().min(1).max(128),
            path: z.string().min(1).max(512) }).strict().parse(input)
          sendJson(res, await attachments.copy(token, request.file, request.callId, request.path)); return
        }
        case '/runtime/stdio-v2/calls/propose': {
          if (!stdioV2) throw new PlatformError(503, 'stdio_v2_unavailable')
          sendJson(res, await stdioV2.calls.propose(token, input)); return
        }
        case '/runtime/interactive/status': {
          z.object({}).strict().parse(input)
          const status = await transaction(pool, async client => {
            const owner = await tasks.authorized(client, token)
            if (owner.source !== 'native_interactive') throw new PlatformError(403, 'native_interactive_required')
            const pending = await client.query("SELECT 1 FROM pe_operations WHERE session_id=$1 AND id<>$2 AND state IN ('queued','running') LIMIT 1", [owner.id, owner.operation_id])
            return { pending: Boolean(pending.rowCount) }
          })
          sendJson(res, { ...status, ...await tasks.renew(token) }); return
        }
        case '/runtime/subagents/configure': {
          const selection = z.object({ provider: z.string(), model: z.string(), maxTokens: z.number() }).strict().parse(input)
          sendJson(res, await nativeSubagents.configure(token, selection)); return
        }
        case '/runtime/subagents/create': {
          const request = z.object({ header: z.unknown() }).strict().parse(input)
          sendJson(res, await nativeSubagents.create(token, request.header)); return
        }
        case '/runtime/tools/register': sendJson(res, await registerNativeToolNames(tasks, token, nativeToolRegistration.parse(input))); return
        case '/runtime/snapshot': z.object({}).strict().parse(input); sendJson(res, await events.runtimeSnapshot(token)); return
        case '/runtime/append': sendJson(res, await events.append(token, z.object({ events: z.array(z.json()).max(256) }).strict().parse(input).events)); return
        case '/runtime/native-assistant/release': {
          const value = z.object({ publisherId: z.uuid() }).strict().parse(input)
          sendJson(res, await releaseNativeAssistant(tasks, token, value.publisherId)); return
        }
        case '/runtime/skills/resource': {
          const value = skillResourceRequest.parse(input)
          sendJson(res, await readRuntimeSkillResource(tasks, skills, token, value.skillId, value.path)); return
        }
        case '/runtime/skills/read': {
          const value = skillRequest.parse(input)
          sendJson(res, await readRuntimeSkill(tasks, skills, token, value.skillId)); return
        }
        case '/runtime/renew': z.object({}).strict().parse(input); sendJson(res, await tasks.renew(token)); return
        case '/runtime/finish': {
          const result = z.object({ outcome: z.enum(['completed', 'failed']), errorCode: z.string().max(80).nullable() }).strict().parse(input)
          await tasks.finish(token, result.outcome, result.errorCode)
          sendJson(res, { ok: true }); return
        }
        case '/runtime/connectors/notes': z.object({}).strict().parse(input); sendJson(res, await connectors.notes(token)); return
        case '/runtime/mcp/actions/propose': {
          if (!remoteMcpActions) throw new PlatformError(503, 'mcp_unavailable')
          sendJson(res, await remoteMcpActions.propose(token, mcpActionRequest.parse(input))); return
        }
        case '/runtime/mcp/call': {
          const value = z.object({ connectionId: z.uuid(), revision: z.number().int().positive() }).strict().parse(input)
          sendJson(res, await mcp.call(token, value.connectionId, value.revision)); return
        }
        case '/runtime/stdio-mcp/call': {
          const value = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(),
            callKey: z.string().min(1).max(100) }).strict().parse(input)
          sendJson(res, await stdioMcp.call(token, value.connectionId, value.revision, value.callKey)); return
        }
        case '/runtime/ssh-execute/propose': {
          if (!sshExecute) throw new PlatformError(503, 'ssh_unavailable')
          const value = sshExecuteProposeRequest.parse(input)
          sendJson(res, await sshExecute.propose(token, value.callKey, value.connectionId,
            value.connectionRevision, value.credentialRevision, value.command)); return
        }
        case '/runtime/connectors/prepare': {
          const value = z.object({ callId: z.string().min(1).max(100), text: z.string().trim().min(1).max(1000) }).strict().parse(input)
          sendJson(res, await connectors.prepare(token, value.callId, value.text)); return
        }
        case '/runtime/shell/propose': {
          if (!executions) throw new PlatformError(503, 'execution_unavailable')
          sendJson(res, await executions.proposeShell(token, cloudShellProposeRequest.parse(input))); return
        }
        case '/runtime/shell/status': {
          if (!executions) throw new PlatformError(503, 'execution_unavailable')
          const value = cloudShellExecutionRequest.parse(input)
          sendJson(res, await executions.statusShell(token, value.executionId)); return
        }
        case '/runtime/shell/cancel': {
          if (!executions) throw new PlatformError(503, 'execution_unavailable')
          const value = cloudShellCancelRequest.parse(input)
          sendJson(res, await executions.cancelShell(token, value.executionId, value.cause)); return
        }
        case '/runtime/executions/propose': {
          if (!executions) throw new PlatformError(503, 'execution_unavailable')
          const value = z.object({ callId: z.string().min(1).max(100), command: z.string().min(1).max(8192),
            cwd: z.string().max(256).regex(/^(?:|[A-Za-z0-9._/-]{1,256})$/) }).strict().parse(input)
          if (value.cwd.split('/').some(part => part === '..')) throw new PlatformError(400, 'invalid_cwd')
          sendJson(res, await executions.propose(token, value.callId, value.command, value.cwd)); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path === '/identity/exchange') {
      z.object({}).strict().parse(await readJson(req, 4096))
      sendJson(res, { token: await identities.exchange(token) })
      return
    }
    const user = await identities.authenticate(token)
    if (path.startsWith('/executions/resolutions/')) {
      sendJson(res, await routeExecutionResolutionRead(executions, path, user,
        await readJson(req, 4096))); return
    }
    if (path === '/native/input/queue-receipt' || path === '/native/input/queue') {
      const command = nativeInputQueueCommand.parse(await readJson(req, config.nativeInputMaxCommandBytes))
      if (path === '/native/input/queue-receipt') sendJson(res, await nativeInput.readQueueReceipt(token, command))
      else {
        if (!nativeQueueRouting) throw new PlatformError(503, 'native_input_owner_routing_unavailable')
        sendJson(res, await nativeQueueRouting.queue(token, command))
      }
      return
    }
    const input = await readJson(req, config.maxRequestBytes)
    if (path.startsWith('/mcp/connections/')) {
      sendJson(res, await routeMcpManagement(remoteMcp, path, user, input, config.platformOrigin)); return
    }
    if (path === '/mcp/actions/status' || path === '/mcp/actions/cancel') {
      if (!remoteMcpActions) throw new PlatformError(503, 'mcp_unavailable')
      const value = z.object({ actionId: mcpActionId }).strict().parse(input)
      sendJson(res, path === '/mcp/actions/status' ? await remoteMcpActions.status(user, value.actionId)
        : await remoteMcpActions.cancel(user, value.actionId, { token, audience: 'agent' })); return
    }
    const fileWorkspace = async (session: string): Promise<string> => {
      const result = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [session, user.userId],
      )
      if (!result.rows[0]) throw new PlatformError(404, 'session_not_found')
      return result.rows[0].workspace_id
    }
    switch (path) {
      case '/native/attachments/uploadEncoded': {
        const request = z.object({ sessionId, data: z.string().max(Math.ceil(NATIVE_FILE_MAX_BYTES / 3) * 4),
          name: z.string().max(4096).optional() }).strict().parse(input)
        const bytes = Buffer.from(request.data, 'base64')
        if (bytes.length > NATIVE_FILE_MAX_BYTES || bytes.toString('base64') !== request.data) {
          throw new PlatformError(400, 'invalid_file_data')
        }
        sendJson(res, await attachments.upload(user, token, request.sessionId, Readable.from([bytes]), request.name,
          AbortSignal.timeout(config.nativeUploadTimeoutMs))); return
      }
      case '/native/preferences/read': {
        const value = z.object({ ns: nativePreferenceNamespace }).strict().parse(input)
        sendJson(res, await nativePreferences.read(user, value.ns)); return
      }
      case '/native/presets/select': {
        sendJson(res, await selectNativePreset(pool, user, token, nativePresetSelection.parse(input), config)); return
      }
      case '/native/preferences/write': {
        sendJson(res, await nativePreferences.write(user, token, nativePreferenceWrite.parse(input))); return
      }
      case '/native/models/select': {
        sendJson(res, await nativePreferences.selectModel(user, token, nativeModelSelect.parse(input))); return
      }
      case '/files/download/prepare': {
        const request = fileDownloadPrepareRequest.parse(input)
        const abort = new AbortController()
        res.once('close', () => { abort.abort() })
        sendJson(res, await fileDownloads.prepare(user, request, abort.signal, async () => { await identities.authenticate(token) }))
        return
      }
      case '/identity/me': z.object({}).strict().parse(input); sendJson(res, user); return
      case '/identity/models': modelsListRequest.parse(input); sendJson(res, await accountSettings.modelsList(user, token)); return
      case ACCOUNT_ROUTES.capabilities: {
        if (!accounts) throw new PlatformError(503, 'account_unavailable')
        sendJson(res, await routeAccount(accounts, path, token, input, req.headers.origin)); return
      }
      case '/identity/settings/update': {
        const value = settingsUpdateRequest.parse(input)
        sendJson(res, await accountSettings.update(user, value, token)); return
      }
      case '/identity/logout': z.object({}).strict().parse(input); await identities.logout(token); sendJson(res, { ok: true }); return
      case '/plugins/list': z.object({}).strict().parse(input); sendJson(res, await plugins.list(user)); return
      case '/plugins/notes/set-enabled': {
        const value = z.object({ requestId: z.uuid(), expectedRevision: z.number().int().positive(),
          enabled: z.boolean() }).strict().parse(input)
        sendJson(res, await plugins.notesSetEnabled(user, value)); return
      }
      case '/mcp/list': z.object({}).strict().parse(input); sendJson(res, await mcp.list(user)); return
      case '/mcp/install': {
        const value = z.object({ requestId: z.uuid(), name: z.string().trim().min(1).max(80) }).strict().parse(input)
        sendJson(res, await mcp.install(user, value.requestId, value.name)); return
      }
      case '/mcp/toggle': {
        const value = z.object({ connectionId: z.uuid(), requestId: z.uuid(),
          baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict().parse(input)
        sendJson(res, await mcp.toggle(user, value.connectionId, value.requestId, value.baseRevision, value.enabled)); return
      }
      case '/mcp/check': {
        const value = z.object({ connectionId: z.uuid() }).strict().parse(input)
        sendJson(res, await mcp.check(user, value.connectionId)); return
      }
      case '/stdio-mcp/list': z.object({}).strict().parse(input); sendJson(res, await stdioMcp.list(user)); return
      case '/stdio-mcp/install': {
        const value = z.object({ requestId: z.uuid(), name: z.string().trim().min(1).max(80) }).strict().parse(input)
        sendJson(res, await stdioMcp.install(user, value.requestId, value.name)); return
      }
      case '/stdio-mcp/toggle': {
        const value = z.object({ connectionId: z.uuid(), requestId: z.uuid(),
          baseRevision: z.number().int().positive(), enabled: z.boolean() }).strict().parse(input)
        sendJson(res, await stdioMcp.toggle(user, value.connectionId, value.requestId,
          value.baseRevision, value.enabled)); return
      }
      case '/stdio-mcp/calls': z.object({}).strict().parse(input); sendJson(res, await stdioMcp.calls(user)); return
      case '/stdio-mcp/status': {
        const value = z.object({ callId: z.uuid() }).strict().parse(input)
        sendJson(res, await stdioMcp.status(user, value.callId)); return
      }
      case '/ssh/connections/list': {
        sshManagementRequests.sshConnectionsList.parse(input)
        sendJson(res, { ...(await ssh.listManaged(user)), available: sshAvailable }); return
      }
      case '/ssh/connections/update': {
        const value = sshManagementRequests.sshConnectionsUpdate.parse(input)
        if (value.configuration.enabled && !sshAvailable) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await ssh.update(user, value)); return
      }
      case '/ssh/connections/toggle': {
        const value = sshManagementRequests.sshConnectionsToggle.parse(input)
        if (value.enabled && !sshAvailable) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await ssh.toggleManaged(user, value)); return
      }
      case '/ssh/connections/delete': {
        sendJson(res, await ssh.remove(user, sshManagementRequests.sshConnectionsDelete.parse(input))); return
      }
      case '/ssh/connections/ticket': {
        if (!sshAvailable) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await ssh.issueManagedTicket(user,
          sshManagementRequests.sshConnectionsTicket.parse(input), config.platformOrigin)); return
      }
      case '/ssh/connections/receipt': {
        const value = sshManagementRequests.sshConnectionsReceipt.parse(input)
        sendJson(res, await ssh.receipt(user, value.requestId)); return
      }
      case '/ssh/list': {
        z.object({}).strict().parse(input)
        sendJson(res, { ...(await ssh.list(user)), available: sshAvailable }); return
      }
      case '/ssh/create-ticket': {
        if (!sshAvailable) throw new PlatformError(503, 'ssh_unavailable')
        const value = sshCreateTicketRequest.parse(input)
        sendJson(res, await ssh.issueTicket(user, value, config.platformOrigin)); return
      }
      case '/ssh/toggle': {
        const value = sshToggleRequest.parse(input)
        if (value.enabled && !sshAvailable) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await ssh.toggle(user, value.connectionId, value.requestId,
          value.baseRevision, value.enabled)); return
      }
      case '/ssh/check': {
        if (!sshCheck) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await sshCheck.submit(user, sshCheckRequest.parse(input), token)); return
      }
      case '/ssh/call-status': {
        if (!sshCheck) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await sshCheck.status(user, sshCallRefRequest.parse(input).callId)); return
      }
      case '/ssh/call-list': {
        if (!sshCheck) throw new PlatformError(503, 'ssh_unavailable')
        z.object({}).strict().parse(input)
        sendJson(res, await sshCheck.list(user)); return
      }
      case '/ssh/call-cancel': {
        if (!sshCheck) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await sshCheck.cancel(user, sshCallRefRequest.parse(input).callId)); return
      }
      case '/ssh/execute/status': {
        if (!sshExecute) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await sshExecute.status(user, sshExecuteRefRequest.parse(input).actionId)); return
      }
      case '/ssh/execute/list': {
        if (!sshExecute) throw new PlatformError(503, 'ssh_unavailable')
        z.object({}).strict().parse(input)
        sendJson(res, await sshExecute.list(user)); return
      }
      case '/ssh/execute/cancel': {
        if (!sshExecute) throw new PlatformError(503, 'ssh_unavailable')
        sendJson(res, await sshExecute.cancel(user, sshExecuteRefRequest.parse(input).actionId, { token, audience: 'agent' })); return
      }
      case '/sessions/create': {
        const value = createRequest.parse(input)
        await skills.ensurePreinstalled(user, config.preinstalledSkills)
        sendJson(res, await tasks.create(user, value.requestId, token, value.workspaceId, value.agentPreset)); return
      }
      case '/sessions/list': {
        const { offset, limit } = listRequest.parse(input)
        sendJson(res, await tasks.list(user, offset, limit)); return
      }
      case '/sessions/prompt': {
        const { sessionId, requestId, text, target, nativeContent } = promptRequest.parse(input)
        await skills.ensurePreinstalled(user, config.preinstalledSkills)
        const abort = new AbortController()
        const disconnected = () => { if (!res.writableEnded) abort.abort() }
        res.on('close', disconnected)
        try {
          sendJson(res, await tasks.accept(user, sessionId, requestId, text, token, target, nativeContent,
            AbortSignal.any([abort.signal, AbortSignal.timeout(config.nativeUploadTimeoutMs)])))
        } finally { res.off('close', disconnected) }
        return
      }
      case '/sessions/cancel': {
        const { sessionId } = sessionRequest.parse(input)
        sendJson(res, await tasks.cancel(user, sessionId, token)); return
      }
      case '/native/attachments/image': {
        const abort = new AbortController()
        const disconnected = () => { if (!res.writableEnded) abort.abort() }
        res.on('close', disconnected)
        try {
          sendJson(res, await readNativeBrowserImageResponse(nativeImages, token, input,
            AbortSignal.any([abort.signal, AbortSignal.timeout(config.legacyImageReadTimeoutMs)])))
        } finally { res.off('close', disconnected) }
        return
      }
      case '/native/sessions/cancel': {
        const { sessionId } = sessionRequest.parse(input)
        sendJson(res, await tasks.cancelActive(user, sessionId, token)); return
      }
      case '/sessions/page': {
        const { sessionId, after, limit } = pageRequest.parse(input)
        sendJson(res, await events.page(user, sessionId, after, limit)); return
      }
      case '/native/sessions/list': {
        z.object({}).strict().parse(input)
        sendJson(res, await nativeSessions.list(user)); return
      }
      case '/native/sessions/rename': {
        sendJson(res, await nativeSessionCommands.rename(user, token, nativeSessionRename.parse(input))); return
      }
      case '/native/sessions/search': {
        const { query } = nativeSessionSearch.parse(input)
        const lifetime = new AbortController()
        const disconnected = () => { if (!res.writableEnded) lifetime.abort() }
        res.on('close', disconnected)
        try { sendJson(res, await nativeSessionCommands.search(user, query, lifetime.signal)) }
        finally { res.off('close', disconnected) }
        return
      }
      case '/native/sessions/fork': {
        const value = nativeSessionFork.extend({ requestId }).strict().parse(input)
        sendJson(res, await nativeSessionCommands.fork(user, token, nativeSessionFork.parse({ sessionId: value.sessionId,
          ...(value.atSeq === undefined ? {} : { atSeq: value.atSeq }) }), value.requestId)); return
      }
      case '/native/sessions/adopt': {
        const value = z.object({ sessionId }).strict().parse(input)
        await skills.ensurePreinstalled(user, config.preinstalledSkills)
        sendJson(res, await nativeSessions.adoptBlank(user, value.sessionId)); return
      }
      case '/native/workspace/baseline': {
        z.object({}).strict().parse(input)
        sendJson(res, await nativeWorkspaces.baseline(user)); return
      }
      case '/workspaces/list': {
        z.object({}).strict().parse(input)
        sendJson(res, await nativeWorkspaces.list(user)); return
      }
      case '/workspaces/create': {
        const value = workspaceCreateRequest.parse(input)
        sendJson(res, await nativeWorkspaces.create(user, value.requestId, value.title, token)); return
      }
      case '/native/directories/list': {
        const value = nativeDirectoryList.parse(input)
        sendJson(res, await nativeWorkspaces.directories(user, value.path)); return
      }
      case '/native/directories/create': {
        const value = nativeDirectoryCreate.parse(input)
        sendJson(res, await nativeWorkspaces.createDirectory(user, token, value.path, value.name)); return
      }
      case '/native/workspaces/create': {
        const value = nativeWorkspaceCreate.extend({ requestId }).strict().parse(input)
        sendJson(res, await nativeWorkspaces.adopt(user, token, value.path, value.requestId)); return
      }
      case '/native/workspaces/rename': {
        const value = nativeWorkspaceRename.parse(input)
        sendJson(res, await nativeWorkspaces.rename(user, token, value.workspaceId, value.title)); return
      }
      case '/native/workspaces/delete': {
        const value = nativeWorkspaceDelete.parse(input)
        sendJson(res, await nativeWorkspaces.remove(user, token, value.workspaceId)); return
      }
      case '/native/workspaces/insertBefore': {
        const value = nativeWorkspaceOrder.parse(input)
        sendJson(res, await nativeWorkspaces.order(user, token, value.workspaceId, value.beforeWorkspaceId)); return
      }
      case '/native/workspaces/insertSessionBefore': {
        const value = nativeSessionOrder.parse(input)
        sendJson(res, await nativeWorkspaces.orderSession(user, token, value.workspaceId, value.sessionId, value.beforeSessionId)); return
      }
      case '/native/workspaces/archiveSession': {
        const value = nativeSessionArchive.parse(input)
        const result = value.stopActivity
          ? await nativeWorkspaces.archiveAndStop(user, token, value.sessionId, tasks, nativeInputLimits)
          : await nativeWorkspaces.groupSession(user, token, value.sessionId, 'archive')
        sendJson(res, result); return
      }
      case '/native/workspaces/unarchiveSession':
      case '/native/workspaces/pinSession':
      case '/native/workspaces/unpinSession': {
        const value = nativeSessionGrouping.parse(input)
        const action = path.endsWith('/unarchiveSession') ? 'unarchive'
          : path.endsWith('/pinSession') ? 'pin' : 'unpin'
        sendJson(res, await nativeWorkspaces.groupSession(user, token, value.sessionId, action)); return
      }
      case '/native/sessions/page': {
        sendJson(res, await nativeSessions.page(user, nativePageRequest.parse(input))); return
      }
      case '/native/sessions/snapshot': {
        sendJson(res, await nativeSessions.snapshot(user, nativeFollowRequest.parse(input))); return
      }
      case '/native/sessions/open': {
        sendJson(res, await nativeSessions.opening(user, nativeFollowRequest.parse(input), nativeAssistantReader,
          config.nativeAssistantMaxOpeningBytes)); return
      }
      case '/native/sessions/presentationAfter': {
        const value = z.object({ sessionId, cursor: z.number().int().min(-1),
          position: nativeAssistantPosition.nullable() }).strict().parse(input)
        sendJson(res, await nativeSessions.presentationAfter(user, value.sessionId, value.cursor, value.position,
          nativeAssistantReader)); return
      }
      case '/native/sessions/after': {
        const value = z.object({ sessionId, cursor: z.number().int().min(-1) }).strict().parse(input)
        sendJson(res, { events: await nativeSessions.after(user, value.sessionId, value.cursor) }); return
      }
      case '/native/files/list': sendJson(res, await nativeFiles.list(user, nativeFileRequest.parse(input))); return
      case '/native/files/stat': sendJson(res, await nativeFiles.stat(user, nativeFileRequest.parse(input))); return
      case '/native/files/read': sendJson(res, await nativeFiles.read(user, nativeFileTextRequest.parse(input))); return
      case '/native/files/readBytes': sendJson(res, await nativeFiles.readBytes(user, nativeFileBytesRequest.parse(input))); return
      case '/native/files/observe': sendJson(res, await nativeFiles.observe(user, nativeFileRequest.parse(input))); return
      case '/files/session/list': {
        const value = sessionFilesListRequest.parse(input)
        sendJson(res, await files.list(user, value.directory, await fileWorkspace(value.sessionId))); return
      }
      case '/files/session/read': {
        const value = sessionFileReadRequest.parse(input)
        sendJson(res, await files.readInWorkspace(user, await fileWorkspace(value.sessionId), value.path)); return
      }
      case '/files/session/put': {
        const value = sessionFilePutRequest.parse(input)
        sendJson(res, await files.put(user, value.requestId, value.path, value.data,
          await fileWorkspace(value.sessionId))); return
      }
      case '/files/list': sendJson(res, await files.list(user, filesListRequest.parse(input).directory)); return
      case '/files/read': sendJson(res, await files.read(user, fileReadRequest.parse(input).path)); return
      case '/files/put': {
        const value = filePutRequest.parse(input)
        sendJson(res, await files.put(user, value.requestId, value.path, value.data)); return
      }
      case '/skills/list': {
        z.object({}).strict().parse(input)
        await skills.ensurePreinstalled(user, config.preinstalledSkills)
        sendJson(res, await skills.list(user)); return
      }
      case '/skills/catalog': z.object({}).strict().parse(input); sendJson(res, await skills.catalog(user)); return
      case '/skills/install-builtin': {
        const value = builtinSkillInstallRequest.parse(input)
        sendJson(res, await skills.installBuiltin(user, value.requestId, value.catalogId, value.version)); return
      }
      case '/skills/read': sendJson(res, await skills.read(user, skillRequest.parse(input).skillId)); return
      case '/skills/install': {
        const value = skillInstallRequest.parse(input)
        sendJson(res, await skills.install(user, value.requestId, value.name, value.description, value.instructions)); return
      }
      case '/skills/upload-ticket': {
        const value = skillUploadTicketRequest.parse(input)
        sendJson(res, await skills.issueUploadTicket(user, value.requestId, value.sizeBytes, value.sha256,
          config.platformOrigin)); return
      }
      case '/skills/toggle': {
        const value = skillToggleRequest.parse(input)
        sendJson(res, await skills.toggle(user, value.skillId, value.enabled)); return
      }
      case '/skills/revoke': {
        const value = skillRequest.parse(input)
        sendJson(res, await skills.revoke(user, value.skillId)); return
      }
      case '/connectors/actions': z.object({}).strict().parse(input); sendJson(res, await connectors.list(user)); return
      case '/executions/list': {
        z.object({}).strict().parse(input)
        const cloudItems: Array<Record<string, unknown>> = executions
          ? (await executions.list(user) as { items: Array<Record<string, unknown>> }).items : []
        sendJson(res, { items: cloudItems }); return
      }
      case '/executions/cancel': {
        if (!executions) throw new PlatformError(503, 'execution_unavailable')
        const value = z.object({ executionId: z.uuid() }).strict().parse(input)
        sendJson(res, await executions.cancel(user, value.executionId)); return
      }
      default: throw new PlatformError(404, 'not_found')
    }
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    try { await handle(req, res) }
    catch (error) {
      if (!(error instanceof PlatformError || error instanceof z.ZodError)) ctx.logger.warn('Platform request failed (%s)', error instanceof Error ? error.name : 'unknown')
      sendFailure(res, error)
    }
  }))
  await writeFile(config.readyFile, JSON.stringify({ pid: process.pid, url: `http://${ctx.webServer.host}:${ctx.webServer.port}`, instanceId }), { mode: 0o600 })
}
