/** Trusted platform profile: identity, durable tasks/events, and credentialed model egress. */
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { join, relative, resolve } from 'node:path'
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
import { EventStore } from './events.ts'
import { NativeSessionRead, nativeFollowRequest, nativePageRequest } from './native-session-read.ts'
import { NativeWorkspaceRead } from './native-workspace-read.ts'
import { NativeFileRead, nativeFileRequest, nativeFileTextRequest, nativeFileBytesRequest } from './native-files.ts'
import { FileService } from './files.ts'
import { FileDownloadService } from './file-downloads.ts'
import { WORKSPACE_BINDING_ROUTES, storageDirectoriesRequest, storageDirectoryCreateRequest,
  workspaceBindingRestoreRequest, workspaceBindingStatusRequest } from '@power-evolve/contracts/workspace-binding'
import { FILE_DOWNLOAD_MAX_FILES, FILE_DOWNLOAD_MAX_SOURCE_BYTES, FILE_DOWNLOAD_PLATFORM_PATH,
  fileDownloadPrepareRequest } from '@power-evolve/contracts/file-download'
import { fileDownloadDisposition, parseFileDownloadQuery, writeFileDownload } from '../file-download-http.ts'
import { ArtifactService } from './artifacts.ts'
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
import { SshConnectionService } from './ssh.ts'
import { sshManagementRequests } from '../ssh-management-contracts.ts'
import { SshCallStore } from './ssh-calls.ts'
import { SshAuthenticationCheck } from './ssh-check.ts'
import { SshExecuteService } from './ssh-execute.ts'
import { SshRunnerOrchestrator } from './ssh-runner.ts'
import { ExecutionService } from './executions.ts'
import { ExecutionFileFactsService } from './execution-file-facts.ts'
import { artifactPublishRequest, executionFilesRequest,
  EXECUTION_FILES_PLATFORM_PATH } from '@power-evolve/contracts/execution-files'
import { LoginAdmission } from './login-admission.ts'
import { DeviceService } from './devices.ts'
import { KubernetesClient } from './kubernetes.ts'
import { SandboxManager } from './sandbox.ts'
import { proxyModel } from './model.ts'
import { serveUi } from '../ui.ts'
import { serveTrustedAccountUi } from '../trusted-account-ui.ts'

const accountUiDirectory = fileURLToPath(new URL('../../../client-account/lib/trusted/', import.meta.url))

export const name = 'power-evolve-platform'
export const inject = ['webServer']

/** Platform settings contain file references; profile dumps do not contain secret values. */
export const Config = schema.object({
  databaseUrlFile: schema.string().required(), workerTokenFile: schema.string().required(),
  workspaceRoot: schema.string().required(), artifactRoot: schema.string().required(),
  fileDownloadMaxFiles: schema.number().step(1).min(1).max(FILE_DOWNLOAD_MAX_FILES).default(32),
  fileDownloadMaxTotalBytes: schema.number().step(1).min(1).max(FILE_DOWNLOAD_MAX_SOURCE_BYTES).default(32 * 1024 * 1024),
  fileDownloadMaxConcurrentTransfers: schema.number().step(1).min(1).default(4),
  fileDownloadMaxUserConcurrentTransfers: schema.number().step(1).min(1).default(2),
  fileDownloadTransferTimeoutMs: schema.number().step(1).min(1).default(60_000),
  modelKeyFile: schema.string().required(), connectorKeyFile: schema.string().required(), seedUsersFile: schema.string().default(''),
  accountManagementFile: schema.string().default(''), accountBootstrapFile: schema.string().default(''),
  modelUrl: schema.string().required(), hostOrigin: schema.string().required(), platformOrigin: schema.string().required(),
  mcpUrl: schema.string().default(''), mcpTokenFile: schema.string().default(''),
  remoteMcpConfigFile: schema.string().default(''),
  mcpTimeoutMs: schema.number().min(1000).default(5000),
  sshCredentialKeyFile: schema.string().default(''), sshDestinationAllowlist: schema.string().default(''),
  sshMaxConnections: schema.number().step(1).min(1).max(8).default(8),
  sshMaxPendingTickets: schema.number().step(1).min(1).default(8),
  sshTicketLifetimeMs: schema.number().step(1).min(1000).default(300000),
  sshMaxCompletedMismatches: schema.number().step(1).min(1).default(3),
  sshRunnerKubeconfigFile: schema.string().default(''), sshRunnerNamespace: schema.string().default(''),
  sshRunnerImage: schema.string().default(''), sshRunnerRuntimeClass: schema.string().default('gvisor'),
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
  sandboxCommandTimeoutMs: schema.number().min(1000).default(60000),
  sandboxFileVerifyTimeoutMs: schema.number().step(1).min(100).max(60000).default(15000),
  sandboxScanMaxEntries: schema.number().step(1).min(1).max(65536).default(4096),
  sandboxScanMaxHashBytes: schema.number().step(1).min(1).max(209715200).default(33554432),
  sandboxScanTimeoutMs: schema.number().step(1).min(1).max(30000).default(5000),
  sandboxScanMaxSnapshotBytes: schema.number().step(1).min(1024).max(4194304).default(1048576),
  sandboxScanMaxFiles: schema.number().step(1).min(1).max(100).default(100),
  leaseMs: schema.number().min(1000).required(), tokenLifetimeMs: schema.number().min(1000).required(),
  maxPendingPerUser: schema.number().step(1).min(1).required(), maxActivePerUser: schema.number().step(1).min(1).required(),
  maxWorkspacesPerUser: schema.number().step(1).min(1).default(16),
  workspaceRecoveryPollMs: schema.number().step(1).min(100).default(500),
  workspaceRecoveryLeaseMs: schema.number().step(1).min(1000).max(300000).default(90000),
  maxSkillsPerUser: schema.number().step(1).min(1).max(256).default(64),
  skillLibraryRoot: schema.string().default(''),
  preinstalledSkills: schema.array(schema.string()).default([]),
  maxHistoryBytes: schema.number().step(1).min(1024).required(), maxHistoryEvents: schema.number().step(1).min(1).required(),
  maxEventBytes: schema.number().step(1).min(1024).required(), maxRequestBytes: schema.number().step(1).min(1024).required(),
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

/** Register the platform only after its schema and configured users are ready. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const instanceId = randomUUID()
  const remoteMcpConfig = await loadMcpPlatformConfig(config.remoteMcpConfigFile)
  if (config.accountBootstrapFile && !config.accountManagementFile) throw new Error('Account bootstrap requires management configuration')
  const [accountManagement, accountBootstrap] = await Promise.all([
    config.accountManagementFile ? loadAccountManagementConfig(config.accountManagementFile) : Promise.resolve(null),
    loadAccountBootstrapConfig(config.accountBootstrapFile),
  ])
  const [databaseUrl, workerToken, modelKey, connectorKey, seeds, mcpToken, sshKey] = await Promise.all([
    readFile(config.databaseUrlFile, 'utf8'), readFile(config.workerTokenFile, 'utf8'),
    readFile(config.modelKeyFile, 'utf8'), readFile(config.connectorKeyFile, 'utf8'),
    config.seedUsersFile ? readFile(config.seedUsersFile, 'utf8') : Promise.resolve('[]'),
    config.mcpTokenFile ? readFile(config.mcpTokenFile, 'utf8') : Promise.resolve(''),
    config.sshCredentialKeyFile ? readFile(config.sshCredentialKeyFile, 'utf8') : Promise.resolve(''),
  ])
  const pool = new Pool({ connectionString: databaseUrl.trim(), max: config.databasePoolSize,
    connectionTimeoutMillis: config.databaseTimeoutMs, query_timeout: config.databaseTimeoutMs,
    statement_timeout: config.databaseTimeoutMs })
  // Keep readiness independent of busy task workers and bound outage probes to one second.
  const healthPool = new Pool({ connectionString: databaseUrl.trim(), max: 1,
    connectionTimeoutMillis: 1000, query_timeout: 1000, statement_timeout: 1000 })
  let databaseReady = true
  const databaseUnavailable = (error: unknown) => {
    if (!databaseReady) return
    databaseReady = false
    ctx.logger.error('Platform PostgreSQL connection lost (%s)',
      error instanceof Error ? error.message : 'unknown error')
  }
  pool.on('error', databaseUnavailable)
  healthPool.on('error', databaseUnavailable)
  const mcpShutdown = new Set<() => Promise<void>>()
  // Cordis disposers run concurrently; terminal MCP writes must settle before this pool enters ending.
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
  const artifactRelative = relative(resolve(config.workspaceRoot), resolve(config.artifactRoot))
  if (!artifactRelative || !artifactRelative.startsWith('..')) {
    throw new Error('Artifact root cannot be inside the writable workspace root')
  }
  const artifacts = new ArtifactService(pool, files, config.artifactRoot)
  await artifacts.init()
  const executionFiles = new ExecutionFileFactsService(pool, files)
  const skillLibraryRoot = config.skillLibraryRoot || config.sandboxLocalRoot
  if (executionEnabled && resolve(skillLibraryRoot) !== resolve(config.sandboxLocalRoot)) {
    throw new Error('Skill library and Sandbox roots differ')
  }
  if (config.preinstalledSkills.length && !skillLibraryRoot) throw new Error('Missing Skill library root')
  const skills = new SkillService(pool, config.workspaceRoot, skillLibraryRoot, config.maxSkillsPerUser)
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
  const tasks = new TaskStore(pool, { ...config, executionEnabled, mcpEnabled: !!config.mcpUrl,
    ...(remoteMcpConfig ? { remoteMcpAdmission: remoteMcpConfig.settings.admission } : {}),
    stdioMcpEnabled: !!config.sshRunnerKubeconfigFile,
    sshEnabled: !!config.sshRunnerKubeconfigFile && !!config.sshCredentialKeyFile })
  const mcp = new PersonalMcpService(tasks, config.mcpUrl, mcpToken.trim(), config.mcpTimeoutMs)
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
        const run = (async () => {
          while (!controller.signal.aborted) {
            try { await work(controller.signal) }
            catch { ctx.logger.warn('Remote MCP %s worker restarting after uncertain persistence', label) }
            if (controller.signal.aborted) return
            try { await delay(intervalMs, undefined, { signal: controller.signal }) }
            catch (error) { if (controller.signal.aborted) return; throw error }
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
  if (sshRunnerEnabled && (!config.sshRunnerNamespace || !config.sshRunnerImage
    || !config.sshRunnerRuntimeClass || !config.sshRunnerIngressCidrs)) {
    throw new Error('Incomplete Connector Runner configuration')
  }
  let stdioRunner: StdioRunnerOrchestrator | null = null
  const sshServices = sshRunnerEnabled ? await (async () => {
    const kube = await KubernetesClient.fromFile(config.sshRunnerKubeconfigFile)
    const namespace = config.sshRunnerNamespace, serviceName = 'power-evolve-forbidden-listener'
    const servicePath = kube.resourcePath(namespace, 'services', serviceName)
    const service = await kube.call<{ metadata?: { name?: string }; spec?: { clusterIP?: string;
      selector?: Record<string, string>; ports?: Array<{ port?: number }> } }>('GET', servicePath)
    const probeIp = service.spec?.clusterIP
    if (service.metadata?.name !== serviceName || !probeIp || !isIP(probeIp)
      || service.spec?.selector?.['app.kubernetes.io/name'] !== serviceName
      || service.spec?.ports?.[0]?.port !== 8080) throw new Error('SSH forbidden listener identity invalid')
    const proveForbiddenListener = async () => {
      try {
        const current = await kube.call<typeof service>('GET', servicePath)
        if (current.spec?.clusterIP !== probeIp || current.spec?.ports?.[0]?.port !== 8080) return false
        const health = await kube.call<{ healthy?: boolean }>('GET',
          kube.proxyPath(namespace, serviceName, '/health'), undefined, 3000)
        return health.healthy === true
      } catch (_unavailable) { return false }
    }
    if (!await proveForbiddenListener()) throw new Error('SSH forbidden listener unavailable')
    const runner = new SshRunnerOrchestrator(kube, {
      namespace, image: config.sshRunnerImage, runtimeClassName: config.sshRunnerRuntimeClass,
      controlKey: connectorKey.trim(), readyTimeoutMs: config.sshRunnerReadyTimeoutMs,
      platformIngressCidrs: config.sshRunnerIngressCidrs.split(',').map(value => value.trim()),
      forbiddenProbe: { ip: probeIp, port: 8080 }, proveForbiddenListener,
    })
    stdioRunner = new StdioRunnerOrchestrator(kube, {
      namespace, image: config.sshRunnerImage, runtimeClassName: config.sshRunnerRuntimeClass,
      controlKey: connectorKey.trim(), readyTimeoutMs: config.sshRunnerReadyTimeoutMs,
      platformIngressCidrs: config.sshRunnerIngressCidrs.split(',').map(value => value.trim()),
      forbiddenProbe: { ip: probeIp, port: 8080 }, proveForbiddenListener,
    })
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
  const nativeSessions = new NativeSessionRead(pool)
  const nativeWorkspaces = new NativeWorkspaceRead(pool, files, nativeSessions, config.maxWorkspacesPerUser)
  const nativeFiles = new NativeFileRead(pool, files)
  const connectors = new ConnectorService(tasks, config.connectorUrl, connectorKey.trim(), config.connectorTimeoutMs, config.connectorPollMs)
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
      readyTimeoutMs: config.sandboxReadyTimeoutMs,
      fileScan: {
        maxEntries: config.sandboxScanMaxEntries, maxHashBytes: config.sandboxScanMaxHashBytes,
        timeoutMs: config.sandboxScanTimeoutMs, maxSnapshotBytes: config.sandboxScanMaxSnapshotBytes,
        maxFiles: config.sandboxScanMaxFiles,
      },
    }) : null
  const executions = sandboxManager ? new ExecutionService(tasks, sandboxManager,
    { service: executionFiles, timeoutMs: config.sandboxFileVerifyTimeoutMs },
    config.sandboxConcurrency, config.sandboxPollMs, config.sandboxIdleMs, config.sandboxCommandTimeoutMs) : null
  if (executions) { executions.start(); ctx.effect(() => () => executions.close()) }
  const recoveryStop = new AbortController()
  const recoveryPolling = (async () => {
    let unavailable = false
    while (!recoveryStop.signal.aborted) {
      try {
        await files.bindings.poll(async (claim, assertLease) => {
          if (!sandboxManager) throw new PlatformError(503, 'workspace_execution_unavailable')
          return sandboxManager.stopForRecovery(claim, assertLease)
        }, recoveryStop.signal, { ownerId: instanceId, leaseMs: config.workspaceRecoveryLeaseMs })
        if (unavailable) ctx.logger.info('Workspace recovery polling resumed')
        unavailable = false
      } catch (error) {
        if (!recoveryStop.signal.aborted && !unavailable) {
          ctx.logger.warn('Workspace recovery polling unavailable (%s)',
            error instanceof PlatformError ? error.code : 'internal_error')
        }
        unavailable = true
      }
      try { await delay(config.workspaceRecoveryPollMs, undefined, { signal: recoveryStop.signal }) }
      catch (_aborted) { /* Shutdown interrupts the polling interval. */ }
    }
  })()
  const closeRecovery = async () => { recoveryStop.abort(); await recoveryPolling }
  mcpShutdown.add(closeRecovery)
  ctx.effect(() => closeRecovery)
  const devices = new DeviceService(tasks, config.sandboxCommandTimeoutMs, files)

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
        if (!databaseReady) ctx.logger.info('Platform PostgreSQL connection recovered')
        databaseReady = true
        sendJson(res, { ready: true, service: 'platform', schema: versions.rows[0]!.version, executionEnabled,
          mcpAvailable: !!config.mcpUrl, remoteMcpAvailable: remoteMcp !== null,
          stdioMcpAvailable: stdioMcp.available, sshAvailable, instanceId })
      } catch (error) {
        databaseUnavailable(error)
        sendJson(res, { ready: false, service: 'platform', schema: null, database: 'unavailable',
          executionEnabled, mcpAvailable: !!config.mcpUrl, remoteMcpAvailable: remoteMcp !== null,
          stdioMcpAvailable: stdioMcp.available,
          sshAvailable, instanceId }, 503)
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
      res.once('close', () => abort.abort())
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
    const artifactContent = /^\/artifacts\/([^/]+)\/content$/u.exec(path)
    if (req.method === 'GET' && artifactContent) {
      const user = await identities.authenticate(bearer(req))
      const artifactId = z.uuid().parse(artifactContent[1])
      const { record, bytes } = await artifacts.bytes(user, artifactId)
      res.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        'content-length': String(bytes.length), 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' })
      res.end(bytes)
      return
    }
    if (path === '/skills/upload') {
      if (req.headers.origin !== config.hostOrigin) throw new PlatformError(403, 'invalid_origin')
      res.setHeader('access-control-allow-origin', config.hostOrigin)
      res.setHeader('vary', 'Origin')
      res.setHeader('cache-control', 'no-store')
      if (req.method === 'OPTIONS') {
        if (req.headers['access-control-request-method'] !== 'POST') throw new PlatformError(405, 'method_not_allowed')
        res.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '300' })
        res.end()
        return
      }
      if (req.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
      if (req.headers['content-type'] !== 'application/zip') throw new PlatformError(415, 'invalid_content_type')
      const uploaded = await skills.upload(bearer(req), req)
      sendJson(res, uploaded.item, uploaded.created ? 201 : 200)
      return
    }
    if (path === '/ssh/upload' || path === '/mcp/connections/upload') {
      if (req.headers.origin !== config.hostOrigin) throw new PlatformError(403, 'invalid_origin')
      res.setHeader('access-control-allow-origin', config.hostOrigin)
      res.setHeader('vary', 'Origin')
      res.setHeader('cache-control', 'no-store')
      if (req.method === 'OPTIONS') {
        if (req.headers['access-control-request-method'] !== 'POST') throw new PlatformError(405, 'method_not_allowed')
        res.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '300' })
        res.end()
        return
      }
      if (req.method !== 'POST') throw new PlatformError(405, 'method_not_allowed')
      if (req.headers['content-type'] !== 'application/octet-stream') throw new PlatformError(415, 'invalid_content_type')
      if (path === '/mcp/connections/upload') {
        if (!remoteMcp) throw new PlatformError(503, 'mcp_unavailable')
        sendJson(res, await remoteMcp.upload(bearer(req), req), 201)
      } else sendJson(res, await ssh.upload(bearer(req), req), 201)
      return
    }
    if (req.method !== 'POST') throw new PlatformError(404, 'not_found')
    if (path === '/model/v1/messages') {
      await proxyModel(tasks, {
        url: config.modelUrl, apiKey: modelKey.trim(), timeoutMs: config.modelTimeoutMs,
        maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxModelResponseBytes,
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
    if (path === '/devices/enroll') {
      const input = z.object({ code: z.string().min(24).max(128), name: z.string().trim().min(1).max(80),
        instanceId: z.uuid() }).strict().parse(await readJson(req, 4096))
      sendJson(res, await devices.enroll(input.code, input.name, input.instanceId)); return
    }
    const token = bearer(req)
    if (path.startsWith('/devices/agent/')) {
      const input = await readJson(req, config.maxRequestBytes)
      switch (path) {
        case '/devices/agent/directory': {
          const value = z.object({ label: z.string().trim().min(1).max(100) }).strict().parse(input)
          sendJson(res, await devices.directory(token, value.label)); return
        }
        case '/devices/agent/files/read': {
          const value = z.object({ directoryId: z.uuid(), path: z.string().min(1).max(512) }).strict().parse(input)
          sendJson(res, await devices.readCloud(token, value.directoryId, value.path)); return
        }
        case '/devices/agent/files/put': {
          const value = z.object({ directoryId: z.uuid(), requestId: z.uuid(),
            path: z.string().min(1).max(512), data: z.string().max(2_800_000) }).strict().parse(input)
          sendJson(res, await devices.putCloud(token, value.directoryId, value.requestId, value.path, value.data)); return
        }
        case '/devices/agent/jobs': {
          const value = z.object({ instanceId: z.uuid() }).strict().parse(input)
          sendJson(res, await devices.jobs(token, value.instanceId)); return
        }
        case '/devices/agent/claim': {
          const value = z.object({ instanceId: z.uuid(), executionId: z.uuid() }).strict().parse(input)
          sendJson(res, await devices.claim(token, value.instanceId, value.executionId)); return
        }
        case '/devices/agent/finish': {
          const value = z.object({ instanceId: z.uuid(), executionId: z.uuid(), result: z.object({
            state: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain']), exitCode: z.number().int().nullable(),
            stdout: z.string().max(65_536), stderr: z.string().max(65_536),
            stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(), timedOut: z.boolean(),
          }).strict() }).strict().parse(input)
          sendJson(res, await devices.finish(token, value.instanceId, value.executionId, value.result)); return
        }
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path.startsWith('/approvals/')) {
      if (req.headers.origin !== undefined && req.headers.origin !== config.platformOrigin) throw new PlatformError(403, 'invalid_origin')
      const user = await identities.authenticate(token, 'approval')
      const input = await readJson(req, 4096)
      if (path.startsWith('/approvals/mcp/')) {
        sendJson(res, await routeMcpApproval(remoteMcpActions, path, user, input, token)); return
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
          const value = z.object({ actionId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), approve: z.boolean() }).strict().parse(input)
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
          sendJson(res, await sshExecute.cancel(user, sshExecuteRefRequest.parse(input).actionId)); return
        }
        case '/approvals/logout': z.object({}).strict().parse(input); await identities.logout(token); sendJson(res, { ok: true }); return
        default: throw new PlatformError(404, 'not_found')
      }
    }
    if (path === '/runtime/claim') {
      const expected = Buffer.from(workerToken.trim())
      const supplied = Buffer.from(token)
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new PlatformError(401, 'unauthorized_worker')
      const input = z.object({ workerId: z.uuid() }).strict().parse(await readJson(req, 4096))
      const claimed = await tasks.claim(input.workerId)
      sendJson(res, claimed); return
    }
    if (path.startsWith('/runtime/')) {
      const input = await readJson(req, config.maxRequestBytes)
      switch (path) {
        case '/runtime/snapshot': z.object({}).strict().parse(input); sendJson(res, await events.runtimeSnapshot(token)); return
        case '/runtime/append': sendJson(res, await events.append(token, z.object({ events: z.array(z.json()).max(256) }).strict().parse(input).events)); return
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
        case '/runtime/executions/propose': {
          if (!executions) throw new PlatformError(503, 'execution_unavailable')
          const value = z.object({ callId: z.string().min(1).max(100), command: z.string().min(1).max(8192),
            cwd: z.string().max(256).regex(/^(?:|[A-Za-z0-9._/-]{1,256})$/) }).strict().parse(input)
          if (value.cwd.split('/').some(part => part === '..')) throw new PlatformError(400, 'invalid_cwd')
          sendJson(res, await executions.propose(token, value.callId, value.command, value.cwd)); return
        }
        case '/runtime/desktop-executions/propose': {
          const value = z.object({ callId: z.string().min(1).max(100), command: z.string().min(1).max(8192),
            cwd: z.string().max(256).regex(/^(?:|[A-Za-z0-9._/-]{1,256})$/) }).strict().parse(input)
          if (value.cwd.split('/').some(part => part === '..')) throw new PlatformError(400, 'invalid_cwd')
          sendJson(res, await devices.propose(token, value.callId, value.command, value.cwd)); return
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
    const input = await readJson(req, config.maxRequestBytes)
    if (path.startsWith('/mcp/connections/')) {
      sendJson(res, await routeMcpManagement(remoteMcp, path, user, input, config.platformOrigin)); return
    }
    if (path === '/mcp/actions/status' || path === '/mcp/actions/cancel') {
      if (!remoteMcpActions) throw new PlatformError(503, 'mcp_unavailable')
      const value = z.object({ actionId: mcpActionId }).strict().parse(input)
      sendJson(res, path === '/mcp/actions/status' ? await remoteMcpActions.status(user, value.actionId)
        : await remoteMcpActions.cancel(user, value.actionId)); return
    }
    const fileWorkspace = async (session: string): Promise<string> => {
      const result = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM pe_sessions WHERE id=$1 AND user_id=$2', [session, user.userId],
      )
      if (!result.rows[0]) throw new PlatformError(404, 'session_not_found')
      return result.rows[0].workspace_id
    }
    switch (path) {
      case '/files/download/prepare': {
        const request = fileDownloadPrepareRequest.parse(input)
        const abort = new AbortController()
        res.once('close', () => abort.abort())
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
        sendJson(res, await sshExecute.cancel(user, sshExecuteRefRequest.parse(input).actionId)); return
      }
      case '/sessions/create': {
        const value = createRequest.parse(input)
        await skills.ensurePreinstalled(user, config.preinstalledSkills)
        sendJson(res, await tasks.create(user, value.requestId, token, value.workspaceId)); return
      }
      case '/sessions/list': {
        const { offset, limit } = listRequest.parse(input)
        sendJson(res, await tasks.list(user, offset, limit)); return
      }
      case '/sessions/prompt': {
        const { sessionId, requestId, text, target } = promptRequest.parse(input)
        await skills.ensurePreinstalled(user, config.preinstalledSkills)
        sendJson(res, await tasks.accept(user, sessionId, requestId, text, token, target)); return
      }
      case '/sessions/cancel': {
        const { sessionId } = sessionRequest.parse(input)
        sendJson(res, await tasks.cancel(user, sessionId, token)); return
      }
      case '/sessions/page': {
        const { sessionId, after, limit } = pageRequest.parse(input)
        sendJson(res, await events.page(user, sessionId, after, limit)); return
      }
      case '/native/sessions/list': {
        z.object({}).strict().parse(input)
        sendJson(res, await nativeSessions.list(user)); return
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
        sendJson(res, await nativeWorkspaces.create(user, value.requestId, value.title, value.target)); return
      }
      case WORKSPACE_BINDING_ROUTES.storageSpaces: {
        z.object({}).strict().parse(input)
        sendJson(res, await files.bindings.spaces(user)); return
      }
      case WORKSPACE_BINDING_ROUTES.storageDirectories: {
        sendJson(res, await files.bindings.directories(user, storageDirectoriesRequest.parse(input))); return
      }
      case WORKSPACE_BINDING_ROUTES.storageDirectoryCreate: {
        sendJson(res, await files.bindings.createDirectory(user, storageDirectoryCreateRequest.parse(input), token)); return
      }
      case WORKSPACE_BINDING_ROUTES.workspaceBindingsMissing: {
        z.object({}).strict().parse(input)
        sendJson(res, await files.bindings.missing(user)); return
      }
      case WORKSPACE_BINDING_ROUTES.workspaceBindingRestore: {
        sendJson(res, await files.bindings.restore(user, workspaceBindingRestoreRequest.parse(input), token)); return
      }
      case WORKSPACE_BINDING_ROUTES.workspaceBindingStatus: {
        sendJson(res, await files.bindings.status(user, workspaceBindingStatusRequest.parse(input))); return
      }
      case '/artifacts/publish': {
        const value = artifactPublishRequest.parse(input)
        sendJson(res, await artifacts.publish(user, value.requestId, value.sessionId, value.path, value.expectedRevision)); return
      }
      case EXECUTION_FILES_PLATFORM_PATH: {
        sendJson(res, await executionFiles.read(user, executionFilesRequest.parse(input))); return
      }
      case '/artifacts/list': {
        const value = z.object({ workspaceId: z.uuid().optional(), sessionId: z.uuid().optional(),
          cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(50) }).strict().parse(input)
        sendJson(res, await artifacts.list(user, value)); return
      }
      case '/artifacts/preview': {
        const value = z.object({ artifactId: z.uuid() }).strict().parse(input)
        sendJson(res, await artifacts.preview(user, value.artifactId)); return
      }
      case '/native/sessions/page': {
        sendJson(res, await nativeSessions.page(user, nativePageRequest.parse(input))); return
      }
      case '/native/sessions/snapshot': {
        sendJson(res, await nativeSessions.snapshot(user, nativeFollowRequest.parse(input))); return
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
        sendJson(res, await files.put(user, value.requestId, value.path, value.baseRevision, value.data,
          await fileWorkspace(value.sessionId))); return
      }
      case '/files/list': sendJson(res, await files.list(user, filesListRequest.parse(input).directory)); return
      case '/files/read': sendJson(res, await files.read(user, fileReadRequest.parse(input).path)); return
      case '/files/put': {
        const value = filePutRequest.parse(input)
        sendJson(res, await files.put(user, value.requestId, value.path, value.baseRevision, value.data)); return
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
        const desktop = await devices.executions(user) as { items: Array<Record<string, unknown>> }
        sendJson(res, { items: [...cloudItems.map(item => ({ ...item, target: { kind: 'cloud' }, createdAt: String(item.createdAt) })),
          ...desktop.items.map(item => ({ ...item, createdAt: String(item.createdAt) }))]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) }); return
      }
      case '/executions/cancel': {
        const value = z.object({ executionId: z.uuid() }).strict().parse(input)
        if (executions) {
          try { sendJson(res, await executions.cancel(user, value.executionId)); return }
          catch (error) { if (!(error instanceof PlatformError && error.status === 404)) throw error }
        }
        sendJson(res, await devices.cancel(user, value.executionId)); return
      }
      case '/devices/list': z.object({}).strict().parse(input); sendJson(res, await devices.list(user)); return
      case '/devices/pair': z.object({}).strict().parse(input); sendJson(res, await devices.pair(user, token)); return
      case '/devices/revoke': {
        const value = z.object({ deviceId: z.uuid() }).strict().parse(input)
        await devices.revoke(user, value.deviceId); sendJson(res, { ok: true }); return
      }
      case '/devices/directories/revoke': {
        const value = z.object({ directoryId: z.uuid() }).strict().parse(input)
        await devices.revokeDirectory(user, value.directoryId); sendJson(res, { ok: true }); return
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
