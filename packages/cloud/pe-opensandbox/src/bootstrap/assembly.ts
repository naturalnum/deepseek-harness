/** Private original-CLI deployment preparation; Root owns coordinator/effect ordering around this construction promise. */
import type { ManagedCoordinatorConfig, ManagedExecutionDeployment } from '../managed-coordinator.ts'
import { createRetainedExecutionExports, type RetainedExecutionExports } from '../export-share.ts'
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
   * Close after coordinator.closeRoot actually settles; retain selection/observer on any SDK or share uncertainty.
   * @returns The same actual SDK, global-share check, observer and file-close settlement.
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
 * Prepare the original private Root selection, actual FD4 keeper, retained share and SDK owners without any Sandbox create.
 * @param reference Explicit protected Root path/SHA; Root apply rejects account graphs and closed mode before this call.
 * @param limits Existing parsed coordinator limits, checked against the protected deployment capacities.
 * @returns Original deployment plus one actual close operation; Root must retain the pending construction through disposal.
 * @throws On protected input, actual keeper or construction failure; private cause retains uncertain startup cleanup ownership.
 */
export async function assembleRootExecutionDeployment(reference: RootDeploymentReference,
  limits: ManagedCoordinatorConfig): Promise<RootExecutionAssembly> {
  if (process.platform !== 'linux' || process.getuid?.() !== 2000 || process.getgid?.() !== 2000) {
    throw new ExecutionStateError('cloud/invalid-config', 'Root execution assembly requires the original non-root Linux CLI.')
  }
  const state: {
    selection?: RootDeploymentLease
    manifest?: RootDeploymentLease
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
      state.manifest?.close()
      state.selection?.close()
    }
    void finish().then(closed.resolve, closed.reject)
    return closed.promise
  }
  try {
    state.selection = readRootDeploymentReference(reference)
    const selection = state.selection, input = parseRootDeploymentInput(selection.value())
    if (input.lifecycle.environmentVersion !== limits.allocations.environmentVersion
      || input.lifecycle.provider !== limits.allocations.provider
      || input.lifecycle.maxRecords < limits.allocations.maxAllocations
      || input.exports.limits.maxShares < limits.allocations.maxAllocations) unavailable()
    state.manifest = new RootDeploymentLease(input.exports.manifest, input.exports.limits.maxManifestBytes, 'export-manifest')
    const manifest = state.manifest, bytes = manifest.bytes()
    const publicationCurrent = (): void => { selection.assertCurrent(); manifest.assertCurrent() }
    state.keeper = adoptExportKeeperLive(keeperInput(manifest.value(), input.exports.manifest.sha256, publicationCurrent))
    const keeper = state.keeper
    await keeper.ready
    state.exports = createRetainedExecutionExports(bytes, input.exports.manifest.sha256, keeper, input.exports.limits)
    const exports = state.exports
    state.owner = await createRootSdkExecutionOwner({ ...input.bootstrap, lifecycle: input.lifecycle,
      // Original selection/policy only. Business/keeper loss must not revoke physical-stop authority.
      assertDeploymentCurrent: () => { selection.assertCurrent() } })
    const owner = state.owner
    const deployment: ManagedExecutionDeployment = Object.freeze({ backend: owner.backend, runtimes: owner.runtimes,
      share: exports.share, assertEpochReleased: exports.assertEpochReleased,
      assertCurrent(): void {
        if (state.closing !== undefined) unavailable()
        publicationCurrent(); exports.assertCurrent()
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
