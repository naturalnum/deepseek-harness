/** Synthetic public records only; no program, approval, Platform state or executor is run. */
import { stdioCheckRequestV2 } from '@power-evolve/contracts/stdio-mcp'
import { stdioActionSchemasV2, stdioManagementSchemasV2, stdioPublicConfigV2 } from '@power-evolve/contracts/stdio-management'

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const config = stdioPublicConfigV2.parse({ formatVersion: 2, available: true,
  limits: { runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 1000,
    maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072, maxProtocolMessages: 100,
    maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20, maxCatalogBytes: 16384,
    maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 },
  management: { maxNameBytes: 100, pageItems: 2, maxConnections: 4 }, maxReplyBytes: 131072 })
if (!config.available) throw new Error('Synthetic configuration must be available')
export const available = config
export const management = stdioManagementSchemasV2(config.limits, config.management)
export const actions = stdioActionSchemasV2(config.limits, config.maxReplyBytes, config.management.pageItems)
export const configuration = management.configuration.parse({ name: 'Synthetic echo', invocation: {
  program: 'node', argv: ['synthetic.mjs', '', 'space value', 'literal;$(unused)'], cwd: '.' } })
export const connection = management.connection.parse({ connectionId: id(4), revision: 1, enabled: false, configuration,
  catalogId: null, catalogDigest: null, createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z' })
export const create = management.create.parse({ requestId: id(7), configuration })
export const check = stdioCheckRequestV2.parse({ requestId: id(7), connectionId: id(4), expectedRevision: 1,
  sessionId: id(3), target: { kind: 'cloud' } })
export const receipt = management.mutationReceipt.parse({ requestId: id(7), purpose: 'create',
  connectionId: id(4), revision: 1, enabled: false, deleted: false })
export const checkReceipt = management.checkReceipt.parse({ requestId: id(7), purpose: 'check', connectionId: id(4),
  revision: 1, actionId: id(1), executionRef: { kind: 'cloud', executionId: id(11) } })
export const summary = actions.summary.parse({ formatVersion: 2, actionId: id(1), executionRef: { kind: 'cloud', executionId: id(11) },
  sessionId: id(3), connectionId: id(4), configRevision: 1, phase: 'call', taskDigest: 'e'.repeat(64),
  state: 'succeeded', executionState: 'succeeded', cancelRequested: false,
  createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:01.000Z' })
const pin = { kind: 'cloud', deploymentId: id(6), protocolVersion: 2, platform: { os: 'linux', architecture: 'arm64' },
  imageReference: `synthetic.invalid/runner@sha256:${'a'.repeat(64)}`, configImageId: `sha256:${'b'.repeat(64)}`,
  runtimeImageIds: [`containerd://sha256:${'a'.repeat(64)}`] }
const rawCatalog = JSON.parse('[{"name":"echo","description":"literal\\u0000目录😀","inputSchema":{"type":"object","default":{"__proto__":{"raw":true}}},"_meta":{"__proto__":{"raw":"完整\\u0000😀"}}}]')
export const detail = actions.detail.parse({ ...summary, task: { formatVersion: 2, phase: 'call', actionId: id(1), userId: id(2),
  sessionId: id(3), connectionId: id(4), configRevision: 1, configDigest: 'c'.repeat(64),
  scopeBinding: { kind: 'cloud', userId: id(2), workspaceId: id(5), bindingGeneration: 1,
    target: { spaceId: id(10), rootRelativePath: 'synthetic-project' }, home: { kind: 'user', userId: id(2) } },
  expectedDeploymentPin: pin, invocation: configuration.invocation, limits: config.limits,
  origin: { kind: 'operation', operationId: id(8), rootOperationId: id(8), callKey: 'original-call' },
  selection: { catalogId: id(9), catalogDigest: 'd'.repeat(64), rawCatalog,
    catalogImageExpectation: { kind: 'cloud', platform: pin.platform, imageReference: pin.imageReference, runtimeImageId: pin.runtimeImageIds[0] },
    rawName: 'echo', rawDescriptor: rawCatalog[0], arguments: JSON.parse('{"__proto__":{"literal":"参数\\u0000😀"}}') } },
  outcome: { state: 'completed', phase: 'call', catalog: rawCatalog,
    pages: [JSON.parse('{"tools":[],"_meta":{"__proto__":{"page":"页\\u0000😀"}}}')],
    initializeResult: JSON.parse('{"protocolVersion":"synthetic","_meta":{"__proto__":{"original":true}}}'),
    facts: { programStartAttempted: true, toolsCallAttempted: true, effectMayHaveOccurred: true, childPid: 123,
      childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
      protocolBytes: 100, protocolMessages: 4, stderrBytes: 0, stderr: '' },
    result: JSON.parse('{"content":[{"type":"text","text":"完成\\u0000😀"}],"isError":true,"_meta":{"__proto__":true}}') }, noStart: null })
