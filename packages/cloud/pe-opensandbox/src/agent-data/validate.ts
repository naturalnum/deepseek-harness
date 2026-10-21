/** Original Root expectations and authenticated reply-fact validation. */
import { isIP } from 'node:net'
import { absolute, base64, digest, hex, need, record, text, u64 } from './canonical.ts'
import { AGENT_SOURCE_SHA256, BWRAP_SHA256 } from './constants.ts'
import { authorization, ROLE_PROTOCOL as PROTOCOL, ROLE_LIMITS as SLICE_LIMITS } from './role-protocol.ts'
import type { ClientOptions, ExpectedBinding, FailureFact, Handshake, MountFact, OperationRef, OperationSnapshot, RawTail } from './types.ts'

const ENV = '/opt/session-env'
/**
 * Reproduce the frozen fixed-layout bwrap argv without selecting mounts from an operation.
 * @param project - Original canonical project root supplied by protected Root configuration.
 * @returns The exact fixed-layout argv whose canonical bytes Root pins before requests.
 */
export function worldArgv(project: string): readonly string[] {
  return ['/trusted/bwrap', '--unshare-user', '--uid', '0', '--gid', '0',
    '--disable-userns', '--assert-userns-disabled', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--setenv', 'PATH', ENV + '/venv/bin:/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', ENV + '/home',
    '--setenv', 'TMPDIR', ENV + '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '--ro-bind', '/', '/', '--proc', '/proc', '--ro-bind', '/dev', '/dev',
    '--dev-bind', '/dev/null', '/dev/null', '--ro-bind', '/sys', '/sys',
    '--bind', project, project, '--ro-bind', ENV, ENV, '--bind', ENV + '/home', ENV + '/home',
    '--bind', ENV + '/venv', ENV + '/venv', '--bind', ENV + '/tmp', ENV + '/tmp',
    '--bind', ENV + '/tmp', '/tmp', '--ro-bind', project + '/.pe', project + '/.pe', '--chdir', project]
}
/**
 * Derive the expected world digest from the original project path, never from a reply.
 * @param project - Canonical absolute original project target.
 * @returns Lowercase SHA256 of the frozen world argv's canonical bytes.
 */
export const expectedWorldHash = (project: string): string => { absolute(project); return digest(worldArgv(project)) }
/**
 * Validate and copy protected inputs for one fixed private endpoint and runtime.
 * @param options - Root-selected endpoint, token, original identities, quantities and pins.
 * @returns The selected origin and independently copied immutable expectation.
 */
export function checkOptions(options: ClientOptions): { origin: string; expected: ExpectedBinding } {
  record(options, ['host', 'port', 'token', 'expected']); hex(options.token)
  need(isIP(options.host) === 4, 'literal_private_ipv4_required')
  const [a, b] = options.host.split('.').map(Number)
  need(a === 10 || a === 127 || (a === 172 && b !== undefined && b >= 16 && b <= 31)
    || (a === 192 && b === 168), 'private_endpoint_required')
  need(Number.isInteger(options.port) && options.port >= 1024 && options.port <= 65535, 'invalid_port')
  const e = options.expected
  record(e, ['physicalSandboxId', 'runtimeIdentity', 'projectRoot', 'roots', 'pins', 'declaredImageId'])
  text(e.physicalSandboxId); need(e.physicalSandboxId.length >= 1 && Buffer.byteLength(e.physicalSandboxId) <= 256
    && !/[\x00-\x1f\x7f]/.test(e.physicalSandboxId), 'invalid_sandbox_binding')
  hex(e.runtimeIdentity); absolute(e.projectRoot)
  const beneath = (root: string, path: string) => path === root || path.startsWith(root + '/')
  need(e.projectRoot !== '/' && ![ENV, '/trusted', '/root-secret', '/proc', '/sys', '/dev', '/tmp',
    '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/root'].some(p => beneath(p, e.projectRoot) || beneath(e.projectRoot, p)), 'invalid_project')
  record(e.roots, ['project', 'environment'])
  for (const root of [e.roots.project, e.roots.environment]) {
    record(root, ['device', 'inode', 'maximumBytes', 'maximumInodes'])
    u64(root.device, true); u64(root.inode); u64(root.maximumBytes); u64(root.maximumInodes)
  }
  need(e.roots.project.device !== e.roots.environment.device, 'independent_domains_required')
  record(e.pins, ['bwrapSha256', 'agentSourceSha256', 'userWorldArgvSha256'])
  Object.values(e.pins).forEach(hex)
  need(e.pins.bwrapSha256 === BWRAP_SHA256 && e.pins.agentSourceSha256 === AGENT_SOURCE_SHA256
    && e.pins.userWorldArgvSha256 === expectedWorldHash(e.projectRoot), 'unexpected_frozen_payload')
  need(typeof e.declaredImageId === 'string' && /^sha256:[0-9a-f]{64}$/.test(e.declaredImageId), 'invalid_declared_image')
  // Copy trusted inputs: later caller mutation cannot rebind this carrier.
  const expected = JSON.parse(JSON.stringify(e)) as ExpectedBinding
  Object.freeze(expected.roots.project); Object.freeze(expected.roots.environment); Object.freeze(expected.roots)
  Object.freeze(expected.pins); Object.freeze(expected)
  return { origin: `http://${options.host}:${options.port}`, expected }
}
/**
 * Validate and copy the original reference without minting a replacement ID.
 * @param value - Original operation ID and canonical spec hash.
 * @param runtime - Protected runtime to which the reference must belong.
 * @returns An immutable original operation reference.
 */
export function ref(value: OperationRef, runtime: string): OperationRef {
  record(value, ['runtimeIdentity', 'operationId', 'specHash', 'authorization']); hex(value.runtimeIdentity); hex(value.specHash)
  need(value.runtimeIdentity === runtime && typeof value.operationId === 'string'
    && /^[A-Za-z0-9_-]{1,64}$/.test(value.operationId), 'operation_binding')
  return Object.freeze({ ...value, authorization: authorization(value.authorization) })
}
/**
 * Require the fixed protocol and original runtime before trusting any reply fields.
 * @param value - Parsed response envelope.
 * @param runtime - Protected expected runtime, never learned from the response.
 * @returns Nothing; narrows a correctly bound envelope.
 */
export function envelope(value: unknown, runtime: string): asserts value is Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'reply_envelope')
  const e = value as Record<string, unknown>
  need(e.protocolVersion === PROTOCOL && e.runtimeIdentity === runtime, 'reply_identity')
}
const bool = (v: unknown) => { need(typeof v === 'boolean'); return v }
const count = (v: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number => {
  need(typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum && v <= maximum); return v
}
const nullableText = (v: unknown): string | null => { if (v === null) return v; text(v); need(v.length <= 128); return v }
/** Return the actual received literal after equality has narrowed its exact type. */
function literal<T extends string | number>(value: unknown, expected: T): T {
  const matches = (candidate: unknown): candidate is T => candidate === expected
  need(matches(value))
  return value
}
/**
 * Compare handshake facts with every original pin, root grant and finite slice value.
 * @param value - Parsed and authenticated complete handshake response.
 * @param e - Immutable original Root expectation.
 * @returns Validated facts; the compared image declaration is not actual image attestation.
 */
export function handshake(value: unknown, e: ExpectedBinding): Handshake {
  record(value, ['protocolVersion', 'runtimeIdentity', 'capabilities', 'pins', 'declaredImageId', 'mounts', 'limits',
    'newOperationsAccepted', 'recordCount', 'activeRangeCount', 'rangeRoles', 'sealed', 'sealReason', 'physicalStopRequired'])
  envelope(value, e.runtimeIdentity)
  need(JSON.stringify(value.capabilities) === JSON.stringify(['argv', 'stdin-ignore', 'stdin-batch', 'collect']), 'capabilities')
  need(Array.isArray(value.capabilities))
  record(value.pins, ['bwrapSha256', 'agentSourceSha256', 'userWorldArgvSha256'])
  for (const key of Object.keys(e.pins) as (keyof ExpectedBinding['pins'])[]) need(value.pins[key] === e.pins[key], 'payload_pin')
  hex(value.pins.bwrapSha256); hex(value.pins.agentSourceSha256); hex(value.pins.userWorldArgvSha256)
  need(value.declaredImageId === e.declaredImageId, 'declared_image_mismatch')
  text(value.declaredImageId); text(value.runtimeIdentity)
  record(value.mounts, [e.projectRoot, ENV])
  const mounts: Record<string, MountFact> = {}
  for (const [path, root] of [[e.projectRoot, e.roots.project], [ENV, e.roots.environment]] as const) {
    const item = value.mounts[path]
    record(item, ['device', 'inode', 'uid', 'gid', 'capacityBytes', 'capacityInodes', 'grant'])
    u64(item.device, true); u64(item.inode); u64(item.capacityBytes); u64(item.capacityInodes)
    record(item.grant, ['maximumBytes', 'maximumInodes']); u64(item.grant.maximumBytes); u64(item.grant.maximumInodes)
    need(item.device === root.device && item.inode === root.inode && item.uid === 2000 && item.gid === 2000
      && item.capacityBytes === root.maximumBytes && item.capacityInodes === root.maximumInodes
      && item.grant.maximumBytes === root.maximumBytes && item.grant.maximumInodes === root.maximumInodes, 'mount_identity_or_grant')
    mounts[path] = { device: item.device, inode: item.inode, uid: item.uid, gid: item.gid,
      capacityBytes: item.capacityBytes, capacityInodes: item.capacityInodes,
      grant: { maximumBytes: item.grant.maximumBytes, maximumInodes: item.grant.maximumInodes } }
  }
  record(value.limits, Object.keys(SLICE_LIMITS))
  for (const [key, limit] of Object.entries(SLICE_LIMITS)) need(value.limits[key] === limit, 'slice_limit_mismatch')
  const records = count(value.recordCount, 0, 4), activeRanges = count(value.activeRangeCount, 0, 2)
  record(value.rangeRoles, ['foreground', 'service'])
  const rangeRoles = { foreground: count(value.rangeRoles.foreground, 0, 1), service: count(value.rangeRoles.service, 0, 1) }
  need(activeRanges === rangeRoles.foreground + rangeRoles.service && activeRanges <= records, 'role_count_mismatch')
  const sealed = bool(value.sealed), physicalStopRequired = bool(value.physicalStopRequired), sealReason = nullableText(value.sealReason)
  const newOperationsAccepted = bool(value.newOperationsAccepted)
  need(newOperationsAccepted === (!sealed && records < 4), 'admission_facts')
  return { protocolVersion: literal(value.protocolVersion, PROTOCOL), runtimeIdentity: value.runtimeIdentity,
    capabilities: [literal(value.capabilities[0], 'argv'), literal(value.capabilities[1], 'stdin-ignore'),
      literal(value.capabilities[2], 'stdin-batch'), literal(value.capabilities[3], 'collect')],
    pins: { bwrapSha256: value.pins.bwrapSha256, agentSourceSha256: value.pins.agentSourceSha256,
      userWorldArgvSha256: value.pins.userWorldArgvSha256 }, declaredImageId: value.declaredImageId, mounts,
    limits: { lifetimeOperations: literal(value.limits.lifetimeOperations, SLICE_LIMITS.lifetimeOperations),
      activeRanges: literal(value.limits.activeRanges, SLICE_LIMITS.activeRanges),
      tailBytesPerStream: literal(value.limits.tailBytesPerStream, SLICE_LIMITS.tailBytesPerStream),
      observedStopThresholdPerStream: literal(value.limits.observedStopThresholdPerStream, SLICE_LIMITS.observedStopThresholdPerStream),
      prepareMs: literal(value.limits.prepareMs, SLICE_LIMITS.prepareMs),
      preparedLeaseMs: literal(value.limits.preparedLeaseMs, SLICE_LIMITS.preparedLeaseMs),
      runMs: literal(value.limits.runMs, SLICE_LIMITS.runMs),
      serviceRunMs: literal(value.limits.serviceRunMs, SLICE_LIMITS.serviceRunMs),
      stopMs: literal(value.limits.stopMs, SLICE_LIMITS.stopMs),
      residentMs: literal(value.limits.residentMs, SLICE_LIMITS.residentMs),
      childCpuSeconds: literal(value.limits.childCpuSeconds, SLICE_LIMITS.childCpuSeconds),
      childAddressBytes: literal(value.limits.childAddressBytes, SLICE_LIMITS.childAddressBytes),
      childFileBytes: literal(value.limits.childFileBytes, SLICE_LIMITS.childFileBytes),
      childOpenFiles: literal(value.limits.childOpenFiles, SLICE_LIMITS.childOpenFiles),
      childProcesses: literal(value.limits.childProcesses, SLICE_LIMITS.childProcesses),
      childCoreBytes: literal(value.limits.childCoreBytes, SLICE_LIMITS.childCoreBytes) },
    newOperationsAccepted, recordCount: records, activeRangeCount: activeRanges, rangeRoles, sealed, sealReason, physicalStopRequired }
}
function failure(value: unknown): FailureFact | null {
  if (value === null) return null
  record(value, ['type', 'errno', 'phase']); text(value.type); text(value.phase)
  need(value.type.length <= 64 && value.phase.length <= 64)
  const errno = value.errno === null ? null : count(value.errno, -2147483648, 2147483647)
  return { type: value.type, errno, phase: value.phase }
}
function tail(value: unknown): RawTail {
  record(value, ['requestedOffset', 'startOffset', 'endOffset', 'observedBytes', 'base64', 'lossy', 'eof'])
  need(value.requestedOffset === 0, 'tail_requested_offset')
  const start = count(value.startOffset), end = count(value.endOffset), observed = count(value.observedBytes)
  const bytes = base64(value.base64, 4096)
  need(end === observed && start === Math.max(0, observed - 4096) && bytes.length === Math.min(observed, 4096)
    && start <= end && end - start === bytes.length
    && bool(value.lossy) === (start > 0), 'tail_coordinates')
  const eof = bool(value.eof)
  text(value.base64)
  return { requestedOffset: value.requestedOffset, startOffset: start, endOffset: end, observedBytes: observed,
    base64: value.base64, bytes, lossy: bool(value.lossy), eof }
}
/**
 * Preserve raw byte/direct/range facts for exactly the original operation.
 * @param value - Parsed operation response payload.
 * @param expected - Original ID/hash pair associated with the request.
 * @returns Validated full-tail snapshots and independent direct/range/IO facts, without an invented outcome.
 */
export function operation(value: unknown, expected: OperationRef): OperationSnapshot {
  record(value, ['operationId', 'specHash', 'role', 'registrationId', 'primitiveStarted', 'prepared', 'commitAttempted', 'commitClosed', 'submitted',
    'firstCause', 'direct', 'directNotObserved', 'rangeEmpty', 'ioClosed', 'physicalStopRequired', 'failure', 'cleanupFailure',
    'providerFailure', 'streams'])
  need(value.operationId === expected.operationId && value.specHash === expected.specHash, 'operation_reply_binding')
  need(value.role === expected.authorization.role && value.registrationId === expected.authorization.registrationId,
    'operation_role_binding')
  const primitiveStarted = bool(value.primitiveStarted), prepared = bool(value.prepared), commitAttempted = bool(value.commitAttempted)
  const commitClosed = bool(value.commitClosed), submitted = bool(value.submitted), directNotObserved = bool(value.directNotObserved)
  const rangeEmpty = bool(value.rangeEmpty), ioClosed = bool(value.ioClosed), physicalStopRequired = bool(value.physicalStopRequired)
  const providerFailure = bool(value.providerFailure), firstCause = nullableText(value.firstCause)
  const failureFact = failure(value.failure), cleanupFailure = failure(value.cleanupFailure)
  let direct: OperationSnapshot['direct'] = null
  if (value.direct !== null) {
    record(value.direct, ['waitStatus', 'returncode'])
    const wait = count(value.direct.waitStatus, 0, 2147483647), code = count(value.direct.returncode, -127, 255)
    const low = wait & 127
    need((low === 0 && code === ((wait >> 8) & 255)) || (low > 0 && low < 127 && code === -low), 'direct_wait_status')
    direct = { waitStatus: wait, returncode: code }
  }
  need(value.directNotObserved === (value.direct === null) && value.rangeEmpty === value.ioClosed, 'range_facts')
  record(value.streams, ['stdout', 'stderr'])
  const stdout = tail(value.streams.stdout), stderr = tail(value.streams.stderr)
  if (value.rangeEmpty) need(stdout.eof && stderr.eof, 'empty_without_eof')
  if (!value.primitiveStarted) need(value.rangeEmpty && !value.prepared && !value.submitted, 'no_primitive_facts')
  return { operationId: value.operationId, specHash: value.specHash, role: expected.authorization.role,
    registrationId: expected.authorization.registrationId, primitiveStarted, prepared, commitAttempted,
    commitClosed, submitted, firstCause, direct, directNotObserved, rangeEmpty, ioClosed, physicalStopRequired,
    failure: failureFact, cleanupFailure, providerFailure, streams: { stdout, stderr } }
}
