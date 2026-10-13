/** Actual Platform persistent-record readers; public pg instances use explicit query rows without opening any connection. */
import { createRequire } from 'node:module'
import { expect, test, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { StdioConnectionServiceV2 } from '../../application/src/platform/stdio-v2-connections.ts'
import { StdioCloudPreparationV2 } from '../../application/src/platform/stdio-v2-cloud-capture.ts'
import type { SandboxManager, SandboxReady } from '../../application/src/platform/sandbox.ts'
import { parseStdioStartV2 } from '../../connector-runner/src/stdio-v2-dispatch.ts'
import { transaction } from '../../application/src/platform/database.ts'
import { ids, limits, management, configuration, wireDigest, wirePacket, image } from './employee1-stdio-consumer-fixture.ts'

type ConsumerPool = ConstructorParameters<typeof StdioConnectionServiceV2>[0]
type ConsumerClient = Parameters<Parameters<typeof transaction>[1]>[0]
const pg: unknown = createRequire(new URL('../../application/package.json', import.meta.url))('pg')
const constructors = z.object({ Pool: z.custom<new () => ConsumerPool>(value => typeof value === 'function'),
  Client: z.custom<new () => ConsumerClient>(value => typeof value === 'function') }).parse(pg)
interface PersistentFixture {
  readonly service: StdioConnectionServiceV2
  readonly queries: { readonly sql: string; readonly parameters: readonly unknown[] }[]
  connections: Record<string, unknown>[]
  request: Record<string, unknown> | undefined
}

async function persistent(run: (fixture: PersistentFixture) => Promise<void>): Promise<void> {
  const pool = new constructors.Pool(), client = new constructors.Client()
  const fixture: PersistentFixture = { service: new StdioConnectionServiceV2(pool, limits, management),
    queries: [], connections: [], request: undefined }
  const query = async (sql: string, parameters: readonly unknown[] = []) => {
    fixture.queries.push({ sql, parameters })
    const rows = (values: unknown[]) => ({ rows: values, rowCount: values.length })
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return rows([])
    if (sql.startsWith('SELECT user_id FROM pe_credentials')) return rows([{ user_id: ids.user }])
    if (sql.includes('FROM pe_credentials')) return rows([{ digest: 'unit-credential-row' }])
    if (sql.includes('FROM pe_users')) return rows([{ userId: ids.user, username: 'employee1-unit', displayName: 'Unit',
      role: 'USER', enabled: true, revision: 1, credentialVersion: 1, passwordChangeRequired: false, deletedAt: null }])
    if (sql.includes('FROM pe_stdio_v2_management_requests')) return rows(fixture.request ? [fixture.request] : [])
    if (sql.includes('FROM pe_stdio_v2_connections')) return rows(fixture.connections)
    throw new Error('Unmodelled persistent-reader SQL: ' + sql)
  }
  Object.defineProperty(client, 'query', { value: query }); Object.defineProperty(client, 'release', { value: vi.fn() })
  Object.defineProperty(pool, 'connect', { value: async () => client })
  try { await run(fixture) }
  finally { await pool.end() }
}
const token = 'employee1_unit_persistent_bearer_'.padEnd(64, 'x')
function connectionRow(): Record<string, unknown> {
  return { id: ids.connection, revision: 1, enabled: false, configuration: structuredClone(configuration),
    config_digest: wireDigest('configuration', configuration), current_catalog_id: null, catalog_digest: null,
    created_at: new Date('2026-10-09T00:00:00.000Z'), updated_at: new Date('2026-10-09T00:00:00.000Z') }
}
function requestRow(purpose: 'create' | 'update' | 'toggle' | 'delete' | 'check'): Record<string, unknown> {
  const select = { requestId: ids.request, connectionId: ids.connection, expectedRevision: 1 }
  const input = purpose === 'create' ? { requestId: ids.request, configuration }
    : purpose === 'update' ? { ...select, configuration }
      : purpose === 'toggle' ? { ...select, enabled: true }
        : purpose === 'delete' ? select : { ...select, sessionId: ids.session, target: { kind: 'cloud' } }
  const receipt = purpose === 'check' ? { requestId: ids.request, purpose, connectionId: ids.connection, revision: 1,
    actionId: ids.action, executionRef: { kind: 'cloud', executionId: ids.execution } }
    : { requestId: ids.request, purpose, connectionId: ids.connection, revision: purpose === 'update' ? 2 : 1,
      enabled: purpose === 'toggle', deleted: purpose === 'delete' }
  return { purpose, request: input, request_digest: wireDigest('management', { purpose, input }), receipt }
}

test('persistent connection listing preserves exact configuration and bounded UUID cursor without writes or process start', () => persistent(async (f) => {
  const row = connectionRow(); f.connections = [row, { ...row, id: ids.other }, row]
  const result = await f.service.list(token, { after: ids.connection })
  expect(result).toEqual({ items: [
    { connectionId: ids.connection, revision: 1, enabled: false, configuration, catalogId: null, catalogDigest: null,
      createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' },
    { connectionId: ids.other, revision: 1, enabled: false, configuration, catalogId: null, catalogDigest: null,
      createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' },
  ], next: ids.other })
  expect(f.queries.find(query => query.sql.includes('FROM pe_stdio_v2_connections'))?.parameters)
    .toEqual([ids.user, ids.connection, 2])
  expect(f.queries.some(query => /^(?:INSERT|UPDATE|DELETE)/u.test(query.sql))).toBe(false)
}))

for (const [name, patch] of [
  ['invalid UTF8 label budget', { configuration: { ...configuration, name: '中文abc' } }],
  ['changed configuration digest', { config_digest: 'f'.repeat(64) }],
  ['missing catalog digest', { current_catalog_id: ids.other }],
  ['orphan catalog digest', { catalog_digest: 'a'.repeat(64) }],
  ['malformed stored timestamp', { updated_at: '2026-10-09T00:00:00.000Z' }],
  ['invalid saved invocation', { configuration: { ...configuration, invocation: { ...configuration.invocation, program: '' } } }],
] as const) {
  test('persistent connection reader rejects ' + name + ' and rolls back without partial page', () => persistent(async (f) => {
    f.connections = [connectionRow(), { ...connectionRow(), ...patch }]
    await expect(f.service.list(token, {})).rejects.toMatchObject({ status: 409, code: 'stdio_v2_record_invalid' })
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK')
    expect(f.queries.some(query => /^(?:INSERT|UPDATE|DELETE)/u.test(query.sql))).toBe(false)
  }))
}

for (const purpose of ['create', 'update', 'toggle', 'delete', 'check'] as const) {
  test('persistent receipt rechecks complete original ' + purpose + ' request and returns the saved receipt without replay', () => persistent(async (f) => {
    f.request = requestRow(purpose)
    expect(await f.service.receipt(token, { requestId: ids.request })).toEqual(f.request.receipt)
    expect(f.queries.some(query => query.sql.includes('INSERT') || query.sql.includes('pe_cloud_executions'))).toBe(false)
    expect(f.queries.filter(query => query.sql.includes('FROM pe_credentials'))).toHaveLength(3)
    expect(f.queries.at(-1)?.sql).toBe('COMMIT')
  }))
}

for (const [name, patch] of [
  ['request digest changed', { request_digest: 'f'.repeat(64) }],
  ['receipt request ID changed', { receipt: { requestId: ids.other, purpose: 'toggle', connectionId: ids.connection,
    revision: 1, enabled: true, deleted: false } }],
  ['receipt purpose changed', { receipt: { requestId: ids.request, purpose: 'delete', connectionId: ids.connection,
    revision: 1, enabled: false, deleted: true } }],
  ['receipt connection changed', { receipt: { requestId: ids.request, purpose: 'toggle', connectionId: ids.other,
    revision: 1, enabled: true, deleted: false } }],
  ['receipt revision changed', { receipt: { requestId: ids.request, purpose: 'toggle', connectionId: ids.connection,
    revision: 2, enabled: true, deleted: false } }],
  ['receipt enabled changed', { receipt: { requestId: ids.request, purpose: 'toggle', connectionId: ids.connection,
    revision: 1, enabled: false, deleted: false } }],
  ['receipt deletion changed', { receipt: { requestId: ids.request, purpose: 'toggle', connectionId: ids.connection,
    revision: 1, enabled: true, deleted: true } }],
  ['private receipt fields', { receipt: { requestId: ids.request, purpose: 'toggle', connectionId: ids.connection,
    revision: 1, enabled: true, deleted: false, permit: {} } }],
] as const) {
  test('persistent receipt refuses ' + name + ' without reconstructing authority or a new mutation', () => persistent(async (f) => {
    f.request = { ...requestRow('toggle'), ...patch }
    await expect(f.service.receipt(token, { requestId: ids.request })).rejects.toMatchObject({ status: 409, code: 'stdio_v2_record_invalid' })
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK')
    expect(f.queries.some(query => /^(?:INSERT|UPDATE|DELETE)/u.test(query.sql))).toBe(false)
  }))
}

test('missing persistent receipt remains a read-only refusal', () => persistent(async (f) => {
  await expect(f.service.receipt(token, { requestId: ids.request })).rejects.toMatchObject({ status: 404, code: 'stdio_v2_request_not_found' })
  expect(f.queries.at(-1)?.sql).toBe('ROLLBACK')
  expect(f.queries.some(query => /^(?:INSERT|UPDATE|DELETE)/u.test(query.sql))).toBe(false)
}))

type ObservedCapture = Awaited<ReturnType<SandboxManager['captureStdioV2']>>
async function preparation(phase: 'discover' | 'call', run: (f: {
  readonly capture: () => ReturnType<StdioCloudPreparationV2['capture']>
  readonly execution: Record<string, unknown>
  readonly observation: ObservedCapture
  readonly queries: string[]
  readonly observe: ReturnType<typeof vi.fn<SandboxManager['observeReady']>>
  readonly packet: ReturnType<typeof parseStdioStartV2>
}) => Promise<void>): Promise<void> {
  const client = new constructors.Client(), packet = parseStdioStartV2(wirePacket(phase), limits)
  const { task, executionRef } = packet.dispatch, scope = task.scopeBinding
  const binding: SandboxReady['binding'] = { workspaceId: scope.workspaceId, spaceId: scope.target.spaceId,
    rootRelativePath: scope.target.rootRelativePath, generation: scope.bindingGeneration,
    rootKey: brandString<SandboxReady['binding']['rootKey']>(ids.other) }
  const writer: SandboxReady = { name: 'unit-writer', userId: task.userId, sessionId: task.sessionId,
    podUid: ids.pod, runnerInstanceId: ids.runner, generation: '1', restartCount: 0,
    token: 'unit-private-sensor-token', binding }
  const execution: Record<string, unknown> = { id: executionRef.executionId, user_id: task.userId, session_id: task.sessionId,
    execution_kind: 'stdio_v2', execution_target: 'cloud', task_version: 2, stdio_phase: task.phase,
    stdio_action_id: task.actionId, stdio_task: structuredClone(task), request_digest: packet.dispatch.taskDigest,
    origin_kind: phase === 'discover' ? 'stdio_discovery' : 'operation', operation_id: phase === 'discover' ? null : ids.other,
    call_id: phase === 'discover' ? null : 'original-call', continuation_request_id: phase === 'discover' ? null : ids.other,
    command: null, cwd: null, state: 'queued', cancel_requested: false,
    sandbox_name: writer.name, pod_uid: writer.podUid, runner_instance_id: writer.runnerInstanceId }
  const observation: ObservedCapture = { actualExecutorImage: structuredClone(image), capture: { kind: 'cloud',
    podUid: brandString<ObservedCapture['capture']['podUid']>(ids.pod), podName: writer.name, namespace: 'unit-private',
    nodeName: 'unit-node', runnerInstanceId: packet.dispatch.permit.executorOwner.runnerInstanceId,
    containerId: image.runtimeImageId, restartCount: 0, mountGeneration: '1',
    workspaceMount: { claimName: 'unit-pvc', subPath: 'owned', mountPath: '/workspace', readOnly: false },
    homeMount: { claimName: 'unit-pvc', subPath: 'home', mountPath: '/home/agent', readOnly: false } },
  spec: { apiVersion: 'v1', metadata: { original: 'complete-unit-spec' } } }
  const queries: string[] = []
  const query = async (sql: string) => {
    queries.push(sql)
    let row: Record<string, unknown>
    if (sql.includes('FROM pe_cloud_executions')) row = execution
    else if (sql.includes('FROM pe_sessions')) row = { id: task.sessionId, user_id: task.userId, workspace_id: scope.workspaceId }
    else if (sql.includes('FROM pe_mount_slots')) row = { user_id: task.userId, session_id: task.sessionId, workspace_id: scope.workspaceId,
      generation: '1', state: 'ready', pod_uid: writer.podUid, runner_instance_id: writer.runnerInstanceId, binding_snapshot: binding }
    else if (sql.includes('FROM pe_sandbox_instances')) row = { session_id: task.sessionId, user_id: task.userId, name: writer.name,
      state: 'ready', pod_uid: writer.podUid, runner_instance_id: writer.runnerInstanceId, binding_snapshot: binding }
    else throw new Error('Unmodelled preparation read: ' + sql)
    return { rows: [row], rowCount: 1 }
  }
  Object.defineProperty(client, 'query', { value: query })
  const observe = vi.fn<SandboxManager['observeReady']>(async () => writer)
  const service = new StdioCloudPreparationV2({ observeReady: observe, captureStdioV2: async () => observation })
  await run({ capture: () => service.capture(client, task, executionRef), execution, observation, queries, observe, packet })
}

for (const phase of ['discover', 'call'] as const) {
  test('Platform preparation consumes the original ' + phase + ' records and exact Cloud image without provisioning or start authority', () => preparation(phase, async (f) => {
    const prepared = await f.capture()
    expect(prepared).toMatchObject({ formatVersion: 2, actionId: ids.action, executionRef: f.packet.dispatch.executionRef,
      taskDigest: f.packet.dispatch.taskDigest, expectedDeploymentPin: f.packet.dispatch.task.expectedDeploymentPin,
      actualExecutorImage: image, capture: f.observation.capture,
      specDigest: wireDigest('spec', f.observation.spec) })
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.queries).toHaveLength(4)
    expect(f.queries.every(sql => sql.startsWith('SELECT'))).toBe(true)
    expect(prepared).not.toHaveProperty('token'); expect(prepared).not.toHaveProperty('permit')
  }))
}

for (const [name, change] of [
  ['runtime ID prefix', (observation: ObservedCapture) => { observation.actualExecutorImage.runtimeImageId = 'original-image' }],
  ['architecture', (observation: ObservedCapture) => { observation.actualExecutorImage.platform.architecture = 'amd64' }],
  ['manifest', (observation: ObservedCapture) => { observation.actualExecutorImage.imageReference = 'registry.invalid/runner@sha256:' + 'f'.repeat(64) }],
] as const) {
  test('Platform preparation refuses substituted observed ' + name + ' before returning Prepared', () => preparation('call', async (f) => {
    change(f.observation)
    await expect(f.capture()).rejects.toThrow('stdio_v2_prepared_image_mismatch')
    expect(f.queries.every(sql => sql.startsWith('SELECT'))).toBe(true)
  }))
}

for (const [name, patch] of [
  ['cancelled execution', { cancel_requested: true }], ['changed task digest', { request_digest: 'f'.repeat(64) }],
  ['wrong original action', { stdio_action_id: ids.other }], ['different saved task', { stdio_task: { formatVersion: 1 } }],
] as const) {
  test('Platform preparation refuses ' + name + ' persistent row without asking for capture', () => preparation('call', async (f) => {
    Object.assign(f.execution, patch)
    await expect(f.capture()).rejects.toMatchObject({ status: 409, code: 'stdio_v2_capture_changed' })
    expect(f.observe).not.toHaveBeenCalled()
  }))
}
