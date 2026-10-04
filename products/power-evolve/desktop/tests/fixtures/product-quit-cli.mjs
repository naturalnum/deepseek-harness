/** Owned OS child/IPC replacement; this file is not a DSH Profile or Worker acceptance fixture. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const root = process.env.PE_QUIT_GATE_ROOT
const scenario = process.env.PE_QUIT_GATE_SCENARIO
const launchId = process.env.PE_DEVICE_LAUNCH_ID
const port = Number(process.env.PE_QUIT_GATE_DEVICE_PORT)
if (root === undefined || launchId === undefined || !['starting', 'stopped-residual', 'empty'].includes(scenario)
  || process.argv[2] !== '--profile' || process.argv[3] !== 'test-device') throw new Error('invalid_quit_cli_fixture')
const record = join(root, 'cli.jsonl'), instanceId = randomUUID(), executionId = randomUUID()
const base = { kind: 'power-evolve-device-lifecycle', version: 1, launchId }
const residual = { executionId, state: 'stopConfirmed', observation: {
  receipt: { containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), owner: {
    deviceId: randomUUID(), enrollmentId: randomUUID(), executionId, creationId: randomUUID(), requestDigest: 'c'.repeat(64) } },
  Running: false, ExitCode: 0, Status: 'exited', StartedAt: '2026-10-04T00:00:00Z', FinishedAt: '2026-10-04T00:00:01Z' } }
const snapshot = { phase: scenario === 'starting' ? 'starting' : 'ready', admissionOpen: true, pendingActions: 0,
  journalEntries: scenario === 'stopped-residual' ? 1 : 0, drain: null }
const note = value => appendFileSync(record, JSON.stringify(value) + '\n', { mode: 0o600 })
writeFileSync(record, JSON.stringify({ event: 'spawn', pid: process.pid, instanceId, launchId }) + '\n', { mode: 0o600 })
let ready = false, readyTimer
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ready, service: 'device', instanceId }))
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Local quit fixture</title><h1>Local Device</h1>')
  }
})
const publish = () => {
  if (ready) return
  ready = true; snapshot.phase = 'ready'
  note({ event: 'ready' })
  process.send({ ...base, type: 'ready', instanceId, pid: process.pid, url: `http://127.0.0.1:${port}/` })
}
server.listen(port, '127.0.0.1', () => {
  if (scenario === 'starting') readyTimer = setInterval(() => {
    if (existsSync(join(root, 'release-ready'))) { clearInterval(readyTimer); publish() }
  }, 10)
  else publish()
})
process.on('message', value => {
  if (value?.kind !== base.kind || value.launchId !== launchId || value.type !== 'request') return
  note({ event: 'request', action: value.action })
  if (value.action === 'quiesce') {
    clearInterval(readyTimer)
    snapshot.phase = 'quiescent'; snapshot.admissionOpen = false
    snapshot.drain = { entries: scenario === 'stopped-residual' ? [residual] : [], cleanupPending: 0 }
  }
  const packet = { ...base, type: 'response', instanceId, requestId: value.requestId,
    action: value.action, status: 'ok', snapshot }
  process.send(packet, error => {
    if (error) process.exit(2)
    if (value.action === 'terminate') server.close(() => { note({ event: 'terminate-exit' }); process.exit(0) })
  })
})
process.on('disconnect', () => { clearInterval(readyTimer); server.close(() => process.exit(1)) })
