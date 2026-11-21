/** Actual managed Root, allocation owner, PostgreSQL driver and private SDK HTTP; guest and Files are fixtures. */
import { Context } from '@deepseek-ai/cordis'
import { readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AccountBinding, AccountRuntimeService, RootMetadataDatabase } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { expect, it } from 'vitest'
import { PgOwnerExecutor } from '../../pe-cloud-runtime/src/owner-pg-executor.ts'
import type { NativeAllocationRequest, SessionAllocationOwner } from '../src/allocation-owner.ts'
import type { OwnedSdkTransport, SdkLifecycleConfig, TrustedAgentLifecycle, VerifiedExecutionMount } from '../src/lifecycle-types.ts'
import { ManagedCoordinator, type ManagedCoordinatorConfig, type ManagedExecutionDeployment } from '../src/managed-coordinator.ts'
import { SdkAllocationBackend } from '../src/sdk-lifecycle.ts'
import { createOwnedSdkTransport } from '../src/sdk-transport.ts'

const pgPath = process.env['DSH_S08_ROOT_PG_FIXTURE']
const sdkPath = process.env['DSH_S08_ROOT_SDK_FIXTURE']
const normalClose = process.env['DSH_S08_ROOT_NORMAL_CLOSE_ONLY'] === '1'
const fixtureAvailable = pgPath !== undefined && sdkPath !== undefined
const recoverExisting = process.env['DSH_S08_ROOT_RECOVER_ONLY'] === '1'
const config: ManagedCoordinatorConfig = {
  maxBoundAccounts: 2, maxActiveCommands: 2, maxActiveCommandsPerAccount: 1,
  maxResidentCommands: 4, maxResidentCommandsPerAccount: 2, maxResidentBytes: 262144, maxResidentBytesPerAccount: 131072,
  maxStopObservers: 2, stopWaitBudgetMs: 4000, recoveryPageSize: 2,
  allocations: { environmentVersion: 'env-v1', provider: 'fixture-docker', createBudgetMs: 4500,
    maxAllocations: 2, maxAllocationsPerAccount: 1, maxWaiters: 4, maxWaitersPerAllocation: 2 },
  store: { maxFieldBytes: 256, maxInputBytes: 65536, maxRowBytes: 4096, maxResultBytes: 16384,
    maxRows: 4, maxCapabilities: 5, maxPendingQueries: 2, maxMutationResponsibilities: 2, maxRetainedBytes: 262144 },
  commands: { allowedTools: ['bash'], maxScopes: 2,
    commandLimits: { maxArgvBytes: 4096, maxArgvEntries: 16, maxPathBytes: 512, maxStdinBytes: 4096,
      maxTailBytes: 32, maxObservedBytes: 65536, pollIntervalMs: 1, maxWaiters: 2, maxLifetimeMs: 1000, stopWaitMs: 100 } },
  shell: { bashPath: '/bin/bash', timeoutMs: 20, maxTimeoutMs: 100, maxOutputBytes: 32, graceMs: 10 },
}

async function row(executor: PgOwnerExecutor, sessionId: string) {
  const { rows } = await executor.query(`SELECT a.state,a.sandbox_id,b.container_id,b.provider_generation,b.policy_digest,
    r.receipt_digest,r.pending_slot FROM public.pe_sandbox_allocations a
    LEFT JOIN public.pe_sandbox_allocation_bindings_v1 b USING (allocation_id)
    LEFT JOIN public.pe_sandbox_deletion_receipts_v1 r USING (allocation_id) WHERE a.session_id=$1`, [sessionId])
  return rows[0]
}

function originalRequest(index: number, account: AccountBinding, onRelease: () => void): NativeAllocationRequest<VerifiedExecutionMount> {
  const sessionId = `fixture-session-${index}` as NativeAllocationRequest<VerifiedExecutionMount>['sessionId']
  const workspaceId = 'fixture-workspace' as NativeAllocationRequest<VerifiedExecutionMount>['workspaceId']
  const grant = { binding: account, sessionId, workspaceId, project: { mountVersion: 'fixture-mount', rootPath: '/fixture/project' },
    environment: { environmentVersion: config.allocations.environmentVersion, targetPath: '/opt/session-env' } } as VerifiedExecutionMount['grant']
  const value = { grant, exports: { project: '/fixture/project', protectedProject: '/fixture/project/.pe',
    environment: '/fixture/environment' }, assertCurrent() {} }
  return { binding: account, sessionId, workspaceId, assertCurrent() {},
    async prepareMount() { return { value, projectMountVersion: 'fixture-mount', release: onRelease, assertCurrent() {} } } }
}

async function exerciseRootReceiptFixture(mode: 'normal-close' | 'recovery') {
  if (pgPath === undefined || sdkPath === undefined) throw new Error('private fixtures required')
  const pg = await realpath(pgPath), sdk = await realpath(sdkPath)
  expect(basename(pg)).toMatch(/^pe-s08-root-pg\.[A-Za-z0-9]+$/u)
  expect(basename(sdk)).toMatch(/^sdk-s08-run\.[A-Za-z0-9]+$/u)
  for (const privateDir of [pg, sdk, join(pg, 'socket'), join(pg, 'data')]) {
    const info = await stat(privateDir)
    expect(info.mode & 0o777).toBe(0o700)
    expect(info.uid).toBe(process.getuid?.())
  }
  expect((await readFile(join(pg, 'fixture-owner'), 'utf8')).trim()).toBe('S08 Root composition fixture')
  const port = (await readFile(join(sdk, 'sdk-port'), 'utf8')).trim()
  expect(port).toMatch(/^[1-9][0-9]{1,4}$/u)
  const executor = new PgOwnerExecutor({ host: join(pg, 'socket'), port: 55490, user: 'pe_s08_root_fixture',
    database: 'postgres', password: 'local-synthetic-fixture', ssl: false }, {
    maxConnections: 2, maxQueued: 3, queueTimeoutMs: 1200, connectionTimeoutMs: 1200,
    lockTimeoutMs: 1000, statementTimeoutMs: 3000, maxObservedOperations: 3, maxObservers: 3,
  })
  const fact = await executor.query("SELECT inet_server_addr() AS host, current_setting('data_directory') AS path, current_user AS role", [])
  const selected = fact.rows[0] as { host: string | null; path: string; role: string }
  expect(selected).toMatchObject({ host: null, role: 'pe_s08_root_fixture' })
  expect(await realpath(selected.path)).toBe(join(pg, 'data'))
  const lifecycle: SdkLifecycleConfig = {
    lifecycleBaseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'only-synthetic-original-control-key',
    deploymentIdentity: 'receipt-root-fixture', environmentVersion: config.allocations.environmentVersion,
    provider: config.allocations.provider, imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64),
    entrypoint: ['/usr/bin/tail', '-f', '/dev/null'], platform: 'arm64', cpuCores: 1, memoryMiB: 128, ttlSeconds: 120,
    requestTimeoutMs: 1200, stopBudgetMs: 2500, readyPollIntervalMs: 10, maxReadyPolls: 2,
    pageSize: 2, maxPages: 2, maxItems: 4, maxRecords: 4, maxInflightOperations: 8,
    maxRequestBytes: 8192, maxResponseBytes: 8192, maxOperationBytes: 32768, maxFieldBytes: 256,
    deletionReceipts: { providerGeneration: 'a'.repeat(64), policyDigest: 'b'.repeat(64) },
  }
  const account: AccountBinding = { accountId: 'fixture-account' as AccountBinding['accountId'], epoch: '1' as AccountBinding['epoch'],
    recipeVersion: 'fixture-1', lifetime: new AbortController().signal }
  let physicalStops = 0, mountReleases = 0, stoppedBeforeProvider = 0, shutdownAcks = 0
  const agent: TrustedAgentLifecycle = {
    async handshake(selection) {
      return { sandboxId: selection.sandboxId, runtimeIdentity: 'fixture-runtime', protocolVersion: 'fixture/1',
        capabilities: ['argv-collect'], payloadSha256: selection.payloadSha256,
        imageDigest: selection.imageDigest, deploymentIdentity: selection.deploymentIdentity }
    },
    fenceRequests(selection) {
      const joined = row(executor, selection.intent.sessionId).then((state) => {
        expect(state).toMatchObject({ state: 'stopping' })
        stoppedBeforeProvider++
      })
      return { sandboxId: selection.sandboxId, deploymentIdentity: selection.deploymentIdentity,
        whenPrivilegedStartsJoined: joined, whenJoined: joined, assertDeploymentCurrent() {} }
    },
    acknowledgePhysicalStop() { physicalStops++; return undefined },
  }
  const database: RootMetadataDatabase = { query: (sql, values) => executor.query(sql, values), wasNotSubmitted: () => false }
  const coordinators: ManagedCoordinator[] = []
  function startOwner(loseAck = false) {
    const transport = createOwnedSdkTransport({ connections: 1, connectTimeoutMs: 1000, headersTimeoutMs: 1200,
      bodyTimeoutMs: 1200, keepAliveTimeoutMs: 1000, maxHeaderBytes: 4096, maxRequestBytes: 8192, maxResponseBytes: 8192 })
    let pendingLoss = loseAck
    const wire: OwnedSdkTransport = { close: () => transport.close(), fetch: async (request, options) => {
      if (mode === 'normal-close' && request instanceof Request && request.url.endsWith('/deletion-receipt/ack')) {
        expect(await row(executor, 'fixture-session-1')).toMatchObject({ state: 'released', pending_slot: 1 })
        shutdownAcks++
      }
      const response = await transport.fetch(request, options)
      if (pendingLoss && request instanceof Request && request.url.endsWith('/deletion-receipt/ack')) {
        pendingLoss = false
        expect(response.status).toBe(200)
        throw new Error('fixture discarded committed SDK ACK')
      }
      return response
    } }
    const backend = new SdkAllocationBackend(lifecycle, agent, wire, () => {})
    const runtime: Pick<AccountRuntimeService, 'registerDrainParticipant' | 'controlDatabase' | 'singleInstanceActive'> = {
      singleInstanceActive: true, registerDrainParticipant: () => () => {}, controlDatabase: () => database,
    }
    const deployment: ManagedExecutionDeployment = {
      backend, runtimes: { bindPrepared: value => value } as ManagedExecutionDeployment['runtimes'],
      assertCurrent() {}, async share() { throw new Error('fixture supplies only its original mount') }, assertEpochReleased() {},
    }
    const coordinator = new ManagedCoordinator(new Context(), runtime, config, deployment)
    coordinators.push(coordinator)
    // Exercise the exact allocation owner constructed by the actual Root coordinator.
    const { allocations } = coordinator as unknown as { allocations: SessionAllocationOwner<VerifiedExecutionMount> }
    return { coordinator, allocations }
  }

  try {
    if (mode === 'normal-close') {
      const request = originalRequest(1, account, () => { mountReleases++ })
      const owner = startOwner()
      await owner.coordinator.start()
      owner.coordinator.assertReady()
      const prepared = await owner.allocations.prepare(request)
      expect(await row(executor, request.sessionId)).toMatchObject({ state: 'ready', sandbox_id: prepared.sandboxId })

      await owner.coordinator.closeRoot()

      expect(await row(executor, request.sessionId)).toMatchObject({ state: 'released', sandbox_id: prepared.sandboxId,
        receipt_digest: expect.stringMatching(/^[0-9a-f]{64}$/u), pending_slot: null })
      expect((await readFile(join(sdk, 'removes'), 'utf8')).trim().split('\n')).toEqual([prepared.sandboxId])
      expect(stoppedBeforeProvider).toBe(1)
      expect(shutdownAcks).toBe(1)
      expect(physicalStops).toBe(1)
      expect(mountReleases).toBe(1)
      return
    }
    if (recoverExisting) {
      const before = await row(executor, 'fixture-session-2') as { sandbox_id: string }
      expect(before).toMatchObject({ state: 'stopping', receipt_digest: null })
      await unlink(join(sdk, 'suppress-terminal'))
      const recovery = startOwner()
      await recovery.coordinator.start()
      recovery.coordinator.assertReady()
      expect(await row(executor, 'fixture-session-2')).toMatchObject({ state: 'released',
        receipt_digest: expect.stringMatching(/^[0-9a-f]{64}$/u), pending_slot: null })
      expect((await readFile(join(sdk, 'removes'), 'utf8')).trim().split('\n').filter(sid => sid === before.sandbox_id))
        .toHaveLength(1)
      console.log('Fresh application process recovered the exact stopping allocation through provider terminal and ACK.')
      await recovery.coordinator.closeRoot()
      return
    }
    const request = originalRequest(1, account, () => { mountReleases++ })
    const original = startOwner(true)
    await original.coordinator.start()
    original.coordinator.assertReady()
    const prepared = await original.allocations.prepare(request)
    expect(await row(executor, request.sessionId)).toMatchObject({ state: 'ready', sandbox_id: prepared.sandboxId,
      container_id: expect.stringMatching(/^[0-9a-f]{64}$/u), provider_generation: 'a'.repeat(64), policy_digest: 'b'.repeat(64) })
    await original.allocations.stop(request)
    expect(await row(executor, request.sessionId)).toMatchObject({ state: 'released',
      receipt_digest: expect.stringMatching(/^[0-9a-f]{64}$/u), pending_slot: 1 })
    expect(physicalStops).toBe(1)
    expect(mountReleases).toBe(1)
    await original.coordinator.closeRoot()

    const restarted = startOwner()
    await restarted.coordinator.start()
    restarted.coordinator.assertReady()
    expect(await row(executor, request.sessionId)).toMatchObject({ state: 'released', pending_slot: null })
    expect((await readFile(join(sdk, 'removes'), 'utf8')).trim().split('\n')).toEqual([prepared.sandboxId])

    const uncertain = originalRequest(2, account, () => { mountReleases++ })
    await restarted.allocations.prepare(uncertain)
    await writeFile(join(sdk, 'suppress-terminal'), '')
    await expect(restarted.allocations.stop(uncertain)).rejects.toMatchObject({ code: 'sdk/stop-unknown' })
    expect(await row(executor, uncertain.sessionId)).toMatchObject({ state: 'stopping', receipt_digest: null })
    expect(physicalStops).toBe(1)
    expect(mountReleases).toBe(1)
    expect(stoppedBeforeProvider).toBe(2)
  } finally {
    await Promise.allSettled(coordinators.map(owner => owner.closeRoot()))
    await executor.close()
  }
}

it.runIf(fixtureAvailable && normalClose)('settles and acknowledges the original ready allocation during normal Root shutdown',
  () => exerciseRootReceiptFixture('normal-close'), 25000)

it.runIf(fixtureAvailable && !normalClose)('starts actual Root and settles original ready, stopping, terminal and replayed ACK',
  () => exerciseRootReceiptFixture('recovery'), 25000)
