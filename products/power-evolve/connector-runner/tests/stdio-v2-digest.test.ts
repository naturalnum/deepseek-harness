/** Deterministic shared encoding and domain checks; no real secret, process, service or durable resource. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { stdioSha256V2, stdioCatalogFingerprintV2, stdioApprovalFingerprintV2 } from '../src/stdio-v2-digest.ts'
import { stdioLimitsV2 } from '@power-evolve/contracts/stdio-mcp'

const budgets = { maxDepth: 32, maxNodes: 5000, maxBytes: 65536 }
const limits = stdioLimitsV2.parse({ runtimeMs: 10000, requestMs: 2000, stdinGraceMs: 0, terminateGraceMs: 0,
  killGraceMs: 1000, maxInputBytes: 65536, maxMessageBytes: 8192, maxProtocolBytes: 131072,
  maxProtocolMessages: 100, maxJsonDepth: 32, maxJsonNodes: 5000, maxPages: 10, maxTools: 20,
  maxCatalogBytes: 16384, maxToolBytes: 8192, maxResultBytes: 8192, maxStderrBytes: 1024 })

test('SHA uses literal lexical JSON bytes including numeric keys and the fixed purpose domain', () => {
  const value = { '2': 'two', '10': 'ten', z: 'a\0b' }
  const expected = '{"domain":"power-evolve-stdio-task-v2","value":{"10":"ten","2":"two","z":"a\\u0000b"}}'
  assert.equal(stdioSha256V2('task', value, budgets), createHash('sha256').update(expected).digest('hex'))
  assert.notEqual(stdioSha256V2('task', value, budgets), stdioSha256V2('prepared', value, budgets))
  assert.throws(() => stdioSha256V2('task', value, { ...budgets, maxBytes: 10 }), { name: 'RangeError' })
})

test('full catalog fingerprint changes for schema, extension, metadata and directory changes', () => {
  const tool = { name: 'echo', inputSchema: { type: 'object' }, _meta: { text: 'a\0b' }, extension: true }
  const original = stdioCatalogFingerprintV2([tool], limits)
  for (const changed of [{ ...tool, extension: false }, { ...tool, _meta: { text: 'a' } },
    { ...tool, inputSchema: { type: 'object', properties: { field: { type: 'string' } } } }]) {
    assert.notEqual(stdioCatalogFingerprintV2([changed], limits), original)
  }
  assert.notEqual(stdioCatalogFingerprintV2([tool, { ...tool, name: 'second' }], limits), original)
  assert.throws(() => stdioCatalogFingerprintV2([tool, tool], limits))
})

test('approval HMAC remains separate from public digests and refuses invalid key or partial JSON', () => {
  const key = Buffer.alloc(32, 7), value = { epoch: 1 }
  const text = '{"domain":"power-evolve-stdio-approval-v2","value":{"epoch":1}}'
  assert.equal(stdioApprovalFingerprintV2(key, value, budgets), createHmac('sha256', key).update(text).digest('hex'))
  assert.notEqual(stdioApprovalFingerprintV2(key, value, budgets), stdioSha256V2('prepared', value, budgets))
  assert.throws(() => stdioApprovalFingerprintV2(Buffer.alloc(31), value, budgets), { name: 'TypeError' })
  assert.throws(() => stdioApprovalFingerprintV2(key, { missing: undefined }, budgets), { name: 'TypeError' })
})
