/** Deterministic queued/wire validation only; no platform, credential or executor process. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { stdioCatalogV2, stdioTaskSchemasV2, stdioCheckRequestV2, stdioPreparedV2,
  stdioJsonV2, stdioLimitsV2, stdioImageMatchesDeploymentV2, stdioDeploymentV2, stdioExecutorImageV2,
  stdioStartAuthorizationV2, stdioDispatchV2 } from '../src/stdio-mcp.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha = (digit: string) => digit.repeat(64)
const limits = stdioLimitsV2.parse({ runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0,
  killGraceMs: 1000, maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072,
  maxProtocolMessages: 100, maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20,
  maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 })
const platform = { os: 'linux', architecture: 'arm64' }
const pin = { kind: 'cloud', deploymentId: id(9), protocolVersion: 2, platform,
  imageReference: `registry.example/runner@sha256:${sha('a')}`, configImageId: `sha256:${sha('b')}`,
  runtimeImageIds: [`registry.example/runner@sha256:${sha('a')}`] }
const scope = { kind: 'cloud', userId: id(1), workspaceId: id(2), bindingGeneration: 2,
  target: { spaceId: id(3), rootRelativePath: 'project' }, home: { kind: 'user', userId: id(1) } }
const task = { formatVersion: 2, actionId: id(4), userId: id(1), sessionId: id(5), connectionId: id(6),
  configRevision: 1, configDigest: sha('c'), scopeBinding: scope, expectedDeploymentPin: pin,
  invocation: { program: 'node', argv: ['server.mjs', '--literal', 'a b'], cwd: '.' }, limits,
  phase: 'discover', origin: { kind: 'stdio_discovery', requestId: id(7) } }
const raw = JSON.parse('{"name":"echo\\u0000tool","inputSchema":{"type":"object","properties":{"10":{"type":"string"},"2":{"type":"number"}}},"_meta":{"literal":"a\\u0000b"},"__proto__":{"safe":true},"extension":[1,true,null]}')
const schemas = stdioTaskSchemasV2(limits)

test('raw directory validation preserves schema, escaped NUL, extensions and prototype-like data', () => {
  const tools = [raw]
  assert.equal(stdioCatalogV2(limits).parse(tools), tools)
  assert.deepEqual(tools[0], raw)
  assert.equal(Object.hasOwn(tools[0], '__proto__'), true)
  assert.equal(Object.hasOwn(Object.prototype, 'safe'), false)
  for (const value of [[raw, raw], [{ ...raw, inputSchema: {} }], [{ ...raw, name: '' }]]) {
    assert.equal(stdioCatalogV2(limits).safeParse(value).success, false)
  }
})

test('check requires an explicit Session and target and refuses caller owner, operation or image selection', () => {
  const check = { requestId: id(7), connectionId: id(6), expectedRevision: 1, sessionId: id(5), target: { kind: 'cloud' } }
  assert.equal(stdioCheckRequestV2.safeParse(check).success, true)
  for (const field of ['userId', 'operationId', 'image']) assert.equal(stdioCheckRequestV2.safeParse({ ...check, [field]: id(1) }).success, false)
  const { sessionId: _session, ...missing } = check
  assert.equal(stdioCheckRequestV2.safeParse(missing).success, false)
})

test('discovery origin has no operation while calls retain the entire accepted raw selection', () => {
  assert.equal(schemas.task.safeParse(task).success, true)
  assert.equal(schemas.task.safeParse({ ...task, origin: { ...task.origin, operationId: id(8) } }).success, false)
  const selection = { catalogId: id(10), catalogDigest: sha('d'), rawCatalog: [raw],
    catalogImageExpectation: { kind: 'cloud', platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
    rawName: raw.name, rawDescriptor: raw, arguments: JSON.parse('{"value":"a\\u0000b","__proto__":"literal"}') }
  const call = { ...task, phase: 'call', origin: { kind: 'operation', operationId: id(8), rootOperationId: id(8), callKey: 'call:1' }, selection }
  const parsed = schemas.task.parse(call)
  assert.equal(parsed.phase, 'call')
  if (parsed.phase !== 'call') throw new Error('call_expected')
  assert.equal(parsed.selection.rawCatalog, selection.rawCatalog)
  assert.equal(parsed.selection.arguments, selection.arguments)
  assert.equal(schemas.task.safeParse({ ...call, selection: { ...selection, rawDescriptor: { ...raw, extension: [2] } } }).success, false)
  assert.equal(schemas.task.safeParse({ ...call, origin: task.origin }).success, false)
  for (const image of [
    { ...selection.catalogImageExpectation, runtimeImageId: pin.configImageId },
    { ...selection.catalogImageExpectation, imageReference: `registry.example/runner@sha256:${sha('b')}` },
    { ...selection.catalogImageExpectation, platform: { ...platform, architecture: 'amd64' } },
  ]) assert.equal(schemas.task.safeParse({ ...call, selection: { ...selection, catalogImageExpectation: image } }).success, false)
})

test('Device catalog image comparison uses the exact trusted Docker config ID and platform', () => {
  const deployment = stdioDeploymentV2.parse({ kind: 'desktop', deploymentId: id(9), protocolVersion: 2,
    platform, configImageId: pin.configImageId })
  const image = stdioExecutorImageV2.parse({ kind: 'desktop', platform, configImageId: pin.configImageId })
  if (image.kind !== 'desktop') throw new Error('desktop_image_expected')
  assert.equal(stdioImageMatchesDeploymentV2(deployment, image), true)
  assert.equal(stdioImageMatchesDeploymentV2(deployment, { ...image, configImageId: `sha256:${sha('a')}` }), false)
  assert.equal(stdioImageMatchesDeploymentV2(deployment, { ...image, platform: { os: 'linux', architecture: 'amd64' } }), false)
})

test('task rejects wrong owner, writable Home, target, deployment or frozen budgets', () => {
  for (const value of [
    { ...task, userId: id(11) },
    { ...task, scopeBinding: { ...scope, home: { kind: 'user', userId: id(11) } } },
    { ...task, limits: { ...limits, maxResultBytes: 4096 } },
    { ...task, invocation: { ...task.invocation, cwd: '../outside' } },
    { ...task, invocation: { ...task.invocation, argv: ['a\0b'] } },
    { ...task, expectedDeploymentPin: { ...pin, kind: 'desktop' } },
  ]) assert.equal(schemas.task.safeParse(value).success, false)
})

test('whole task and individual raw descriptors use complete JSON budgets', () => {
  assert.equal(stdioTaskSchemasV2({ ...limits, maxInputBytes: 32 }).task.safeParse(task).success, false)
  assert.equal(stdioCatalogV2({ ...limits, maxToolBytes: 8 }).safeParse([raw]).success, false)
  assert.equal(stdioCatalogV2({ ...limits, maxTools: 1 }).safeParse([raw, { ...raw, name: 'other' }]).success, false)
  let calls = 0
  const getter = Object.defineProperty({}, 'name', { enumerable: true, get() { calls++; return 'tool' } })
  assert.equal(stdioJsonV2({ maxDepth: 32, maxNodes: 10, maxBytes: 100 }).safeParse(getter).success, false)
  assert.equal(calls, 0)
})

test('Prepared binds exact image kind and raw imageID without stripping prefixes or substituting config digest', () => {
  const prepared = { formatVersion: 2, actionId: task.actionId, executionRef: { kind: 'cloud', executionId: id(12) },
    taskDigest: sha('d'), scopeBinding: scope, fullScopeDigest: sha('e'), expectedDeploymentPin: pin,
    actualExecutorImage: { kind: 'cloud', platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
    capture: { kind: 'cloud', podUid: id(13), podName: 'runner-1', namespace: 'qa', nodeName: 'node-1',
      runnerInstanceId: id(14), containerId: `containerd://${sha('f')}`, restartCount: 0, mountGeneration: '2',
      workspaceMount: { claimName: 'data', subPath: 'workspaces/project', mountPath: '/workspace', readOnly: false },
      homeMount: { claimName: 'data', subPath: 'homes/user', mountPath: '/home/agent', readOnly: false } }, specDigest: sha('f') }
  assert.equal(stdioPreparedV2.safeParse(prepared).success, true)
  for (const image of [
    { ...prepared.actualExecutorImage, runtimeImageId: `sha256:${sha('a')}` },
    { ...prepared.actualExecutorImage, runtimeImageId: pin.configImageId },
    { ...prepared.actualExecutorImage, platform: { ...platform, architecture: 'amd64' } },
    { ...prepared.actualExecutorImage, imageReference: `registry.example/runner@sha256:${sha('b')}` },
  ]) assert.equal(stdioPreparedV2.safeParse({ ...prepared, actualExecutorImage: image }).success, false)
  assert.equal(stdioPreparedV2.safeParse({ ...prepared, capture: { ...prepared.capture, restartCount: -1 } }).success, false)
})

test('once permit and dispatch bind one original action, execution and fixed approval epoch', () => {
  const permit = { actionId: task.actionId, taskDigest: sha('a'), preparedDigest: sha('b'), approvalEpoch: 1,
    expiresAt: '2026-10-07T12:00:00Z', issuedAt: '2026-10-07T11:00:00Z', permitId: id(16), authorizationRequestId: id(17),
    executionRef: { kind: 'cloud', executionId: id(12) }, executorOwner: { kind: 'cloud', runnerInstanceId: id(14) },
    approvalFingerprint: sha('c') }
  const envelope = { formatVersion: 2, task, taskDigest: sha('a'), executionRef: permit.executionRef,
    preparedDigest: sha('b'), permit }
  assert.equal(stdioStartAuthorizationV2.safeParse({ grantOnce: true, permit }).success, true)
  assert.equal(stdioStartAuthorizationV2.safeParse({ grantOnce: false, permit }).success, true)
  assert.equal(stdioDispatchV2(limits).safeParse(envelope).success, true)
  for (const value of [
    { ...envelope, taskDigest: sha('d') },
    { ...envelope, executionRef: { kind: 'cloud', executionId: id(18) } },
    { ...envelope, permit: { ...permit, actionId: id(19) } },
    { ...envelope, permit: { ...permit, approvalEpoch: 2 } },
    { ...envelope, permit: { ...permit, issuedAt: permit.expiresAt } },
  ]) assert.equal(stdioDispatchV2(limits).safeParse(value).success, false)
})
