/** Synthetic raw runtime records; parsing does not authenticate a worker or private stop observer. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { stdioLimitsV2 } from '../src/stdio-mcp.ts'
import { stdioOutcomeV2, stdioRuntimeViewV2, stdioActionLeaseV2, stdioCloudStopEvidenceV2 } from '../src/stdio-runtime.ts'

const uuid = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64)
const limits = stdioLimitsV2.parse({ runtimeMs: 10000, requestMs: 1000, stdinGraceMs: 0, terminateGraceMs: 0, killGraceMs: 100,
  maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 65536, maxProtocolMessages: 50,
  maxJsonDepth: 20, maxJsonNodes: 2000, maxPages: 4, maxTools: 8, maxCatalogBytes: 16000,
  maxToolBytes: 8000, maxResultBytes: 8000, maxStderrBytes: 1000 })
const raw = JSON.parse('{"_meta":{"literal":"a\\u0000b"},"10":"十","2":"二","__proto__":{"literal":true}}')
const facts = { programStartAttempted: true, toolsCallAttempted: false, effectMayHaveOccurred: true, childPid: 3,
  childExitObserved: true, childCloseObserved: true, exitCode: 0, signal: null, cleanupConfirmed: true,
  protocolBytes: 100, protocolMessages: 4, stderrBytes: 0, stderr: '' }
const outcome = { state: 'completed', phase: 'discover', catalog: [{ name: 'literal', inputSchema: { type: 'object' }, ...raw }],
  pages: [{ tools: [], ...raw }], initializeResult: { protocolVersion: '2025-03-26', ...raw }, facts }
const view = { formatVersion: 2, instanceId: uuid, actionId: uuid, executionRef: { kind: 'cloud', executionId: uuid },
  taskDigest: digest, dispatchDigest: digest, state: 'completed', writerStopConfirmed: true, outcome }

test('whole raw pages, metadata, catalog and result survive runtime parsing', () => {
  assert.deepEqual(stdioRuntimeViewV2(limits, 65536).parse(view), view)
  const call = { ...outcome, phase: 'call', result: { ...raw, content: [{ type: 'text', text: 'x\0y' }], isError: true } }
  assert.deepEqual(stdioOutcomeV2(limits, 65536).parse(call), call)
})

test('standalone outcome and enclosing view each enforce their whole byte budget', () => {
  const parser = stdioOutcomeV2(limits, 200)
  assert.equal(parser.safeParse(outcome).success, false)
  assert.equal(parser.safeParse({ state: 'failed', errorCode: 'x'.repeat(201), facts }).success, false)
  assert.equal(stdioRuntimeViewV2(limits, 400).safeParse(view).success, false)
  assert.throws(() => stdioOutcomeV2(limits, 0), /reply_budget_invalid/u)
})

test('runtime finality remains separate from direct-child closure and lease identity', () => {
  const parser = stdioRuntimeViewV2(limits, 65536)
  assert.equal(parser.safeParse({ ...view, writerStopConfirmed: false }).success, false)
  assert.equal(parser.safeParse({ ...view, state: 'unknown', writerStopConfirmed: false }).success, true)
  assert.equal(parser.safeParse({ ...view, state: 'running' }).success, false)
  assert.equal(stdioActionLeaseV2.safeParse({ actionId: uuid, workerId: uuid, leaseEpoch: 0 }).success, false)
  assert.equal(stdioCloudStopEvidenceV2.safeParse({ ...facts, actionId: uuid }).success, false)
})
