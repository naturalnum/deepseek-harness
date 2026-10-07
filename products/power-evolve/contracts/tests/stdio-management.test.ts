/** Synthetic management input checks; no platform identity, execution or approval is created. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { stdioManagementSchemasV2 } from '../src/stdio-management.ts'
import { stdioLimitsV2 } from '../src/stdio-mcp.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const limits = stdioLimitsV2.parse({ runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0,
  killGraceMs: 1000, maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072,
  maxProtocolMessages: 100, maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20,
  maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 })
const schemas = stdioManagementSchemasV2(limits, { maxNameBytes: 8, pageItems: 2, maxConnections: 4 })
const configuration = { name: '测试', invocation: { program: 'node', argv: ['--', 'a b', '$(whoami)', ''], cwd: '.' } }

test('creation preserves individual literal arguments and refuses browser-supplied authority', () => {
  const input = { requestId: id(1), configuration }
  assert.deepEqual(schemas.create.parse(input), input)
  for (const field of ['userId', 'deploymentId', 'enabled', 'grantOnce', 'environment', 'image']) {
    assert.equal(schemas.create.safeParse({ ...input, [field]: field === 'enabled' ? true : id(2) }).success, false)
  }
  assert.equal(schemas.create.safeParse({ ...input, configuration: { ...configuration,
    invocation: { ...configuration.invocation, env: { SECRET: 'value' } } } }).success, false)
})

test('UTF-8 labels, complete JSON and local relative cwd use explicit deployment budgets', () => {
  assert.equal(schemas.configuration.safeParse({ ...configuration, name: '中文名' }).success, false)
  assert.equal(schemas.configuration.safeParse({ ...configuration, name: 'a\0b' }).success, false)
  for (const cwd of ['/tmp', '../other', 'dir/../../other']) {
    assert.equal(schemas.configuration.safeParse({ ...configuration, invocation: { ...configuration.invocation, cwd } }).success, false)
  }
  const small = stdioManagementSchemasV2({ ...limits, maxInputBytes: 80 }, { maxNameBytes: 8, pageItems: 2, maxConnections: 4 })
  assert.equal(small.create.safeParse({ requestId: id(1), configuration }).success, false)
  assert.equal(schemas.create.safeParse({ requestId: id(1), configuration: undefined }).success, false)
})

test('mutation and discovery receipts remain separate and configuration revisions are positive', () => {
  const mutation = { requestId: id(1), purpose: 'create', connectionId: id(2), revision: 1, enabled: false, deleted: false }
  const check = { requestId: id(3), purpose: 'check', connectionId: id(2), revision: 1,
    actionId: id(4), executionRef: { kind: 'cloud', executionId: id(5) } }
  assert.deepEqual(schemas.receipt.parse(mutation), mutation)
  assert.deepEqual(schemas.receipt.parse(check), check)
  assert.equal(schemas.receipt.safeParse({ ...check, grantOnce: true }).success, false)
  assert.equal(schemas.update.safeParse({ requestId: id(1), connectionId: id(2), expectedRevision: 0, configuration }).success, false)
  assert.equal(schemas.listRequest.safeParse({ after: id(2), userId: id(5) }).success, false)
})
