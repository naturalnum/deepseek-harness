/** Docker ownership checks for a durable device journal; observations alone are not writer-stop receipts. */
import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

import { ownedContainerOwner, ownedContainerReceipt, type OwnedContainerOwner,
  type OwnedContainerReceipt, type DeviceContainerId, type DeviceContainerImageId } from '@power-evolve/contracts/device-execution'
import { stdioCaptureV2, stdioDeviceDeploymentV2, stdioExecutorImageV2,
  type StdioDeploymentV2, type StdioExecutorImageV2 } from '@power-evolve/contracts/stdio-mcp'
/** Shared durable owner and container validators used by both Device and Platform. */
export { ownedContainerOwner, ownedContainerReceipt }
/** Shared immutable identity types retained for existing Docker adapter consumers. */
export type { DeviceContainerId, DeviceContainerImageId, ContainerDeviceId, ContainerEnrollmentId,
  ContainerExecutionId, ContainerCreationId, ContainerRequestDigest, OwnedContainerOwner,
  OwnedContainerReceipt } from '@power-evolve/contracts/device-execution'

const containerId = ownedContainerReceipt.shape.containerId
const imageId = ownedContainerReceipt.shape.imageId

/** Stable labels owned exclusively by this module. */
export const OWNED_DEVICE_CONTAINER_LABELS = {
  schema: 'io.power-evolve.device-container.schema',
  deviceId: 'io.power-evolve.device-container.device-id',
  enrollmentId: 'io.power-evolve.device-container.enrollment-id',
  executionId: 'io.power-evolve.device-container.execution-id',
  creationId: 'io.power-evolve.device-container.creation-id',
  requestDigest: 'io.power-evolve.device-container.request-digest',
  imageId: 'io.power-evolve.device-container.image-id',
} as const

/** Validated state from an exact owned container; missing is not evidence of termination. */
export interface OwnedContainerObservation {
  Running: boolean
  ExitCode: number
  Status: string
  StartedAt: string
  FinishedAt: string
}
/** Bounded Docker output; partial output is explicitly identified. */
export interface DockerCommandResult { stdout: string; stderr: string; outputTruncated?: boolean }
/** Injectable CLI transport; deterministic tests replace commands, not a real Docker daemon. */
export interface DockerClient {
  /** Run one bounded Docker CLI request without a shell.
   * @param args Literal Docker argv.
   * @param timeoutMs Finite process timeout selected by the operation.
   * @returns Captured CLI output with an explicit truncation indicator.
   */
  run(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult>
}
/** Fixed failure codes exclude argv, directory paths, command text, and raw daemon diagnostics. */
export class DockerCommandError extends Error {
  constructor(readonly code: 'docker_not_found' | 'docker_command_failed') { super(code) }
}
/** Identity failures do not authorize adoption, mutation, or an inferred stopped state. */
export class OwnedContainerError extends Error {
  constructor(readonly code: 'image_unavailable' | 'container_inspection_unavailable' | 'container_identity_mismatch'
    | 'container_missing' | 'container_not_created' | 'container_running' | 'create_unconfirmed' | 'owned_options_conflict'
    | 'image_identity_mismatch' | 'container_mount_mismatch' | 'container_restarted') { super(code) }
}

const executeFile = promisify(execFile)
/** Docker CLI with only local daemon selection and executable lookup inherited from the environment. */
export class ScrubbedDockerClient implements DockerClient {
  private readonly environment: NodeJS.ProcessEnv
  constructor(private readonly executable = 'docker', environment: NodeJS.ProcessEnv = process.env) {
    this.environment = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST'].flatMap(key =>
      environment[key] === undefined ? [] : [[key, environment[key]]]))
  }
  /** Execute a finite CLI request; process failures return fixed codes, never the child error.
   * @param args Literal argv for Docker.
   * @param timeoutMs Finite process timeout.
   * @returns Bounded stdout/stderr; max-buffer output retains an explicit partial-output indicator.
   */
  async run(args: readonly string[], timeoutMs: number): Promise<DockerCommandResult> {
    try {
      return await executeFile(this.executable, [...args], { encoding: 'utf8', timeout: timeoutMs,
        maxBuffer: 512 * 1024, env: this.environment, shell: false })
    } catch (error) {
      const stdout = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { stdout, stderr, outputTruncated: true }
      }
      throw new DockerCommandError(/^Error(?: response from daemon)?: No such (?:object|container|image):/imu.test(stderr)
        ? 'docker_not_found' : 'docker_command_failed')
    }
  }
}

/** Trusted create flags precede module-owned identity flags and the immutable image. */
export interface OwnedContainerCreateRequest {
  name: string
  imageId: DeviceContainerImageId
  owner: OwnedContainerOwner
  /** Docker create flags only; exclude positional image/command, --name, and owned labels. */
  options: readonly string[]
  /** Entrypoint argv following the immutable image. */
  command: readonly string[]
}
/** Frozen creation intent used for a single read-only name lookup after an interrupted acknowledgement. */
export type OwnedContainerFindRequest = Pick<OwnedContainerCreateRequest, 'name' | 'imageId' | 'owner'>
/** Bounded logs of an exact owned container. */
export interface OwnedContainerLogs { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean }
/** Device Profile configuration validated by its owning plugin before constructing this service. */
export interface OwnedContainerConfig {
  /** Positive integer timeout for image/create/inspect/start/logs/remove CLI requests. */
  commandTimeoutMs: number
  /** Positive integer timeout for a stop CLI request. */
  stopTimeoutMs: number
  /** Nonnegative integer grace period passed to Docker stop. */
  stopGraceSeconds: number
}
type DesktopDeployment = Extract<StdioDeploymentV2, { kind: 'desktop' }>
type DesktopImage = Extract<StdioExecutorImageV2, { kind: 'desktop' }>
type DesktopCapture = Extract<z.infer<typeof stdioCaptureV2>, { kind: 'desktop' }>
/** Trusted original receipt, deployment pin and authorized physical bind sources; caller owns realpath/grant checks. */
export interface OwnedContainerCaptureRequest {
  receipt: OwnedContainerReceipt
  pin: DesktopDeployment
  workspaceMount: DesktopCapture['workspaceMount']
  homeMount: DesktopCapture['homeMount']
}
/** Fresh exact-ID image and container observations; raw State/Mounts remain private executor data. */
export interface OwnedContainerCapture {
  image: DesktopImage
  inspection: z.infer<typeof captureInspection>
}

const observation = z.object({ Running: z.boolean(), ExitCode: z.number().int(), Status: z.string().max(64),
  StartedAt: z.string().max(128), FinishedAt: z.string().max(128) })
const inspection = z.object({ Id: containerId, Image: imageId, Labels: z.record(z.string(), z.string()).nullable(), State: observation })
type Inspection = z.infer<typeof inspection>
const inspectionFormat = '{"Id":{{json .Id}},"Image":{{json .Image}},"Labels":{{json .Config.Labels}},"State":{{json .State}}}'
const imageCaptureObservation = z.object({ Id: imageId, Os: z.string(), Architecture: z.string() })
const imageCaptureFormat = '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}}}'
const mountObservation = z.object({ Type: z.string(), Source: z.string().optional(), Destination: z.string(), RW: z.boolean() }).passthrough()
const rawObject = z.custom<Record<string, unknown>>(value => value !== null && typeof value === 'object' && !Array.isArray(value))
const captureInspection = inspection.extend({ State: observation.passthrough(), Mounts: z.array(mountObservation),
  RestartCount: z.number().int().nonnegative().safe(), Config: rawObject, HostConfig: rawObject,
  Path: z.string().min(1), Args: z.array(z.string()) })
const captureInspectionFormat = '{"Id":{{json .Id}},"Image":{{json .Image}},"Labels":{{json .Config.Labels}},"State":{{json .State}},"Mounts":{{json .Mounts}},"RestartCount":{{json .RestartCount}},"Config":{{json .Config}},"HostConfig":{{json .HostConfig}},"Path":{{json .Path}},"Args":{{json .Args}}}'
function requireCanonicalSource(source: string): void {
  if (!posix.isAbsolute(source) || posix.normalize(source) !== source || posix.resolve(source) !== source
    || /[\u0000-\u001f\u007f-\u009f]/u.test(source)) {
    throw new OwnedContainerError('container_mount_mismatch')
  }
}
function verifyMounts(value: z.infer<typeof captureInspection>, request: OwnedContainerCaptureRequest): void {
  const expected = [request.workspaceMount, request.homeMount]
  const destinations = new Set<string>()
  for (const mount of value.Mounts) {
    if (!posix.isAbsolute(mount.Destination) || posix.normalize(mount.Destination) !== mount.Destination
      || destinations.has(mount.Destination)) throw new OwnedContainerError('container_mount_mismatch')
    destinations.add(mount.Destination)
    const binding = expected.find(item => item.destination === mount.Destination)
    if (binding ? mount.Type !== 'bind' || mount.Source !== binding.source || mount.RW !== !binding.readOnly
      : mount.Type !== 'tmpfs' || mount.Destination !== '/tmp') throw new OwnedContainerError('container_mount_mismatch')
  }
  if (expected.some(item => !destinations.has(item.destination))) throw new OwnedContainerError('container_mount_mismatch')
}
function labels(owner: OwnedContainerOwner, image: DeviceContainerImageId): Record<string, string> {
  return { [OWNED_DEVICE_CONTAINER_LABELS.schema]: '1', [OWNED_DEVICE_CONTAINER_LABELS.imageId]: image,
    ...Object.fromEntries(Object.entries(owner).map(([key, value]) => [OWNED_DEVICE_CONTAINER_LABELS[key as keyof OwnedContainerOwner], value])) }
}
function requireOwnOptions(options: readonly string[]): void {
  const owned = new Set<string>(Object.values(OWNED_DEVICE_CONTAINER_LABELS))
  for (const [index, option] of options.entries()) {
    const label = option === '--label' || option === '-l' ? options[index + 1]
      : option.startsWith('--label=') ? option.slice(8) : option.startsWith('-l') ? option.slice(2) : undefined
    if (option === '--name' || option.startsWith('--name=') || option === '--'
      || label !== undefined && owned.has(label.split('=', 1)[0]!)) throw new OwnedContainerError('owned_options_conflict')
  }
}
function verify(value: Inspection, expected: Pick<OwnedContainerFindRequest, 'owner' | 'imageId'>, expectedId?: DeviceContainerId): void {
  if (expectedId !== undefined && value.Id !== expectedId || value.Image !== expected.imageId
    || Object.entries(labels(expected.owner, expected.imageId)).some(([key, item]) => value.Labels?.[key] !== item)) {
    throw new OwnedContainerError('container_identity_mismatch')
  }
}
function capped(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  return { text: bytes.subarray(0, 65536).toString('utf8'), truncated: bytes.length > 65536 }
}

/** Create/capture one frozen identity; all later operations verify and address only that exact ID. */
export class OwnedDeviceContainer {
  constructor(private readonly config: OwnedContainerConfig, private readonly docker: DockerClient = new ScrubbedDockerClient()) {}
  /** Observe the original immutable local image without resolving tags, pulling, or starting a container.
   * @param pin Original validated deployment descriptor, including expected OS and architecture.
   * @returns Fresh actual image identity only when its exact config ID and platform match the pin.
   */
  async captureImage(pin: DesktopDeployment): Promise<DesktopImage> {
    const expected = stdioDeviceDeploymentV2.parse(pin)
    let actual: z.infer<typeof imageCaptureObservation>
    try {
      const result = await this.docker.run(['image', 'inspect', '--format', imageCaptureFormat, expected.configImageId], this.config.commandTimeoutMs)
      if (result.outputTruncated) throw new OwnedContainerError('image_unavailable')
      actual = imageCaptureObservation.parse(JSON.parse(result.stdout))
    } catch (error) { void error; throw new OwnedContainerError('image_unavailable') }
    if (actual.Id !== expected.configImageId || actual.Os !== expected.platform.os || actual.Architecture !== expected.platform.architecture) {
      throw new OwnedContainerError('image_identity_mismatch')
    }
    return stdioExecutorImageV2.options[1].parse({ kind: 'desktop', configImageId: actual.Id,
      platform: { os: actual.Os, architecture: actual.Architecture } })
  }
  /** Observe an exact owned, never-started container and its authorized Workspace/Home binds without granting path access or mutating Docker.
   * @param request Original trusted receipt, image pin and canonical absolute physical bind expectations.
   * @returns Fresh private identity, complete execution configuration and mount observations; the caller must recapture before dispatch, check its creation policy and separately authorize start.
   */
  async captureContainer(request: OwnedContainerCaptureRequest): Promise<OwnedContainerCapture> {
    requireCanonicalSource(request.workspaceMount.source)
    requireCanonicalSource(request.homeMount.source)
    if (request.receipt.imageId !== request.pin.configImageId) throw new OwnedContainerError('container_identity_mismatch')
    const image = await this.captureImage(request.pin)
    let value: z.infer<typeof captureInspection>
    try {
      const result = await this.docker.run(['container', 'inspect', '--format', captureInspectionFormat, request.receipt.containerId], this.config.commandTimeoutMs)
      if (result.outputTruncated) throw new OwnedContainerError('container_inspection_unavailable')
      value = captureInspection.parse(JSON.parse(result.stdout))
    } catch (error) {
      if (error instanceof DockerCommandError && error.code === 'docker_not_found') throw new OwnedContainerError('container_missing')
      throw new OwnedContainerError('container_inspection_unavailable')
    }
    verify(value, request.receipt, request.receipt.containerId)
    if (value.State.Running || value.State.Status !== 'created') throw new OwnedContainerError('container_not_created')
    if (value.RestartCount !== 0) throw new OwnedContainerError('container_restarted')
    verifyMounts(value, request)
    return { image, inspection: value }
  }
  /** Resolve an already-local image reference without pulling or starting anything.
   * @param reference Configured image tag, digest or local ID.
   * @returns Immutable local sha256 Docker image ID.
   */
  async resolveImage(reference: string): Promise<DeviceContainerImageId> {
    try {
      const result = await this.docker.run(['image', 'inspect', '--format', '{{json .Id}}', reference], this.config.commandTimeoutMs)
      if (result.outputTruncated) throw new OwnedContainerError('image_unavailable')
      return imageId.parse(JSON.parse(result.stdout))
    } catch (error) { void error; throw new OwnedContainerError('image_unavailable') }
  }
  private async read(locator: string): Promise<Inspection | null> {
    let result: DockerCommandResult
    try { result = await this.docker.run(['container', 'inspect', '--format', inspectionFormat, locator], this.config.commandTimeoutMs) }
    catch (error) {
      if (error instanceof DockerCommandError && error.code === 'docker_not_found') return null
      throw new OwnedContainerError('container_inspection_unavailable')
    }
    try {
      if (result.outputTruncated) throw new OwnedContainerError('container_inspection_unavailable')
      return inspection.parse(JSON.parse(result.stdout))
    } catch (error) { void error; throw new OwnedContainerError('container_inspection_unavailable') }
  }
  /** Recover the create-to-journal gap through one name observation, without create/start replay.
   * @param request Original saved creation owner, image and discovery name.
   * @returns Verified immutable receipt, or null when absent. Foreign ownership throws.
   */
  async findCreated(request: OwnedContainerFindRequest): Promise<OwnedContainerReceipt | null> {
    const value = await this.read(request.name)
    if (!value) return null
    verify(value, request)
    return { containerId: value.Id, imageId: request.imageId, owner: { ...request.owner } }
  }
  /** Create once; lost/invalid acknowledgement permits exactly one verified discovery lookup.
   * @param request Trusted flags and command plus an already-persisted unique creation owner.
   * @returns Receipt for durable persistence before start; this method never starts a container.
   */
  async create(request: OwnedContainerCreateRequest): Promise<OwnedContainerReceipt> {
    requireOwnOptions(request.options)
    const identityFlags = Object.entries(labels(request.owner, request.imageId)).flatMap(([key, value]) => ['--label', `${key}=${value}`])
    let id: DeviceContainerId
    try {
      const created = await this.docker.run(['create', ...request.options, '--name', request.name, ...identityFlags,
        request.imageId, ...request.command], this.config.commandTimeoutMs)
      if (created.outputTruncated) throw new OwnedContainerError('create_unconfirmed')
      id = containerId.parse(created.stdout.trim())
    } catch (error) {
      void error
      const found = await this.findCreated(request)
      if (!found) throw new OwnedContainerError('create_unconfirmed')
      return found
    }
    const receipt = { containerId: id, imageId: request.imageId, owner: { ...request.owner } }
    await this.required(receipt)
    return receipt
  }
  private async required(receipt: OwnedContainerReceipt): Promise<OwnedContainerObservation> {
    const state = await this.inspect(receipt)
    if (!state) throw new OwnedContainerError('container_missing')
    return state
  }
  /** Inspect only the recorded ID and recheck all owner labels and the actual image.
   * @param receipt Validated durable receipt.
   * @returns Verified Docker state, or null; absence is not stop evidence.
   */
  async inspect(receipt: OwnedContainerReceipt): Promise<OwnedContainerObservation | null> {
    const value = await this.read(receipt.containerId)
    if (!value) return null
    verify(value, receipt, receipt.containerId)
    return value.State
  }
  /** Start a newly created container only after its caller durably saves the receipt; never use on cold recovery.
   * @param receipt Current creation receipt.
   * @returns Completion of the CLI acknowledgement, not execution completion.
   */
  async start(receipt: OwnedContainerReceipt): Promise<void> {
    const state = await this.required(receipt)
    if (state.Running || state.Status !== 'created') throw new OwnedContainerError('container_not_created')
    await this.docker.run(['start', receipt.containerId], this.config.commandTimeoutMs)
  }
  /** Request a stop of the exact owned container; the caller must inspect and persist a later observation.
   * @param receipt Saved identity.
   * @returns Stop acknowledgement only, not a complete directory-writer stop proof.
   */
  async stop(receipt: OwnedContainerReceipt): Promise<void> {
    await this.required(receipt)
    await this.docker.run(['stop', '--time', String(this.config.stopGraceSeconds), receipt.containerId], this.config.stopTimeoutMs)
  }
  /** Read bounded logs only after the current owner and image match.
   * @param receipt Saved identity.
   * @returns Truncation-aware command output.
   */
  async logs(receipt: OwnedContainerReceipt): Promise<OwnedContainerLogs> {
    await this.required(receipt)
    const result = await this.docker.run(['logs', receipt.containerId], this.config.commandTimeoutMs)
    const stdout = capped(result.stdout), stderr = capped(result.stderr)
    return { stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated || !!result.outputTruncated,
      stderrTruncated: stderr.truncated || !!result.outputTruncated }
  }
  /** Remove only an observed non-running owned container; a concurrent start makes ordinary rm fail.
   * @param receipt Saved identity whose stop observation the caller has already persisted.
   * @returns Removal acknowledgement; no force, name lookup or missing-as-stopped inference.
   */
  async remove(receipt: OwnedContainerReceipt): Promise<void> {
    if ((await this.required(receipt)).Running) throw new OwnedContainerError('container_running')
    await this.docker.run(['rm', receipt.containerId], this.config.commandTimeoutMs)
  }
}
