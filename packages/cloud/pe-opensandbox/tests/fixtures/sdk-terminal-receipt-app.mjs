/** Read original proof over the actual bounded SDK transport without an injected receipt digest. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSdkTerminalReceipt } from '../../src/sdk-terminal-receipt.ts'
import { BoundedLifecycleConnection, createOwnedSdkTransport } from '../../src/sdk-transport.ts'

const [directory, port] = process.argv.slice(2)
assert.match(port, /^[1-9][0-9]{1,4}$/)
const { intent, binding } = JSON.parse(readFileSync(join(directory, 'before-terminal.json'), 'utf8'))
assert.equal(Object.hasOwn(binding, 'receiptDigest'), false)
const config = {
  lifecycleBaseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'only-synthetic-original-control-key',
  deploymentIdentity: 'private-loopback', environmentVersion: intent.environmentVersion, provider: intent.provider,
  imageDigest: `sha256:${'1'.repeat(64)}`, payloadSha256: '2'.repeat(64), entrypoint: ['/fixture'],
  platform: 'arm64', cpuCores: 1, memoryMiB: 128, ttlSeconds: 120, requestTimeoutMs: 1600, stopBudgetMs: 2000,
  readyPollIntervalMs: 10, maxReadyPolls: 2, pageSize: 1, maxPages: 2, maxItems: 2, maxRecords: 4,
  maxInflightOperations: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxOperationBytes: 8192, maxFieldBytes: 256,
}
const connection = new BoundedLifecycleConnection(config, createOwnedSdkTransport({
  connections: 1, connectTimeoutMs: 1000, headersTimeoutMs: 1500, bodyTimeoutMs: 1500, keepAliveTimeoutMs: 1000,
  maxHeaderBytes: 4096, maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxResponseBytes,
}))
const selection = () => ({ intent, binding, budget: { deadlineAtMs: Date.now() + config.stopBudgetMs, bytes: 0 },
  assertCurrent() {} })
try {
  await assert.rejects(readSdkTerminalReceipt(connection, config, undefined), { code: 'sdk/stop-unknown' })
  await assert.rejects(readSdkTerminalReceipt(connection, config, selection()))
  const receipt = await readSdkTerminalReceipt(connection, config, selection())
  const { receiptDigest, ...original } = receipt
  assert.deepEqual(original, binding)
  assert.match(receiptDigest, /^[0-9a-f]{64}$/)
  writeFileSync(join(directory, 'incoming.json'), JSON.stringify({ intent, receipt }), { flag: 'wx', mode: 0o600 })
} finally {
  await connection.closeTransport()
}
