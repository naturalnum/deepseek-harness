/** Cloud STDIO composition over the existing owner-scoped task, file and Sandbox services. */
import type { Pool } from 'pg'
import type { StdioWorkerIdV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioManagementSchemasV2 } from '@power-evolve/contracts/stdio-management'
import type { FileService } from './files.ts'
import type { NativeExecutionPlatform } from './native-execution-platform.ts'
import { StdioNativeCloudV2 } from './stdio-v2-native-cloud.ts'
import type { SandboxManager } from './sandbox.ts'
import type { TaskStore } from './tasks.ts'
import type { StdioPlatformConfigV2 } from './stdio-v2-platform-config.ts'
import type { StdioOperationAdmissionV2 } from './stdio-v2-operation-admission.ts'
import { StdioConnectionServiceV2 } from './stdio-v2-connections.ts'
import { StdioAdmissionServiceV2 } from './stdio-v2-admission.ts'
import { StdioCallAdmissionV2 } from './stdio-v2-call-admission.ts'
import { StdioCloudPreparationV2 } from './stdio-v2-cloud-capture.ts'
import { StdioAuthorizationServiceV2 } from './stdio-v2-authorization.ts'
import { StdioCallContinuationV2 } from './stdio-v2-continuations.ts'
import { StdioResultServiceV2 } from './stdio-v2-results.ts'
import { StdioCloudWorkerStoreV2 } from './stdio-v2-worker-store.ts'
import { StdioCloudRunTransportV2 } from './stdio-v2-cloud-runtime.ts'
import { StdioCloudWorkerV2 } from './stdio-v2-cloud-worker.ts'
import { StdioActionServiceV2 } from './stdio-v2-actions.ts'
import { StdioEnvironmentService } from './stdio-environment.ts'
import { stdioEnvironmentOptions } from '@power-evolve/contracts/stdio-environment'
import { PRODUCT_MODEL_TOOL_NAMES } from '../mcp-model-tools.ts'

/** Product tool names excluded from generic catalogs; original remote MCP names are added by TaskStore. */
export const STDIO_PRODUCT_RESERVED_NAMES_V2: readonly string[] = PRODUCT_MODEL_TOOL_NAMES

/** Platform-owned Cloud services; the caller starts and drains the worker under its process lifecycle. */
export interface StdioCloudServicesV2 {
  readonly connections: StdioConnectionServiceV2
  readonly actions: StdioActionServiceV2
  readonly discovery: StdioAdmissionServiceV2
  readonly calls: StdioCallAdmissionV2
  readonly authorization: StdioAuthorizationServiceV2
  readonly worker: StdioCloudWorkerV2
  readonly environment: StdioEnvironmentService
  /** Join action workers, then recycle every retained idle native preparation. */
  close(): Promise<void>
  readonly requests: ReturnType<typeof stdioManagementSchemasV2>
}

/** Compose one Cloud worker without claiming work or performing any Kubernetes/Runner request.
 * @param pool Platform-owned database pool; worker shutdown must settle before it closes.
 * @param tasks TaskStore already configured with this same frozen selection provider and reserved names.
 * @param selection Original complete selection provider shared by acceptance, recovery and call admission.
 * @param files Owner-scoped persistent Workspace and Home bindings.
 * @param sandboxes Existing manager configured with the same operator Runner limits and reply budget.
 * @param config Validated Platform-private settings and approval key; only Runner budgets enter its Secret.
 * @param workerId This Platform instance's authenticated durable worker identity.
 * @param native Shared physical native provider; production STDIO requires its independently leased action adapter.
 * @returns Management, admission and approval services plus an unstarted worker; results and no-start share one continuation producer.
 */
export function createStdioCloudServicesV2(pool: Pool, tasks: TaskStore, selection: StdioOperationAdmissionV2,
  files: FileService, sandboxes: SandboxManager, config: StdioPlatformConfigV2, workerId: StdioWorkerIdV2,
  native?: NativeExecutionPlatform): StdioCloudServicesV2 {
  const { settings, approvalKey } = config
  const { limits, admission, management, maxReplyBytes, cloudDeployment } = settings
  const environment = new StdioEnvironmentService(pool, approvalKey, limits, stdioEnvironmentOptions.parse(settings.environment ?? {}))
  const connections = new StdioConnectionServiceV2(pool, limits, management)
  const actions = new StdioActionServiceV2(pool, { limits, maxReplyBytes, maxPageSize: management.pageItems })
  const discovery = new StdioAdmissionServiceV2(pool, files, {
    limits, management, maxPendingPerUser: settings.maxPendingPerUser,
    deployments: { cloud: cloudDeployment },
  })
  const calls = new StdioCallAdmissionV2(tasks, selection, files, {
    limits, cloudDeployment, maxPendingPerUser: settings.maxPendingPerUser,
    maxCallsPerChain: settings.maxCallsPerChain, chainLifetimeMs: settings.chainLifetimeMs,
    reservedNames: STDIO_PRODUCT_RESERVED_NAMES_V2,
  })
  let nativeAdapter: StdioNativeCloudV2 | undefined
  const requireNative = () => {
    if (!nativeAdapter) throw new Error('Native STDIO adapter is not initialized')
    return nativeAdapter
  }
  const continuation = new StdioCallContinuationV2({ limits, admission, maxReplyBytes })
  const store = new StdioCloudWorkerStoreV2(pool, { limits, ...settings.worker, continuation,
    ...(native ? { nativeResources: {
      ready: (client, task, ready) => requireNative().ready(client, task, ready),
      noStart: (client, task) => requireNative().noStart(client, task),
    } } : {}) })
  if (native) nativeAdapter = new StdioNativeCloudV2(pool, native.service(store.nativeServiceLease, approvalKey), store, maxReplyBytes)
  const preparation = nativeAdapter ?? new StdioCloudPreparationV2(sandboxes)
  const authorization = new StdioAuthorizationServiceV2(pool, {
    limits, approvalKey, approvalLifetimeMs: settings.approvalLifetimeMs,
    capture: (client, task, ref) => preparation.capture(client, task, ref),
  })
  const results = new StdioResultServiceV2(pool, { limits, maxReplyBytes, continuation,
    ...(nativeAdapter ? { assertStopped: (client, task, uid) => requireNative().assertStopped(client, task, uid) } : {}) })
  const transport = nativeAdapter ?? new StdioCloudRunTransportV2(sandboxes, { limits, maxReplyBytes, ...settings.transport })
  const worker = new StdioCloudWorkerV2(store, authorization, sandboxes, transport, results,
    { workerId, ...settings.worker, environment: (lease, dispatch, signal) => environment.readForWorker({ lease, dispatch }, signal),
      ...(nativeAdapter ? { nativeResources: nativeAdapter, concurrency: settings.worker.maxActive } : {}) })
  return { connections, actions, discovery, calls, authorization, worker, environment,
    async close() { nativeAdapter?.interrupt(); try { await worker.stop() } finally { await nativeAdapter?.dispose() } },
    requests: stdioManagementSchemasV2(limits, management) }
}
