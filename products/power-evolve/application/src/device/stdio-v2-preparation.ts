/** Assemble private Device Prepared data from the original task and exact read-only Docker observations. */
import { z } from 'zod'
import type { DeviceProcessId } from '@power-evolve/contracts/device-execution'
import { ownedContainerReceipt } from '@power-evolve/contracts/device-execution'
import { stdioCaptureV2, stdioDeviceDeploymentV2, stdioExecutionRefV2, stdioJsonV2, stdioLimitsV2, stdioPreparedV2,
  stdioTaskSchemasV2, type StdioExecutionRefV2, type StdioPreparedV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioSha256V2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import type { OwnedContainerCaptureRequest, OwnedDeviceContainer } from './owned-container.ts'

const desktopCapture = stdioCaptureV2.options[1]
const privateRequest = z.object({ receipt: ownedContainerReceipt, pin: stdioDeviceDeploymentV2,
  workspaceMount: desktopCapture.shape.workspaceMount, homeMount: desktopCapture.shape.homeMount }).strict()

/** This assembler grants no path access or start authority; its caller authenticates the original journal/process. */
export class StdioDevicePreparationV2 {
  constructor(private readonly containers: Pick<OwnedDeviceContainer, 'captureContainer'>) {}

  /** Capture one original Device execution without creating, starting, stopping or adopting a container.
   * @param task Complete frozen task from the original admitted action, including its trusted limits.
   * @param executionRef Original desktop execution; it must match the private receipt's execution identity.
   * @param captureRequest Original journal receipt and locally authorized directory/Home bind expectations; these values do not themselves grant permission.
   * @param processId Original journal's authenticated Device process, validated here as an opaque ID; the caller establishes its identity.
   * @returns Private Prepared bound to the original task digest and complete adapter observations; no permit or writer-stop evidence is issued.
   */
  async capture(task: StdioTaskV2, executionRef: StdioExecutionRefV2, captureRequest: OwnedContainerCaptureRequest,
    processId: DeviceProcessId): Promise<StdioPreparedV2> {
    const limits = stdioLimitsV2.parse(task.limits)
    const original = stdioTaskSchemasV2(limits).task.parse(task), ref = stdioExecutionRefV2.parse(executionRef)
    const request = privateRequest.parse(captureRequest), process = desktopCapture.shape.processId.parse(processId)
    const budget = { maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes, maxBytes: limits.maxInputBytes }
    const taskDigest = stdioSha256V2('task', original, budget), scopeBinding = original.scopeBinding
    if (scopeBinding.kind !== 'desktop' || ref.kind !== 'desktop' || original.expectedDeploymentPin.kind !== 'desktop'
      || request.receipt.owner.executionId.toString() !== ref.executionId.toString()
      || request.receipt.owner.requestDigest.toString() !== taskDigest.toString()
      || request.receipt.owner.deviceId !== scopeBinding.deviceId || request.receipt.owner.enrollmentId !== scopeBinding.enrollmentId
      || request.receipt.imageId !== original.expectedDeploymentPin.configImageId
      || stdioSha256V2('spec', request.pin, budget) !== stdioSha256V2('spec', original.expectedDeploymentPin, budget)) {
      throw new Error('stdio_v2_device_original_mismatch')
    }
    const observed = await this.containers.captureContainer(request)
    // The adapter verifies unique destinations; Docker can return that same mount set in a different order.
    // Retain every mount field and the original observation, sorting only this digest input by code unit.
    const inspection = { ...observed.inspection, Mounts: [...observed.inspection.Mounts].sort((left, right) =>
      left.Destination < right.Destination ? -1 : left.Destination > right.Destination ? 1 : 0) }
    const capture = desktopCapture.parse({ kind: 'desktop', receipt: request.receipt, processId: process,
      directoryId: scopeBinding.directoryId, workspaceMount: request.workspaceMount, homeMount: request.homeMount,
      actualContainerId: observed.inspection.Id })
    return stdioJsonV2(budget).pipe(stdioPreparedV2).parse({ formatVersion: 2, actionId: original.actionId, executionRef: ref, taskDigest,
      scopeBinding, fullScopeDigest: stdioSha256V2('scope', { scopeBinding,
        workspaceMount: capture.workspaceMount, homeMount: capture.homeMount }, budget),
      expectedDeploymentPin: original.expectedDeploymentPin, actualExecutorImage: observed.image, capture,
      // Hash the full returned inspection, including Config/HostConfig/Path/Args, and actual image.
      // The caller separately checks the creation command and security policy; this digest grants no start.
      specDigest: stdioSha256V2('spec', { inspection, image: observed.image }, budget) })
  }
}
