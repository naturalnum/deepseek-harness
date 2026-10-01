/** Bounded credential-free UID/GID 1000 helper IPC; cancellation always waits for child close. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./file-scan.py', import.meta.url))
export const childEnvironment = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent',
  USER: 'agent', LANG: 'C.UTF-8' })
const reasons = new Set(['budget_exceeded', 'excluded_paths', 'read_failed', 'changed_during_scan', 'scan_unavailable'])
export const unavailableChanges = () => ({ status: 'unavailable', files: [], reasons: ['scan_unavailable'] })
const unavailableSnapshot = () => ({ version: 1, status: 'unavailable', records: [], reasons: ['scan_unavailable'] })

/** Path validation matches the browser download selection without importing TypeScript into the image. */
export function canonicalFilePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\\')
    && value.normalize('NFC') === value && !/^[A-Za-z]:/u.test(value)
    && value.split('/').length <= 16
    && value.split('/').every(part => part.length > 0 && part.length <= 100 && part !== '.' && part !== '..')
    && [...value].every(character => { const point = character.codePointAt(0); return point > 31 && point !== 127 && (point < 0xd800 || point > 0xdfff) })
}

/** Deployment inputs are explicit integer environment fields with fixed protocol ceilings. */
export function scanLimits(environment = process.env) {
  const fields = { maxEntries: ['PE_RUNNER_SCAN_MAX_ENTRIES', 4096, 65536],
    maxHashBytes: ['PE_RUNNER_SCAN_MAX_HASH_BYTES', 32 * 1024 * 1024, 200 * 1024 * 1024],
    timeoutMs: ['PE_RUNNER_SCAN_TIMEOUT_MS', 5000, 30000],
    maxSnapshotBytes: ['PE_RUNNER_SCAN_MAX_SNAPSHOT_BYTES', 1024 * 1024, 4 * 1024 * 1024],
    maxFiles: ['PE_RUNNER_SCAN_MAX_FILES', 100, 100] }
  return Object.fromEntries(Object.entries(fields).map(([field, [name, fallback, maximum]]) => {
    const raw = environment[name]
    const value = raw === undefined ? fallback : Number(raw)
    if (!Number.isSafeInteger(value) || value < (field === 'maxSnapshotBytes' ? 1024 : 1)
      || value > maximum || raw !== undefined && !/^[1-9][0-9]*$/u.test(raw)) throw new Error(`Invalid ${name}`)
    return [field, value]
  }))
}

function validReasons(value, status) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(reason => reasons.has(reason))
    && (status === 'complete' ? value.length === 0 : value.length > 0)
}
export function validFileChanges(value) {
  return value !== null && typeof value === 'object' && ['complete', 'partial', 'unavailable'].includes(value.status)
    && Object.keys(value).sort().join(',') === 'files,reasons,status' && validReasons(value.reasons, value.status)
    && Array.isArray(value.files) && value.files.length <= 100 && (value.status !== 'unavailable' || value.files.length === 0)
    && new Set(value.files.map(file => file?.path)).size === value.files.length
    && value.files.every(file => file && Object.keys(file).sort().join(',') === 'path,sha256,sizeBytes'
      && canonicalFilePath(file.path) && Number.isInteger(file.sizeBytes) && file.sizeBytes >= 0 && file.sizeBytes <= 2097152
      && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(file.sha256))
}
function validSnapshot(value, limits) {
  return value && value.version === 1 && ['complete', 'partial', 'unavailable'].includes(value.status)
    && validReasons(value.reasons, value.status) && Array.isArray(value.records) && value.records.length <= limits.maxEntries + 1
    && (value.status !== 'unavailable' || value.records.length === 0)
    && new Set(value.records.map(record => record?.path)).size === value.records.length
    && value.records.every(record => record && (record.path === '' || canonicalFilePath(record.path))
      && (record.kind === 'directory' ? typeof record.complete === 'boolean'
        : record.kind === 'file' ? Number.isSafeInteger(record.sizeBytes) && record.sizeBytes >= 0
          && (record.sha256 === null || typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(record.sha256))
          : ['unknown', 'other'].includes(record.kind)))
}

/** All root/user filesystem access occurs inside the dropped-privilege process. */
export class FileScanner {
  constructor(root, limits = scanLimits(), spawnChild = spawn) {
    this.root = root
    this.limits = limits
    this.spawnChild = spawnChild
  }

  async run(request, signal, maximum = this.limits.maxSnapshotBytes, timeoutMs = this.limits.timeoutMs + 500) {
    if (signal?.aborted) return null
    let child
    try {
      child = this.spawnChild('/usr/bin/python3', ['-I', '-B', helper], {
        uid: 1000, gid: 1000, cwd: '/', env: { ...childEnvironment }, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (_spawnUnavailable) { return null }
    let length = 0, failed = false, killTimer
    const chunks = []
    const stop = () => {
      failed = true
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 300)
      killTimer.unref()
    }
    const timer = setTimeout(stop, timeoutMs); timer.unref()
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', chunk => {
      length += chunk.length
      if (length > maximum) stop()
      else chunks.push(chunk)
    })
    child.stderr.on('data', () => { /* User paths and private command text never reach Runner diagnostics. */ })
    child.stdin.on('error', () => { /* close/error owns the result. */ })
    child.once('error', () => { failed = true })
    const closed = new Promise(resolve => child.once('close', resolve))
    if (signal?.aborted) stop()
    child.stdin.end(JSON.stringify({ ...request, root: this.root }))
    const code = await closed
    clearTimeout(timer); clearTimeout(killTimer)
    signal?.removeEventListener('abort', stop)
    if (failed || code !== 0) return null
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch (_invalidHelperJson) { return null }
  }

  async snapshot(signal) {
    const value = await this.run({ mode: 'snapshot', limits: this.limits }, signal)
    return validSnapshot(value, this.limits) ? value : unavailableSnapshot()
  }
  async changes(before, signal) {
    if (before.status === 'unavailable') return unavailableChanges()
    const value = await this.run({ mode: 'changes', before, limits: this.limits }, signal)
    return validFileChanges(value) ? value : unavailableChanges()
  }
  async cwd(cwd, signal) {
    const value = await this.run({ mode: 'cwd', cwd }, signal, 1024, 4000)
    return value?.valid === true ? { valid: true } : { valid: false, status: value?.status === 403 ? 403 : 400 }
  }
  async cleanup() {
    // Only the Linux helper can certify its private PID1 Runner namespace; local users are never enumerated here.
    const value = await this.run({ mode: 'cleanup', runnerPid: process.pid }, undefined, 1024, 3000)
    return value?.quiet === true
  }
  command(value) {
    const child = this.spawnChild('/usr/bin/python3', ['-I', '-B', helper], {
      uid: 1000, gid: 1000, cwd: '/', detached: true, env: { ...childEnvironment }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => { /* close/error owns command startup failure. */ })
    child.stdin.end(JSON.stringify({ mode: 'command', root: this.root, cwd: value.cwd, command: value.command }))
    return child
  }
}
