/** Private CLI deployment preparation; Root owns coordinator/effect ordering around this construction promise. */
import type { ManagedCoordinatorConfig, ManagedExecutionDeployment } from '../managed-coordinator.ts'
import { createRetainedExecutionExports, createSharedPathExecutionExports, type RetainedExecutionExports } from '../export-share.ts'
import { ExecutionStateError } from '../errors.ts'
import { adoptExportKeeperLive, type ExportKeeperLive, type ExportKeeperLiveInput } from './keeper-live.ts'
import { readRootDeploymentReference, RootDeploymentLease, type RootDeploymentReference } from './deployment-reference.ts'
import { parseRootDeploymentInput } from './deployment-input.ts'
import { createRootSdkExecutionOwner, type RootSdkExecutionOwner } from './factory.ts'
import { BootstrapFailure } from './bootstrap.ts'

/** Only the original Root caller may retain this assembly; it provides no Loader/account configuration entry. */
export interface RootExecutionAssembly {
  readonly deployment: ManagedExecutionDeployment
  /**
   * Close after coordinator.closeRoot actually settles; retain storage leases on any SDK or share uncertainty.
   * @returns The same SDK/share settlement, legacy observer cleanup when selected, and protected file closure.
   */
  closeActual(): Promise<void>
}
function unavailable(): never {
  throw new ExecutionStateError('cloud/execution-unavailable', 'The original Root execution deployment is unavailable or closing.')
}
function keeperInput(value: unknown, digest: string, assertManifestCurrent: () => void): ExportKeeperLiveInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable()
  const record = value as Record<string, unknown>, live = record.liveness
  if (record.schema !== 'root-daemon-exports-v1' || typeof record.runId !== 'string' || !/^[a-f0-9]{32}$/.test(record.runId)
    || live === null || typeof live !== 'object' || Array.isArray(live)) return unavailable()
  const fields = live as Record<string, unknown>
  if (fields.kind !== 'inherited-fifo-v1' || fields.frameBytes !== 128 || typeof fields.nonce !== 'string'
    || !/^[a-f0-9]{64}$/.test(fields.nonce) || typeof fields.device !== 'string' || !/^\d{1,20}$/.test(fields.device)
    || typeof fields.inode !== 'string' || !/^\d{1,20}$/.test(fields.inode)) return unavailable()
  return { runId: record.runId, manifestSha256: digest, nonce: fields.nonce, device: fields.device, inode: fields.inode,
    assertManifestCurrent }
}

/**
 * Prepare protected storage and SDK owners without creating a sandbox; only legacy v1 adopts an FD4 keeper.
 * @param reference Explicit protected Root path/SHA; Root apply rejects account graphs and closed mode before this call.
 * @param limits Existing parsed coordinator limits, checked against the protected deployment capacities.
 * @returns Original deployment plus one actual close operation; Root must retain the pending construction through disposal.
 * @throws On protected input, storage/legacy keeper or construction failure; private cause retains startup cleanup ownership.
 */
export async function assembleRootExecutionDeployment(reference: RootDeploymentReference,
  limits: ManagedCoordinatorConfig): Promise<RootExecutionAssembly> {
  if (process.platform !== 'linux' || process.getuid?.() !== 2000 || process.getgid?.() !== 2000) {
    throw new ExecutionStateError('cloud/invalid-config', 'Root execution assembly requires the original non-root Linux CLI.')
  }
  const state: {
    selection?: RootDeploymentLease
    storageFile?: RootDeploymentLease
    keeper?: ExportKeeperLive
    exports?: RetainedExecutionExports
    owner?: RootSdkExecutionOwner
    closing?: Promise<void>
    startupCleanupFailure?: { readonly cause: unknown }
  } = {}
  const closeActual = (): Promise<void> => {
    if (state.closing !== undefined) return state.closing
    const closed = Promise.withResolvers<void>()
    state.closing = closed.promise
    const finish = async (): Promise<void> => {
      await state.owner?.backend.closeRootActual()
      if (state.exports !== undefined && state.exports.retainedShares !== 0) unavailable()
      // Root invokes this only after actual coordinator close; no cleanup lease is withdrawn on unknown stops/shares.
      await state.keeper?.closeObserver()
      state.storageFile?.close()
      state.selection?.close()
    }
    void finish().then(closed.resolve, closed.reject)
    return closed.promise
  }
  try {
    state.selection = readRootDeploymentReference(reference)
    const selection = state.selection, input = parseRootDeploymentInput(selection.value())
    const storageLimits = input.schema === 'pe-opensandbox-root-deployment-v1' ? input.exports.limits : input.storage.limits
    if (input.lifecycle.environmentVersion !== limits.allocations.environmentVersion
      || input.lifecycle.provider !== limits.allocations.provider
      || input.lifecycle.maxRecords < limits.allocations.maxAllocations
      || storageLimits.maxShares < limits.allocations.maxAllocations) unavailable()
    if (input.schema === 'pe-opensandbox-root-deployment-v1') {
      state.storageFile = new RootDeploymentLease(input.exports.manifest, input.exports.limits.maxManifestBytes, 'export-manifest')
      const manifest = state.storageFile, bytes = manifest.bytes()
      const publicationCurrent = (): void => { selection.assertCurrent(); manifest.assertCurrent() }
      state.keeper = adoptExportKeeperLive(keeperInput(manifest.value(), input.exports.manifest.sha256, publicationCurrent))
      const keeper = state.keeper
      await keeper.ready
      state.exports = createRetainedExecutionExports(bytes, input.exports.manifest.sha256, keeper, input.exports.limits)
    } else {
      state.storageFile = new RootDeploymentLease(input.storage.plan, input.storage.limits.maxPlanBytes, 'storage-plan')
      const plan = state.storageFile
      // Publication bytes only; share admission separately checks original files grants and live source mounts.
      const planCurrent = (): void => { selection.assertCurrent(); plan.assertCurrent() }
      state.exports = createSharedPathExecutionExports(plan.bytes(), input.storage.plan.sha256, planCurrent,
        input.storage.limits, input.selection.serverImageDigest)
      state.exports.assertCurrent()
    }
    const storageFile = state.storageFile
    const storageCurrent = (): void => { selection.assertCurrent(); storageFile.assertCurrent() }
    const exports = state.exports
    state.owner = await createRootSdkExecutionOwner({ ...input.bootstrap, lifecycle: input.lifecycle,
      // Original selection/policy only. Business/keeper loss must not revoke physical-stop authority.
      assertDeploymentCurrent: () => { selection.assertCurrent() } })
    const owner = state.owner
    const deployment: ManagedExecutionDeployment = Object.freeze({ backend: owner.backend, runtimes: owner.runtimes,
      share: exports.share, assertEpochReleased: exports.assertEpochReleased,
      ...(input.skillCopies === undefined ? {} : { skillCopies: input.skillCopies }),
      assertCurrent(): void {
        if (state.closing !== undefined) unavailable()
        storageCurrent(); exports.assertCurrent()
      } })
    deployment.assertCurrent()
    return Object.freeze({ deployment, closeActual })
  } catch (cause) {
    // No coordinator or remote allocation exists yet. The original cleanup remains retained even if startup rejects.
    const cleanupActual = closeActual()
    void cleanupActual.catch((closeCause: unknown) => { state.startupCleanupFailure ??= { cause: closeCause } })
    throw new BootstrapFailure('binding', Object.freeze({ kind: 'root-assembly-construction', cause, closeActual, cleanupActual }))
  }
}
