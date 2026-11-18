/** Route an admitted synthetic endpoint to its test-only HTTP server after the Cloud guard. */
import assert from 'node:assert/strict'
import { Agent, type Dispatcher } from 'undici'
import { startHttpMcpFixture } from '../../../../mcp/mcp-client/tests/http-fixture.ts'

const endpointHost = 'mcp.fixture.test'
const endpoints = new Map<string, URL>()
let original: Agent['dispatch'] | undefined
let dispatchCount = 0

/** @returns the exact synthetic endpoints owned by the current test. */
export function fixtureEndpoints(): readonly string[] { return [...endpoints.keys()] }

/** @returns attempts to dispatch to a synthetic MCP host in this process. */
export function fixtureDispatchCount(): number { return dispatchCount }

function dispatchThroughFixture(this: Agent, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
  assert.ok(original)
  const origin = new URL(String(options.origin))
  if (origin.hostname !== endpointHost) return original.call(this, options, handler)
  dispatchCount++
  const local = endpoints.get(new URL(options.path, origin).href)
  assert.ok(local, 'Unexpected synthetic MCP dispatch')
  return original.call(this, { ...options, origin: local.origin, path: local.pathname + local.search }, handler)
}

/** @param options - native fixture options.
 * @returns native fixture with a synthetic approved endpoint and a scoped HTTP carrier.
 */
export async function startApprovedMcpFixture(...options: Parameters<typeof startHttpMcpFixture>): ReturnType<typeof startHttpMcpFixture> {
  const fixture = await startHttpMcpFixture(...options)
  const local = new URL(fixture.url)
  assert.equal(local.hostname, '127.0.0.1')
  const approved = new URL(local)
  approved.hostname = endpointHost
  if (original === undefined) {
    original = Agent.prototype.dispatch
    Agent.prototype.dispatch = dispatchThroughFixture
  }
  endpoints.set(approved.href, local)
  return { ...fixture, url: approved.href, async close() {
    try { await fixture.close() } finally {
      endpoints.delete(approved.href)
      if (endpoints.size === 0 && original !== undefined) { Agent.prototype.dispatch = original; original = undefined }
    }
  } }
}
