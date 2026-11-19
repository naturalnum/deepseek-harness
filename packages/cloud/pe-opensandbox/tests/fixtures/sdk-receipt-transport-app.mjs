/** One actual Node application process with an isolated durable fixture outbox. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AllocationReceiptOutbox } from '../../src/allocation-receipt-outbox.ts'
import { createSdkReceiptTransport } from '../../src/sdk-receipt-transport.ts'
import { BoundedLifecycleConnection, createOwnedSdkTransport } from '../../src/sdk-transport.ts'

const [phase, directory, port] = process.argv.slice(2)
assert.ok(phase === 'lost' || phase === 'restart')
assert.match(port, /^[1-9][0-9]{1,4}$/)
const { intent, receipt } = JSON.parse(readFileSync(join(directory, 'incoming.json'), 'utf8'))
const key = (scope) => JSON.stringify([scope.allocationId, scope.accountId, scope.epoch, scope.sessionId, scope.workspaceId])
const db = new DatabaseSync(join(directory, 'app-receipt.sqlite'))
db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS receipt (scope TEXT PRIMARY KEY, document TEXT NOT NULL, ack TEXT NOT NULL)`)
const storage = {
  async release(value) {
    db.prepare("INSERT OR IGNORE INTO receipt VALUES (?, ?, 'pending')").run(key(value), JSON.stringify(value))
    return 'recorded'
  },
  async read(scope) {
    const row = db.prepare('SELECT document, ack FROM receipt WHERE scope = ?').get(key(scope))
    return row === undefined ? undefined : { state: 'released', ack: row.ack, receipt: JSON.parse(row.document) }
  },
  async pending(limit) {
    return db.prepare("SELECT document FROM receipt WHERE ack = 'pending' LIMIT ?").all(limit + 1)
      .map(row => JSON.parse(row.document))
  },
  async markAcknowledged(value) {
    const result = db.prepare("UPDATE receipt SET ack = 'acknowledged' WHERE scope = ? AND document = ?").run(
      key(value), JSON.stringify(value),
    )
    assert.equal(result.changes, 1)
  },
}
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
let closing = false
const transport = createSdkReceiptTransport(connection, config, {
  async withOriginalReceipt(scope, run) {
    const retained = await storage.read(scope)
    assert.equal(retained?.ack, 'pending')
    return run({ intent, receipt: retained.receipt, budget: { deadlineAtMs: Date.now() + config.stopBudgetMs, bytes: 0 },
      assertCurrent() { assert.equal(closing, false) } })
  },
})
const app = new AllocationReceiptOutbox(storage, transport, 128)
try {
  if (phase === 'lost') {
    assert.equal((await app.persistRelease(receipt, receipt)).ack, 'pending')
    await assert.rejects(app.acknowledge(receipt), { code: 'ack-unconfirmed' })
    assert.equal((await storage.read(receipt)).ack, 'pending')
  } else {
    const pending = await app.pending()
    assert.equal(pending.length, 1)
    assert.deepEqual((await storage.read(pending[0])).receipt, receipt)
    assert.equal(await app.acknowledge(pending[0]), 'acknowledged')
    assert.equal(await app.acknowledge(pending[0]), 'acknowledged')
    assert.deepEqual(await app.pending(), [])
  }
  console.log(JSON.stringify({ phase, pid: process.pid, ack: (await storage.read(receipt)).ack }))
} finally {
  closing = true
  await connection.closeTransport()
  db.close()
}
