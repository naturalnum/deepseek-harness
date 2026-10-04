/** Real owned Node child with a synthetic Device lifecycle; no DSH plugin, Python or Docker executes. */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const root = process.env.PE_INSTALLED_GATE_ROOT, launchId = process.env.PE_DEVICE_LAUNCH_ID
const port = Number(process.env.PE_INSTALLED_GATE_PORT), instanceId = randomUUID()
if (root === undefined || launchId === undefined || !Number.isInteger(port)
  || process.argv[2] !== '--profile' || process.argv[3] !== 'power-evolve-device') throw new Error('invalid_installed_cli_fixture')
const note = value => appendFileSync(join(root, 'cli.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 })
note({ event: 'spawn', pid: process.pid, instanceId,
  executableMatches: process.execPath === join(root, 'resources/node/bin/node'),
  pathMatches: process.env.PATH === [join(root, 'external command tools'), '/usr/bin', '/bin'].join(':'),
  homeEnvironmentMatches: process.env.HOME === join(root, 'home'),
  dockerHostMatches: process.env.DOCKER_HOST === 'unix://fixture-only.sock',
  homeMatches: process.env.DSH_HOME === join(root, 'app-data/PowerEvolve/device/home'),
  cwdMatches: process.cwd() === join(root, 'app-data/PowerEvolve/device/work'), profileMatches: true })
const base = { kind: 'power-evolve-device-lifecycle', version: 1, launchId }
const snapshot = { phase: 'ready', admissionOpen: true, pendingActions: 0, journalEntries: 0, drain: null }
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ready: true, service: 'device', instanceId }))
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Installed CLI fixture</title><h1>Local Device fixture</h1>')
  }
})
server.listen(port, '127.0.0.1', () => {
  note({ event: 'ready' })
  process.send({ ...base, type: 'ready', instanceId, pid: process.pid, url: `http://127.0.0.1:${port}/` })
})
process.on('message', value => {
  if (value?.kind !== base.kind || value.launchId !== launchId || value.type !== 'request') return
  note({ event: 'request', action: value.action })
  if (value.action === 'quiesce') {
    snapshot.phase = 'quiescent'; snapshot.admissionOpen = false; snapshot.drain = { entries: [], cleanupPending: 0 }
  }
  process.send({ ...base, type: 'response', instanceId, requestId: value.requestId,
    action: value.action, status: 'ok', snapshot }, error => {
    if (error) process.exit(2)
    if (value.action === 'terminate') server.close(() => { note({ event: 'terminate-exit' }); process.exit(0) })
  })
})
process.on('disconnect', () => { server.close(() => process.exit(1)) })
