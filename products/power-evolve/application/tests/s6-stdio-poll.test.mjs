/** Terminal resource cleanup receives a turn while calls keep arriving. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { StdioMcpService } from '../lib/platform/stdio-mcp.js'

test('continuous claim traffic does not starve terminal resource cleanup', async () => {
  const service = new StdioMcpService({ pool: null }, {}, randomUUID(), 30_000, 100)
  let worked = 0, cleaned = 0
  service.claim = async () => ({ id: randomUUID() })
  service.work = async () => { if (++worked === 4) service.stop.abort() }
  service.cleanupPending = async () => { cleaned++ }
  await service.poll()
  assert.equal(worked, 4)
  assert.equal(cleaned, 3)
})
