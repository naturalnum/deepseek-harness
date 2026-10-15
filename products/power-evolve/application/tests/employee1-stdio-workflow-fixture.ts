/** Real PG STDIO services; private writer observations are synthetic inputs, with no Pod or user program started. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { StdioConfigurationV2 } from '@power-evolve/contracts/stdio-management'
import type { PoolClient } from 'pg'
import { stdioCheckRequestV2, stdioCloudDeploymentV2, stdioPreparedV2, stdioReceiptRequestV2,
  type StdioExecutionRefV2, type StdioTaskV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioCloudStopEvidenceV2, stdioRuntimeViewV2, stdioWorkerIdV2,
  type StdioActionLeaseV2, type StdioCloudObservationV2 } from '@power-evolve/contracts/stdio-runtime'
import { stdioSha256V2, type StdioDigestDomainV2 } from '@power-evolve/connector-runner/stdio-v2-digest'
import { cloudFixture } from './cloud-fixture.ts'
import { seedNewUser } from '../src/platform/account-settings.ts'
import { hashPassword } from '../src/platform/identity.ts'
import { TaskStore } from '../src/platform/tasks.ts'
import { StdioConnectionServiceV2 } from '../src/platform/stdio-v2-connections.ts'
import { StdioAdmissionServiceV2 } from '../src/platform/stdio-v2-admission.ts'
import { StdioActionServiceV2 } from '../src/platform/stdio-v2-actions.ts'
import { StdioAuthorizationServiceV2 } from '../src/platform/stdio-v2-authorization.ts'
import { StdioCloudWorkerStoreV2 } from '../src/platform/stdio-v2-worker-store.ts'
import { StdioResultServiceV2 } from '../src/platform/stdio-v2-results.ts'
import { StdioOperationAdmissionV2 } from '../src/platform/stdio-v2-operation-admission.ts'
import { StdioCallAdmissionV2 } from '../src/platform/stdio-v2-call-admission.ts'
import { StdioCallContinuationV2 } from '../src/platform/stdio-v2-continuations.ts'
import type { SandboxReady } from '../src/platform/sandbox.ts'
import { requestId } from '../src/contracts.ts'

/** Frozen fixture SDK limits, also checked by every task/result parser. */
export const workflowLimits = { runtimeMs: 10_000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 100, killGraceMs: 1000,
  maxInputBytes: 65_536, maxMessageBytes: 8192, maxProtocolBytes: 131_072, maxProtocolMessages: 100,
  maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16_384,
  maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 }
/** Complete raw descriptors retain extensions and literal text through PG JSON. */
export const workflowCatalog = [{ name: 'echo_note', description: '原文', inputSchema: { type: 'object',
  properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
_meta: { original: 'raw\0😀' }, extension: [3, 1] }]
const management = { maxNameBytes: 80, pageItems: 2, maxConnections: 4 }
const admissionLimits = { maxConnections: 4, maxTools: 20, maxSnapshotBytes: 262_144, maxDescriptionBytes: 1024 }
const maxReplyBytes = 131_072
/** Allocate a fresh protocol receipt identity.
 * @returns Validated STDIO management request UUID.
 */
export const workflowRequest = () => stdioReceiptRequestV2.shape.requestId.parse(randomUUID())
/** Compute the real domain digest under the fixture's frozen budget.
 * @param domain Protocol digest domain.
 * @param value Original JSON input.
 * @returns Domain-separated immutable digest.
 */
export const workflowDigest = (domain: StdioDigestDomainV2, value: unknown) => stdioSha256V2(domain, value,
  { maxDepth: workflowLimits.maxJsonDepth, maxNodes: workflowLimits.maxJsonNodes, maxBytes: workflowLimits.maxInputBytes })

async function createWorkflow(base: Parameters<Parameters<typeof cloudFixture>[0]>[0], approvalLifetimeMs: number,
  configure?: (pool: typeof base.pool, owner: Awaited<ReturnType<typeof base.identities.login>>) =>
  Promise<Partial<StdioConfigurationV2>>) {
  const { pool, files, identities, bob } = base, password = randomUUID()
  await seedNewUser(pool, 'stdio-owner', await hashPassword(password), { model: 'trial-model', maxTokens: 1000, revision: 1 })
  const owner = await identities.login('stdio-owner', password), approval = await identities.login('stdio-owner', password, 'approval')
  const deployment = stdioCloudDeploymentV2.parse({ kind: 'cloud', deploymentId: randomUUID(), protocolVersion: 2,
    platform: { os: 'linux', architecture: 'arm64' }, imageReference: `fixture.invalid/runner@sha256:${'a'.repeat(64)}`,
    configImageId: `sha256:${'a'.repeat(64)}`, runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] })
  const selection = new StdioOperationAdmissionV2(files, { limits: workflowLimits, admission: admissionLimits,
    maxReplyBytes, cloudDeployment: deployment })
  const tasks = new TaskStore(pool, { maxEventBytes: 524_288, leaseMs: 60_000, maxPendingPerUser: 8, maxActivePerUser: 1,
    stdioV2Admission: { selection, reservedNames: [] } })
  const connections = new StdioConnectionServiceV2(pool, workflowLimits, management)
  const actions = new StdioActionServiceV2(pool, { limits: workflowLimits, maxReplyBytes, maxPageSize: management.pageItems })
  const admission = new StdioAdmissionServiceV2(pool, files, { limits: workflowLimits, management,
    maxPendingPerUser: 4, deployments: { cloud: deployment } })
  const continuation = new StdioCallContinuationV2({ limits: workflowLimits, maxReplyBytes, admission: admissionLimits })
  const store = new StdioCloudWorkerStoreV2(pool, { limits: workflowLimits, leaseMs: 60_000, maxActive: 2, maxCandidates: 8, continuation })
  const results = new StdioResultServiceV2(pool, { limits: workflowLimits, maxReplyBytes, continuation })
  const calls = new StdioCallAdmissionV2(tasks, selection, files, { limits: workflowLimits, cloudDeployment: deployment,
    maxPendingPerUser: 4, maxCallsPerChain: 4, chainLifetimeMs: 600_000, reservedNames: [] })
  let writer: SandboxReady | undefined
  const capture = async (_client: PoolClient, task: StdioTaskV2, executionRef: StdioExecutionRefV2) => {
    if (!writer) throw new Error('Fixture writer must be attached before synthetic capture')
    const observed = { kind: 'cloud' as const, podUid: writer.podUid, podName: writer.name, namespace: 'unused-pg-fixture',
      nodeName: 'synthetic-node', runnerInstanceId: writer.runnerInstanceId, containerId: 'containerd://synthetic-container',
      restartCount: 0, mountGeneration: writer.generation,
      workspaceMount: { claimName: 'synthetic-claim', subPath: `workspaces/${writer.binding.rootKey}`, mountPath: '/workspace' as const, readOnly: false as const },
      homeMount: { claimName: 'synthetic-claim', subPath: `homes/${task.userId}`, mountPath: '/home/agent' as const, readOnly: false as const } }
    return stdioPreparedV2.parse({ formatVersion: 2, actionId: task.actionId, executionRef, taskDigest: workflowDigest('task', task),
      scopeBinding: task.scopeBinding, expectedDeploymentPin: task.expectedDeploymentPin,
      actualExecutorImage: { kind: 'cloud', platform: deployment.platform, imageReference: deployment.imageReference, runtimeImageId: deployment.runtimeImageIds[0] },
      capture: observed, specDigest: workflowDigest('spec', { fixture: 'synthetic-private-capture', invocation: task.invocation }),
      fullScopeDigest: workflowDigest('scope', { scopeBinding: task.scopeBinding, workspaceMount: observed.workspaceMount, homeMount: observed.homeMount }) })
  }
  const authorization = new StdioAuthorizationServiceV2(pool, { limits: workflowLimits, approvalKey: randomBytes(32),
    approvalLifetimeMs, capture })
  const session = await tasks.create(owner.user, requestId.parse(randomUUID()), owner.token)
  const configuration = { ...await configure?.(pool, owner), name: 'Workflow process', invocation: { program: 'node', argv: ['', 'literal;$(not-a-shell)', '中文'], cwd: '.' } }
  const connection = await connections.create(owner.token, { requestId: workflowRequest(), configuration })
  const discovery = await admission.check(owner.token, stdioCheckRequestV2.parse({ requestId: workflowRequest(),
    connectionId: connection.connectionId,
    expectedRevision: 1, sessionId: session.sessionId, target: { kind: 'cloud' } }))
  const claim = async () => {
    const lease = await store.claimNext(stdioWorkerIdV2.parse(randomUUID()))
    if (!lease) throw new Error('Fixture action must be claimable')
    return lease
  }
  const prepare = async (lease: StdioActionLeaseV2) => {
    await store.beginPreparation(lease)
    const snapshot = await store.snapshot(lease)
    const binding = await files.bindingForId(owner.user.userId, snapshot.task.scopeBinding.workspaceId)
    if (!writer) writer = { name: `synthetic-${randomUUID()}`, podUid: randomUUID(), runnerInstanceId: randomUUID(),
      token: randomUUID(), restartCount: 0, generation: '1', sessionId: session.sessionId, userId: owner.user.userId, binding }
    await pool.query(`INSERT INTO pe_mount_slots(user_id,session_id,workspace_id,generation,state,pod_uid,runner_instance_id,binding_snapshot)
      VALUES($1,$2,$3,1,'ready',$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET session_id=$2,workspace_id=$3,generation=1,
      state='ready',pod_uid=$4,runner_instance_id=$5,binding_snapshot=$6`, [writer.userId, writer.sessionId, binding.workspaceId,
      writer.podUid, writer.runnerInstanceId, JSON.stringify(binding)])
    await pool.query(`INSERT INTO pe_sandbox_instances(session_id,user_id,name,state,pod_uid,runner_instance_id,binding_snapshot)
      VALUES($1,$2,$3,'ready',$4,$5,$6) ON CONFLICT(session_id) DO NOTHING`, [writer.sessionId, writer.userId, writer.name,
      writer.podUid, writer.runnerInstanceId, JSON.stringify(binding)])
    await store.attach(lease, writer)
    return authorization.prepareLeased(lease)
  }
  const approve = async (lease: StdioActionLeaseV2) => {
    const prepared = await prepare(lease)
    await authorization.decide(approval.token, { actionId: lease.actionId, fingerprint: prepared.fingerprint, decision: 'once' })
    return prepared
  }
  const dispatch = async (lease: StdioActionLeaseV2) => {
    const snapshot = await store.snapshot(lease)
    if (!snapshot.prepared) throw new Error('Fixture requires preparation')
    return authorization.authorizeLeased(lease, workflowRequest(), { kind: 'cloud', runnerInstanceId: snapshot.prepared.prepared.capture.runnerInstanceId })
  }
  const observe = async (lease: StdioActionLeaseV2, state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown', quiet: boolean): Promise<StdioCloudObservationV2> => {
    const snapshot = await store.snapshot(lease), prepared = snapshot.prepared?.prepared
    if (!prepared || !snapshot.dispatch) throw new Error('Fixture requires committed dispatch')
    const dispatchDigest = workflowDigest('dispatch', snapshot.dispatch), phase = snapshot.task.phase
    const facts = { programStartAttempted: true, toolsCallAttempted: phase === 'call', effectMayHaveOccurred: true,
      childPid: 123, childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null,
      cleanupConfirmed: true, protocolBytes: 200, protocolMessages: 4, stderrBytes: 0, stderr: '' }
    const outcome = state === 'failed' || state === 'cancelled' || state === 'unknown'
      ? { state: 'failed', errorCode: 'synthetic_outcome', facts }
      : { state: 'completed', phase, catalog: structuredClone(workflowCatalog), pages: [{ tools: structuredClone(workflowCatalog), extension: 'full' }],
        initializeResult: { protocolVersion: 'synthetic', _meta: { retained: true } }, facts,
        ...(phase === 'call' ? { result: { content: [{ type: 'text', text: 'full\0😀' }], isError: true, extension: { ordered: [3, 1] } } } : {}) }
    const view = stdioRuntimeViewV2(workflowLimits, maxReplyBytes).parse({ formatVersion: 2, instanceId: prepared.capture.runnerInstanceId,
      actionId: lease.actionId, executionRef: snapshot.executionRef, taskDigest: snapshot.taskDigest, dispatchDigest, state,
      writerStopConfirmed: ['completed', 'failed', 'cancelled'].includes(state), ...(state === 'running' ? {} : { outcome }) })
    const stopEvidence = quiet ? stdioCloudStopEvidenceV2.parse({ formatVersion: 2, kind: 'cloud_uid_quiet', actionId: lease.actionId,
      executionRef: snapshot.executionRef, taskDigest: snapshot.taskDigest, dispatchDigest,
      preparedDigest: snapshot.prepared.preparedDigest,
      fullScopeDigest: prepared.fullScopeDigest, podUid: prepared.capture.podUid, runnerInstanceId: prepared.capture.runnerInstanceId,
      mountGeneration: prepared.capture.mountGeneration, observedAt: new Date().toISOString() }) : null
    return { view, stopEvidence }
  }
  const startCall = async () => {
    const discoveryLease = await claim()
    await approve(discoveryLease); await dispatch(discoveryLease)
    await results.record(discoveryLease, await observe(discoveryLease, 'completed', true))
    await store.release(discoveryLease)
    await connections.toggle(owner.token, { requestId: workflowRequest(), connectionId: connection.connectionId,
      expectedRevision: 1, enabled: true })
    await tasks.accept(owner.user, session.sessionId, requestId.parse(randomUUID()), 'Use original STDIO tool', owner.token)
    const grant = await tasks.claim(randomUUID())
    if (!grant) throw new Error('Original operation must be claimable')
    const tool = grant.stdioV2Connections[0]?.tools[0]
    if (!tool) throw new Error('Original catalog must supply a compiled tool')
    const input = { callKey: 'native-call-1', toolName: tool.model.name, arguments: { message: 'original\0😀' } }
    const call = await calls.propose(grant.token, input)
    return { grant, input, call }
  }
  return { pool, files, identities, owner, approval, foreign: bob, tasks, connections, admission, actions, authorization, store, results,
    calls, selection, session, connection, discovery, configuration, deployment, claim, prepare, approve, dispatch, observe, startCall,
    writer: () => { if (!writer) throw new Error('Fixture writer missing'); return structuredClone(writer) } }
}

/** Execute one service workflow against an owned empty database and synthetic private observations.
 * @param run Behavior assertions; all spawned promises must settle before return.
 * @param approvalLifetimeMs Trusted fixture approval lifetime; no stored binding is rewritten to simulate expiry.
 * @returns Completion after the fixture releases only its own database and temporary files.
 */
export async function stdioWorkflow(run: (fixture: Awaited<ReturnType<typeof createWorkflow>>) => Promise<void>,
  approvalLifetimeMs = 300_000,
  configure?: Parameters<typeof createWorkflow>[2]): Promise<void> {
  return cloudFixture(async base => run(await createWorkflow(base, approvalLifetimeMs, configure)))
}
