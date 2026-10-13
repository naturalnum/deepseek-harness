/** Actual Runner start parsing and lifecycle; driver, cwd authorization and independent UID-stop observations are unit substitutes. */
import { expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseStdioStartV2, validateStdioStartV2 } from '../../connector-runner/src/stdio-v2-dispatch.ts'
import { StdioCloudRuntimeV2, type StdioCloudRuntimeOptionsV2 } from '../../connector-runner/src/stdio-v2-runtime.ts'
import type { StdioV2Outcome } from '../../connector-runner/src/stdio-v2.ts'
import { ids, limits, wirePacket, wireDigest } from './employee1-stdio-consumer-fixture.ts'

type Packet = ReturnType<typeof wirePacket>
const failed: StdioV2Outcome = { state: 'failed', errorCode: 'unit_driver_stopped', facts: {
  programStartAttempted: true, toolsCallAttempted: true, effectMayHaveOccurred: true, childPid: 123,
  childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
  protocolBytes: 12, protocolMessages: 1, stderrBytes: 0, stderr: '',
} }
function refresh(input: Packet): void {
  const digest = wireDigest('task', input.dispatch.task)
  input.dispatch.taskDigest = digest; input.dispatch.permit.taskDigest = digest; input.authorization.permit.taskDigest = digest
}
function runtime(packet: Packet, cleanup = async () => true, authorizeCwd = async (_cwd: string, _signal: AbortSignal) => true) {
  const start = parseStdioStartV2(packet, limits)
  const driver = vi.fn(async () => structuredClone(failed)), authorize = vi.fn(authorizeCwd), clean = vi.fn(cleanup)
  const options: StdioCloudRuntimeOptionsV2 = { limits, maxReplyBytes: 16384, executorOwner: start.dispatch.permit.executorOwner,
    environment: { workspaceRoot: '/workspace', env: { HOME: '/home/agent', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      identity: { kind: 'unix', uid: 1000, gid: 1000 } }, cleanup: clean, authorizeCwd: authorize }
  return { instance: new StdioCloudRuntimeV2(options, driver), driver, authorize, clean }
}

for (const phase of ['discover', 'call'] as const) {
  test('Runner accepts independently authored ' + phase + ' packet and takes an independent original snapshot', () => {
    const input = wirePacket(phase), before = structuredClone(input), parsed = parseStdioStartV2(input, limits)
    expect(parsed).toEqual(before)
    input.dispatch.task.invocation.argv.push('later')
    expect(parsed.dispatch.task.invocation.argv).toEqual(before.dispatch.task.invocation.argv)
    expect(validateStdioStartV2(before, limits, parsed.dispatch.permit.executorOwner, Date.now())).toEqual(before)
  })
}

const mutations: readonly [string, (input: Packet) => void][] = [
  ['legacy format', (input) => { Reflect.set(input.dispatch.task, 'formatVersion', 1) }],
  ['private extra target', (input) => { Reflect.set(input.dispatch.task.scopeBinding, 'physicalRoot', '/private') }],
  ['different owner', (input) => { input.dispatch.task.userId = ids.other; refresh(input) }],
  ['different home owner', (input) => { input.dispatch.task.scopeBinding.home.userId = ids.other; refresh(input) }],
  ['changed frozen limits', (input) => { input.dispatch.task.limits.maxTools++; refresh(input) }],
  ['different catalog image platform', (input) => {
    if (input.dispatch.task.phase === 'call') Reflect.set(input.dispatch.task.selection.catalogImageExpectation.platform, 'architecture', 'amd64')
    refresh(input)
  }],
  ['substituted runtime image prefix', (input) => {
    if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.catalogImageExpectation.runtimeImageId = 'original-image'
    refresh(input)
  }],
  ['different deployment manifest', (input) => { input.dispatch.task.expectedDeploymentPin.imageReference = 'registry.invalid/runner@sha256:' + 'f'.repeat(64); refresh(input) }],
  ['duplicate catalog tool names', (input) => {
    if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.rawCatalog.push(structuredClone(input.dispatch.task.selection.rawCatalog[0]!))
    refresh(input)
  }],
  ['missing catalog name', (input) => { if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.rawName = 'missing'; refresh(input) }],
  ['changed raw descriptor extension', (input) => {
    if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.rawDescriptor.extension.retained = false
    refresh(input)
  }],
  ['non-object input schema', (input) => {
    if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.rawCatalog[0]!.inputSchema.type = 'array'
    refresh(input)
  }],
  ['whole catalog over budget', (input) => {
    if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.rawCatalog[0]!._meta.literal = 'x'.repeat(limits.maxCatalogBytes)
    refresh(input)
  }],
  ['catalog count over budget', (input) => {
    if (input.dispatch.task.phase === 'call') {
      const selection = input.dispatch.task.selection
      selection.rawCatalog = [0, 1, 2].map(index => ({ ...structuredClone(selection.rawCatalog[0]!), name: `tool-${index}` }))
    }
    refresh(input)
  }],
  ['wrong catalog digest', (input) => { if (input.dispatch.task.phase === 'call') input.dispatch.task.selection.catalogDigest = 'f'.repeat(64); refresh(input) }],
  ['tampered invocation after digest', (input) => { input.dispatch.task.invocation.argv.push('unapproved') }],
  ['wrong action permit', (input) => {
    Reflect.set(input.dispatch.permit, 'actionId', ids.other); Reflect.set(input.authorization.permit, 'actionId', ids.other)
  }],
  ['wrong execution permit', (input) => { input.dispatch.permit.executionRef.executionId = ids.other; input.authorization.permit.executionRef.executionId = ids.other }],
  ['wrong prepared digest permit', (input) => { input.dispatch.permit.preparedDigest = 'f'.repeat(64); input.authorization.permit.preparedDigest = 'f'.repeat(64) }],
  ['wrong task digest permit', (input) => { input.dispatch.permit.taskDigest = 'f'.repeat(64); input.authorization.permit.taskDigest = 'f'.repeat(64) }],
  ['changed authorization receipt', (input) => { input.authorization.permit.approvalFingerprint = 'f'.repeat(64) }],
  ['renewed approval epoch', (input) => { Reflect.set(input.dispatch.permit, 'approvalEpoch', 2); Reflect.set(input.authorization.permit, 'approvalEpoch', 2) }],
  ['permit issued at expiry', (input) => {
    input.dispatch.permit.issuedAt = input.dispatch.permit.expiresAt
    input.authorization.permit.issuedAt = input.authorization.permit.expiresAt
  }],
]
for (const [name, mutate] of mutations) {
  test('fresh Runner rejects ' + name + ' wire before reserving, authorizing cwd or starting a driver', async () => {
    const original = wirePacket(), f = runtime(original), changed = structuredClone(original)
    mutate(changed)
    await expect(f.instance.start(changed)).rejects.toHaveProperty('code')
    expect(f.instance.get(ids.execution)).toBeUndefined(); expect(f.instance.busy()).toBe(false)
    expect(f.driver).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled(); expect(f.clean).not.toHaveBeenCalled()
    expect(await f.instance.close()).toBe(true)
  })
}

test('queried false receipt parses but cannot start a fresh or cold Runner', async () => {
  const input = wirePacket(); input.authorization.grantOnce = false
  expect(parseStdioStartV2(input, limits).authorization.grantOnce).toBe(false)
  const f = runtime(input)
  try {
    await expect(f.instance.start(input)).rejects.toMatchObject({ code: 'stdio_v2_start_denied' })
    expect(f.instance.get(ids.execution)).toBeUndefined(); expect(f.driver).not.toHaveBeenCalled()
  } finally { expect(await f.instance.close()).toBe(true) }
})

test('original permit clock and exact executor instance are rechecked without normalization', () => {
  const input = wirePacket(), owner = parseStdioStartV2(input, limits).dispatch.permit.executorOwner
  const issued = Date.parse(input.dispatch.permit.issuedAt), expires = Date.parse(input.dispatch.permit.expiresAt)
  expect(validateStdioStartV2(input, limits, owner, issued)).toEqual(input)
  expect(validateStdioStartV2(input, limits, owner, expires - 1)).toEqual(input)
  expect(() => validateStdioStartV2(input, limits, owner, issued - 1)).toThrow('stdio_v2_start_expired')
  expect(() => validateStdioStartV2(input, limits, owner, expires)).toThrow('stdio_v2_start_expired')
  expect(() => validateStdioStartV2(input, limits, { ...owner,
    runnerInstanceId: brandString<typeof owner.runnerInstanceId>(ids.other) }, issued))
    .toThrow('stdio_v2_executor_owner_mismatch')
})

for (const kind of ['expired', 'cold-instance'] as const) {
  test('fresh stateful Runner refuses an original ' + kind + ' receipt before reservation or callbacks', async () => {
    const original = wirePacket(), f = runtime(original), changed = structuredClone(original)
    if (kind === 'expired') {
      const now = Date.now()
      for (const permit of [changed.dispatch.permit, changed.authorization.permit]) {
        permit.issuedAt = new Date(now - 60000).toISOString(); permit.expiresAt = new Date(now - 1000).toISOString()
      }
    } else {
      changed.dispatch.permit.executorOwner.runnerInstanceId = ids.other
      changed.authorization.permit.executorOwner.runnerInstanceId = ids.other
    }
    try {
      await expect(f.instance.start(changed)).rejects.toMatchObject({ code: kind === 'expired'
        ? 'stdio_v2_start_expired' : 'stdio_v2_executor_owner_mismatch' })
      expect(f.instance.get(ids.execution)).toBeUndefined(); expect(f.instance.busy()).toBe(false)
      expect(f.driver).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled(); expect(f.clean).not.toHaveBeenCalled()
    } finally { expect(await f.instance.close()).toBe(true) }
  })
}

for (const quiet of [true, false]) {
  test('cancellation retains the original reservation until independent stop observation is ' + String(quiet), async () => {
    const input = wirePacket(), authorize = vi.fn(async () => true), clean = vi.fn(async () => quiet)
    const f = runtime(input, clean, authorize)
    const first = f.instance.start(input)
    f.instance.cancel(ids.execution)
    expect(await first).toMatchObject({ state: 'running', writerStopConfirmed: false })
    expect(await f.instance.close()).toBe(quiet)
    expect(f.instance.get(ids.execution)).toMatchObject({ state: quiet ? 'cancelled' : 'unknown', writerStopConfirmed: quiet,
      outcome: { state: 'failed', facts: { programStartAttempted: false, effectMayHaveOccurred: false } } })
    expect(f.instance.busy()).toBe(!quiet)
    expect(authorize).not.toHaveBeenCalled(); expect(f.driver).not.toHaveBeenCalled(); expect(clean).toHaveBeenCalledTimes(1)
    const query = structuredClone(input); query.authorization.grantOnce = false
    expect(await f.instance.start(query)).toEqual(f.instance.get(ids.execution))
    expect(f.instance.cancel(ids.other)).toBeUndefined()
  })
}

test('an admitted task runs the original once; duplicate false receipt reads and changed dispatch conflict retain facts', async () => {
  const input = wirePacket(), f = runtime(input)
  try {
    await f.instance.start(input)
    await expect.poll(() => f.instance.get(ids.execution)?.state).toBe('failed')
    expect(f.driver).toHaveBeenCalledTimes(1)
    const query = structuredClone(input); query.authorization.grantOnce = false
    expect(await f.instance.start(query)).toEqual(f.instance.get(ids.execution))
    const changed = structuredClone(input)
    changed.dispatch.task.invocation.argv.push('other'); refresh(changed)
    await expect(f.instance.start(changed)).rejects.toMatchObject({ code: 'stdio_v2_dispatch_conflict' })
    expect(f.driver).toHaveBeenCalledTimes(1)
    expect(f.instance.get(ids.execution)).toMatchObject({ writerStopConfirmed: true,
      outcome: { facts: { childExitObserved: true, childCloseObserved: true } } })
  } finally { expect(await f.instance.close()).toBe(true) }
})

test('cancellation during async cwd authorization cannot start a driver after the await', async () => {
  let resume!: (allowed: boolean) => void
  const gate = new Promise<boolean>((resolve) => { resume = resolve }), authorize = vi.fn(() => gate)
  const f = runtime(wirePacket(), async () => true, authorize)
  await f.instance.start(wirePacket())
  await expect.poll(() => authorize.mock.calls.length).toBe(1)
  f.instance.cancel(ids.execution); resume(true)
  expect(await f.instance.close()).toBe(true)
  expect(f.driver).not.toHaveBeenCalled()
  expect(f.instance.get(ids.execution)?.outcome?.facts.programStartAttempted).toBe(false)
})
