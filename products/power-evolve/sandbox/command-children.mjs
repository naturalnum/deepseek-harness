/** Credential-free UID/GID 1000 command helpers; cancellation waits for process close. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./command-child.py', import.meta.url))
const environment = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/agent',
  USER: 'agent', LANG: 'C.UTF-8' })

/** Execute command-directory checks and writer cleanup without Runner credentials. */
export class CommandChildren {
  /**
   * @param root Physical Workspace root visible inside the private container.
   * @param spawnChild Process provider; production uses Node spawn with fixed UID/GID.
   */
  constructor(root, spawnChild = spawn) {
    this.root = root
    this.spawnChild = spawnChild
  }

  /**
   * Run one bounded helper and retain its lifetime until actual close, including cancellation.
   * @param request Helper operation; no credentials enter its JSON.
   * @param signal Cancellation of a directory admission.
   * @param timeoutMs Independent helper deadline in milliseconds.
   * @returns {Promise<object | null>} Parsed helper response, or null on bounded failure.
   */
  async run(request, signal, timeoutMs) {
    if (signal?.aborted) return null
    let child
    try {
      child = this.spawnChild('/usr/bin/python3', ['-I', '-B', helper], {
        uid: 1000, gid: 1000, cwd: '/', env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdout.on('data', (chunk) => {
      length += chunk.length
      if (length > 1024) stop()
      else chunks.push(chunk)
    })
    child.stderr.on('data', () => { /* Private helper input remains outside Runner diagnostics. */ })
    child.stdin.on('error', () => { /* Process close determines whether the request completed. */ })
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

  /**
   * Resolve an internal directory using dropped privileges and descriptor traversal.
   * @param cwd Workspace-relative directory; internal links may resolve within the root.
   * @param signal Cancellation while checking the directory.
   * @returns {Promise<{valid: boolean, status?: number}>} Admission, or an invalid/outside-directory status.
   */
  async cwd(cwd, signal) {
    const value = await this.run({ mode: 'cwd', cwd }, signal, 4000)
    return value?.valid === true ? { valid: true } : { valid: false, status: value?.status === 403 ? 403 : 400 }
  }

  /**
   * Verify the fixed root PID1 Runner and stop its private namespace's UID1000 writers.
   * @returns {Promise<boolean>} True only after two complete quiet process observations.
   */
  async cleanup() {
    const value = await this.run({ mode: 'cleanup', runnerPid: process.pid }, undefined, 3000)
    return value?.quiet === true
  }

  /**
   * Start a detached unprivileged command with the fixed credential-free environment.
   * @param value Validated Workspace-relative command request.
   * @returns {import('node:child_process').ChildProcessWithoutNullStreams} Child whose exit and close remain caller-owned.
   */
  command(value) {
    const child = this.spawnChild('/usr/bin/python3', ['-I', '-B', helper], {
      uid: 1000, gid: 1000, cwd: '/', detached: true, env: { ...environment, ...value.dshEnv }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => { /* Process close determines command startup failure. */ })
    child.stdin.end(JSON.stringify({ mode: 'command', root: this.root, cwd: value.cwd, command: value.command }))
    return child
  }
}
