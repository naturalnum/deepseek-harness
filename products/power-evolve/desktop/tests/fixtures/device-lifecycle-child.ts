/** OS/IPC fixture only: simulates the Device protocol, not DSH, Worker, Docker or PostgreSQL. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

const scenario = process.env.FIXTURE_SCENARIO ?? 'normal'
const record = process.env.FIXTURE_RECORD!
const launchId = process.env.PE_DEVICE_LAUNCH_ID!
const instanceId = randomUUID()
const port = Number(process.env.FIXTURE_PORT)
const base = { kind: 'power-evolve-device-lifecycle', version: 1, launchId }
const snapshot = { phase: 'ready', admissionOpen: true, pendingActions: 0, journalEntries: 0,
  drain: null as null | { entries: { executionId: string; state: string }[]; cleanupPending: number } }
function note(value: object): void { appendFileSync(record, JSON.stringify(value) + '\n', { mode: 0o600 }) }
writeFileSync(record, JSON.stringify({ pid: process.pid, launchId, args: process.argv.slice(2),
  homeSet: process.env.DSH_HOME !== undefined,
  scrubbed: ['PROVIDER_KEY', 'PE_DEVICE_TOKEN', 'DATABASE_URL', 'PE_DEVICE_NONCE', 'NODE_OPTIONS', 'NODE_PATH']
    .every(key => process.env[key] === undefined) }) + '\n', { mode: 0o600 })
if (process.argv[2] !== '--profile' || process.argv[3] !== 'test-device') process.exit(9)
if (scenario === 'ignore_signals') process.on('SIGTERM', () => { note({ ignoredSignal: true }) })
const server = createServer((_req, response) => {
  if (scenario === 'health_redirect') { response.writeHead(302, { location: '/redirect' }); response.end(); return }
  if (scenario === 'health_hang') return
  response.setHeader('content-type', 'application/json')
  response.end(scenario === 'health_huge' ? JSON.stringify({ filler: 'x'.repeat(20000) })
    : JSON.stringify({ ready: true, service: 'device', instanceId: scenario === 'health_stale' ? randomUUID() : instanceId }))
})
server.listen(port, '127.0.0.1', () => {
  if (scenario.startsWith('cancel_') || scenario === 'ignore_signals') return
  const ready = { ...base, type: 'ready', instanceId,
    pid: scenario === 'wrong_pid' ? process.pid + 1 : process.pid,
    url: `http://127.0.0.1:${scenario === 'wrong_url' ? port + 1 : port}/` }
  if (scenario === 'wrong_launch') ready.launchId = randomUUID()
  const send = (): void => {
    process.send?.(ready)
    if (scenario === 'duplicate') process.send?.(ready)
    if (scenario === 'output_limit') process.stderr.write('private'.repeat(10000))
    if (scenario === 'message_limit') process.send?.({ ...base, type: 'noise', filler: 'x'.repeat(20000) })
  }
  if (scenario === 'startup_delay') setTimeout(send, 1000)
  else send()
})
let inspectCount = 0
process.on('message', (value: unknown) => {
  if (typeof value !== 'object' || value === null || !('action' in value) || !('requestId' in value)
    || !('instanceId' in value) || !('launchId' in value) || value.launchId !== launchId) return
  note({ action: value.action, requestId: value.requestId, instanceId: value.instanceId })
  const response = (state = snapshot): void => {
    process.send?.({ ...base, type: 'response', instanceId: scenario === 'wrong_response_instance' ? randomUUID() : instanceId,
      requestId: scenario === 'cancel_wrong_request' ? randomUUID() : value.requestId,
      action: value.action, status: 'ok', snapshot: state })
    if (scenario === 'duplicate') process.send?.({ ...base, type: 'response', instanceId,
      requestId: value.requestId, action: value.action, status: 'ok', snapshot: state })
  }
  if (value.action === 'inspect') {
    inspectCount++
    if (scenario === 'late_inspect' && inspectCount === 1) {
      setTimeout(() => { response({ ...snapshot, phase: 'error' }); note({ lateSent: true }) }, 300)
    } else response()
  } else if (value.action === 'quiesce') {
    if (scenario === 'no_quiesce' || scenario === 'cancel_no_report') return
    if (scenario === 'exit_no_report') { process.exit(0); return }
    const settle = (): void => {
      if (scenario === 'cancel_wrong_phase') { response(); return }
      snapshot.phase = 'quiescent'; snapshot.admissionOpen = false
      snapshot.drain = { entries: scenario === 'residual' ? [{ executionId: randomUUID(), state: 'unconfirmed' }] : [],
        cleanupPending: scenario === 'cleanup_pending' ? 1 : 0 }
      snapshot.journalEntries = snapshot.drain.entries.length
      response()
    }
    if (scenario === 'slow_quiesce') setTimeout(settle, 5300)
    else settle()
  } else if (value.action === 'terminate') {
    if (scenario === 'terminate_no_ack') { process.exit(0); return }
    response()
    setTimeout(() => { server.close(); process.disconnect(); process.exit(0) }, 20)
  }
})
