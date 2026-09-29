/** Standalone process entry for the dedicated Kubernetes Connector Pod. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { EgressGate } from './egress.ts'
import { destinationKey, parseAllowlist } from './protocol.ts'
import { createConnectorRunner } from './server.ts'
import { Ssh2Transport } from './transport.ts'

function target(value: string): { host: string; port: number } {
  const canonical = [...parseAllowlist(value)]
  if (canonical.length !== 1) throw new Error('One forbidden probe target is required')
  const item = canonical[0]!
  const split = item.startsWith('[') ? item.indexOf(']:') + 1 : item.lastIndexOf(':')
  return { host: item.startsWith('[') ? item.slice(1, split - 1) : item.slice(0, split),
    port: Number(item.slice(split + 1)) }
}

async function main(): Promise<void> {
  const path = process.env.CONNECTOR_RUNNER_TOKEN_FILE ?? '/run/power-evolve/runner-token'
  if (!isAbsolute(path)) throw new Error('Control token file must have an absolute path')
  const token = (await readFile(path, 'utf8')).trim()
  const allowlist = parseAllowlist(process.env.CONNECTOR_RUNNER_ALLOWED_DESTINATIONS ?? '')
  const forbidden = process.env.CONNECTOR_RUNNER_FORBIDDEN_PROBE
    ? target(process.env.CONNECTOR_RUNNER_FORBIDDEN_PROBE) : undefined
  if (forbidden && allowlist.has(destinationKey(forbidden.host, forbidden.port))) {
    throw new Error('Forbidden probe target cannot be allowlisted')
  }
  const refusedFlag = process.env.CONNECTOR_RUNNER_REFUSED_PROVES_DENIAL ?? '0'
  if (refusedFlag !== '0' && refusedFlag !== '1') throw new Error('Invalid refusal policy')
  const refusedIsDenied = refusedFlag === '1'
  const runner = createConnectorRunner({ token, allowlist,
    egress: new EgressGate(forbidden, undefined, refusedIsDenied), transport: new Ssh2Transport() })
  const port = Number(process.env.CONNECTOR_RUNNER_PORT ?? '8080')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid Runner port')
  await new Promise<void>((resolve, reject) => {
    runner.server.once('error', reject)
    runner.server.listen(port, '0.0.0.0', resolve)
  })
  const shutdown = (): void => { void runner.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 }) }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

void main().catch(error => {
  // Startup errors are deliberately reduced to their class; no config or credential bytes are logged.
  process.stderr.write(`Connector Runner failed to start: ${error instanceof Error ? error.name : 'Error'}\n`)
  process.exitCode = 1
})
