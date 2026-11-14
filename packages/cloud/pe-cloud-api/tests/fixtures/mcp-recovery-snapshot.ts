/** Shipped-profile recording of one saved zero-tool connection recovered through the original account Gateway. */
import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { CloudAccountFiles } from '@deepseek-ai/dsh-pe-cloud-files'
import { installAccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/src/binding.ts'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { startHttpMcpFixture } from '../../../../mcp/mcp-client/tests/http-fixture.ts'
import { CloudAccountApi } from '../../src/account-service.ts'
import { ConfigSaveCoordinator } from '../../src/config-saves.ts'
import { ExposurePolicy } from '../../src/exposure.ts'
import type { CloudMcpConnectionRequest, CloudMcpConnectionReply } from '../../src/mcp-types.ts'
import type { ApprovedMcpConnections } from '../../src/mcp-policy.ts'
import type { ExposureManifest } from '../../src/types.ts'

export const name = 'mcp-recovery-snapshot'
export const inject = ['loader', 'typertGateway', 'tools', 'agents', 'storageDomain', 'credentials']

const policy: ApprovedMcpConnections = {
  limits: { maxConnections: 4, maxUrlBytes: 2048, maxHeaderBytes: 4096, maxHeaderCount: 8,
    maxToolCallTimeoutMs: 2000, maxRequestBytes: 20000, maxReplyBytes: 65536 },
  runtime: { maxInstructionBytes: 4096, maxIncomingResponseBytes: 4194304, listMaxPages: 4,
    reconnect: { enabled: false, initialDelayMs: 20, maxDelayMs: 50, maxAttempts: 2 } },
}

/** @param owner Scenario-only assembly inside the shipped headless profile; no Root readiness or live account is supplied. */
export async function apply(owner: Context): Promise<void> {
  const ctx = owner.root, lifetime = new AbortController(), project = process.cwd()
  const binding = installAccountBinding(ctx, { accountId: brandString<AccountBinding['accountId']>('snapshot-mcp-recovery'),
    epoch: brandString<AccountBinding['epoch']>('1'), recipeVersion: 'mcp-recovery-snapshot', lifetime: lifetime.signal })
  const current = (): void => {
    lifetime.signal.throwIfAborted(); ctx.fiber.assertActive()
    assert.equal(ctx.get('peAccount'), binding)
  }
  const saves = new ConfigSaveCoordinator({ maxAccounts: 1, maxRunning: 1, maxQueued: 2, maxQueuedPerAccount: 2,
    maxTrackedOperations: 8, maxTrackedOperationsPerAccount: 8, maxNestedPerOperation: 16, maxWaitersPerAccount: 2 })
  const barrier = saves.createAccount(binding), external = await startHttpMcpFixture()
  ctx.effect(() => async () => {
    try { await external.close() }
    finally {
      await barrier.stopConfigSaves(Date.now() + 2000)
      saves.releaseAccount(barrier); saves.close(); lifetime.abort()
    }
  }, 'snapshot: close owned HTTP endpoint and original save coordinator')

  const manifest: ExposureManifest = { recipeVersion: binding.recipeVersion,
    rpcEndpoints: [{ endpoint: 'cloudMcpConnections/action', handlerId: 'native:cloudMcpConnections', guard: 'authenticated-account' }],
    streamEndpoints: [], exactFetchRoutes: [], allowedSettings: [] }
  const peer: PeerScope = { id: brandString<PeerId>('snapshot-mcp-peer'), ctx, principal: { kind: 'owner' },
    interactions: 'answer', signal: lifetime.signal, dispose: () => Promise.resolve() }
  const api = new CloudAccountApi(ctx, { binding, saves: barrier, selected: manifest, rootExposure: new ExposurePolicy(manifest),
    maxNativeInventoryEntries: 16,
    assertMountCurrent: current, assertBusinessCurrent: current,
    withPeerUse(actual, consume) {
      assert.equal(actual, peer); current()
      return consume({ binding, context: ctx, assertCurrent: current, release() {} }, current)
    },
  })
  // This scenario supplies only account-private MCP storage, never project or execution readiness.
  class ClosedProjects extends WorkspaceRegistry {
    async createProject(): Promise<never> { throw new Error('No project registration in the MCP recording') }
    async createAdmittedProject(): Promise<never> { throw new Error('No project registration in the MCP recording') }
    async createS2Project(): Promise<never> { throw new Error('No project registration in the MCP recording') }
  }
  const info = statSync(project, { bigint: true })
  const files = new CloudAccountFiles(ctx, { binding, port: { createWorkspaceRegistry: () => ClosedProjects },
    defaultGrant: { binding, backend: 'root-owned-isolated-linux-tmpfs', leaf: 'default-workspace',
      parent: { rootPath: project, rootDevice: String(info.dev), rootInode: String(info.ino) }, assertExclusive: current },
    assertMountCurrent: current, assertUnpublished: current })
  const mcp = await api.prepareCloudMcpConnections(ctx, { files, policy, assertBusinessCurrent: current,
    assertToolCurrent(exec) {
      current(); exec.signal?.throwIfAborted()
      if (exec.agent === undefined) throw new Error('The recovered tool requires the original Agent')
      assert.ok(ctx.agents.get(exec.agent.id))
    },
  })
  api.audit(mcp.inspect())
  const invoke = (request: CloudMcpConnectionRequest): Promise<CloudMcpConnectionReply> => ctx.typertGateway.invoke({
    namespace: 'cloudMcpConnections', method: 'action', args: { request }, peer,
  }) as Promise<CloudMcpConnectionReply>

  external.setAvailable(false)
  const initial = await invoke({ action: 'list' })
  const definition = { serverName: 'recovery', url: external.url, enabled: true, toolCallTimeoutMs: 1000 }
  const saved = await invoke({ action: 'save', version: initial.version, connection: definition }), row = saved.connections[0]
  assert.ok(row)
  assert.equal(row.toolCount, 0)
  assert.equal(ctx.tools.schemas().some(tool => tool.name === 'mcp__recovery__ping'), false)
  external.setAvailable(true)
  const recovered = await invoke({ action: 'test', id: row.id, connection: definition })
  assert.deepEqual(recovered.test, { reachable: true, toolCount: 1 })
  if (recovered.test?.reachable !== true) throw new Error('The original saved-connection probe did not succeed')
  assert.deepEqual(recovered.connections, [{ ...row, toolCount: 1 }])
  assert.equal(recovered.version, saved.version)
  assert.deepEqual(external.calls, [])
  assert.deepEqual(barrier.snapshot().failures, [])

  const audit = { synthetic: true, before: row.toolCount, probeReachable: recovered.test.reachable,
    probeTools: recovered.test.toolCount, restored: recovered.connections[0]?.toolCount,
    definitionUnchanged: recovered.version === saved.version, calls: external.calls.length }
  const writeAudit = (): void => { writeFileSync(join(project, 'mcp-recovery-audit.json'), JSON.stringify(audit) + '\n') }
  writeAudit()
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.name === 'mcp__recovery__ping') {
      assert.deepEqual(external.calls, ['ping'])
      audit.calls = external.calls.length; writeAudit()
    }
    return result
  })
}
