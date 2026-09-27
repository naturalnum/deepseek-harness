/** Local device connector: explicit folder grants and status-first Docker command recovery. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

const executeFile = promisify(execFile)
const directory = z.object({ id: z.uuid(), label: z.string(), path: z.string() }).strict()
const deviceState = z.object({
  deviceId: z.uuid(), token: z.string().min(32), instanceId: z.uuid(), directories: z.array(directory),
}).strict()
type DeviceState = z.infer<typeof deviceState>
const journalEntry = z.object({
  id: z.uuid(), container: z.string(), stage: z.enum(['claimed', 'created', 'started', 'finished']),
  startedAt: z.number(), result: z.object({
    state: z.enum(['succeeded', 'failed', 'cancelled', 'uncertain']), exitCode: z.number().int().nullable(),
    stdout: z.string(), stderr: z.string(), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
    timedOut: z.boolean(),
  }).strict().optional(),
}).strict()
type JournalEntry = z.infer<typeof journalEntry>
interface Job { executionId: string; directoryId: string; command: string; cwd: string;
  timeoutMs: number; state: 'queued' | 'running' | 'cancelling'; cancelRequested: boolean }

async function docker(args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
  return executeFile('docker', args, { timeout, maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST } })
}
async function containerState(name: string): Promise<{ Running: boolean; ExitCode: number; Status: string } | null> {
  try {
    const response = await docker(['inspect', '--format', '{{json .State}}', name])
    return z.object({ Running: z.boolean(), ExitCode: z.number().int(), Status: z.string() }).passthrough()
      .parse(JSON.parse(response.stdout))
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    if (/no such (?:object|container)/i.test(stderr)) return null
    throw error
  }
}
function limit(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  return { text: bytes.subarray(0, 65_536).toString('utf8'), truncated: bytes.length > 65_536 }
}
function uncertain(): z.infer<typeof journalEntry>['result'] {
  return { state: 'uncertain', exitCode: null, stdout: '', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, timedOut: false }
}

/** A single local device process holds its credential and folder paths outside the cloud. */
export class DesktopWorker {
  private readonly statePath: string
  private readonly journalPath: string
  private state: DeviceState | null = null
  private readonly journal = new Map<string, JournalEntry>()
  private readonly stop = new AbortController()
  private polling: Promise<void> | null = null
  private active: Promise<void> | null = null
  private activeContainer: string | null = null
  private readonly jobs = new Map<string, Job>()
  private lastContact = Date.now()
  private notice = ''

  constructor(private readonly platformUrl: string, private readonly privateDir: string,
    private readonly image: string, private readonly pollMs: number) {
    this.statePath = join(privateDir, 'device.json')
    this.journalPath = join(privateDir, 'journal.json')
  }

  async init(): Promise<void> {
    await mkdir(this.privateDir, { recursive: true, mode: 0o700 })
    await chmod(this.privateDir, 0o700)
    try { this.state = deviceState.parse(JSON.parse(await readFile(this.statePath, 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try {
      const entries = z.array(journalEntry).parse(JSON.parse(await readFile(this.journalPath, 'utf8')))
      for (const entry of entries) this.journal.set(entry.id, entry)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  private async save(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
    const parent = await open(dirname(path), constants.O_RDONLY)
    try { await parent.sync() } finally { await parent.close() }
  }
  private saveJournal(): Promise<void> { return this.save(this.journalPath, [...this.journal.values()]) }
  status(): unknown { return { paired: !!this.state, deviceId: this.state?.deviceId ?? null,
    directories: this.state?.directories.map(({ id, label, path }) => ({ directoryId: id, label, path })) ?? [],
    online: this.state !== null && Date.now() - this.lastContact < 5000, notice: this.notice } }

  private async call<T>(path: string, input: unknown, token?: string): Promise<T> {
    const response = await fetch(new URL(path, this.platformUrl), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(`platform_${response.status}_${String(value.error ?? 'unavailable')}`)
    return value as T
  }

  async pair(code: string, name: string): Promise<unknown> {
    if (this.state) throw new Error('device_already_paired')
    const instanceId = randomUUID()
    const result = await this.call<{ deviceId: string; token: string }>('/devices/enroll', { code, name, instanceId })
    this.state = deviceState.parse({ ...result, instanceId, directories: [] })
    await this.save(this.statePath, this.state)
    this.lastContact = Date.now()
    return this.status()
  }

  async authorize(path: string): Promise<unknown> {
    if (!this.state) throw new Error('device_not_paired')
    if (!isAbsolute(path)) throw new Error('directory_must_be_absolute')
    const actual = await realpath(path)
    const stat = await lstat(actual)
    if (!stat.isDirectory() || actual === '/' || actual === process.env.HOME || /[:,]/.test(actual)) {
      throw new Error('directory_not_allowed')
    }
    const previous = this.state.directories.find(item => item.path === actual)
    if (previous) return { directoryId: previous.id, label: previous.label, path: previous.path }
    const label = basename(actual)
    const result = await this.call<{ directoryId: string }>('/devices/agent/directory', { label }, this.state.token)
    this.state.directories.push({ id: result.directoryId, label, path: actual })
    await this.save(this.statePath, this.state)
    return { directoryId: result.directoryId, label, path: actual }
  }

  private async localPath(directoryId: string, relative: string): Promise<string> {
    const folder = this.state?.directories.find(item => item.id === directoryId)
    if (!folder) throw new Error('directory_not_authorized')
    if (!relative || relative.length > 512 || relative.includes('\\') || relative.includes('\0')) throw new Error('invalid_local_path')
    const segments = relative.split('/')
    if (segments.length > 16 || segments.some(part => !part || part === '.' || part === '..' || part.length > 100)) {
      throw new Error('invalid_local_path')
    }
    const root = await realpath(folder.path)
    if (root !== folder.path || !(await lstat(root)).isDirectory()) throw new Error('directory_changed')
    let parent = root
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment)
      const stat = await lstat(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_local_path')
    }
    return join(parent, segments.at(-1)!)
  }

  async importFile(directoryId: string, cloudPath: string, localPath: string): Promise<unknown> {
    if (!this.state) throw new Error('device_not_paired')
    const target = await this.localPath(directoryId, localPath)
    try { await lstat(target); throw new Error('local_file_exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const cloud = z.object({ data: z.string().max(2_800_000), revision: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough()
      .parse(await this.call('/devices/agent/files/read', { directoryId, path: cloudPath }, this.state.token))
    const bytes = Buffer.from(cloud.data, 'base64')
    if (bytes.length > 2 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== cloud.revision) {
      throw new Error('cloud_file_digest_mismatch')
    }
    const temporary = join(dirname(target), `.pe-transfer-${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      try { await file.writeFile(bytes); await file.sync() }
      finally { await file.close() }
      if (await this.localPath(directoryId, localPath) !== target) throw new Error('directory_changed')
      await link(temporary, target)
      const parent = await open(dirname(target), constants.O_RDONLY)
      try { await parent.sync() } finally { await parent.close() }
    } finally { await rm(temporary, { force: true }) }
    return { cloudPath, localPath, size: bytes.length, revision: cloud.revision }
  }

  async exportFile(directoryId: string, localPath: string, cloudPath: string, requestId: string): Promise<unknown> {
    if (!this.state) throw new Error('device_not_paired')
    const source = await this.localPath(directoryId, localPath)
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('local_file_unavailable')
      bytes = await file.readFile()
      if (bytes.length > 2 * 1024 * 1024) throw new Error('local_file_too_large')
    } finally { await file.close() }
    return this.call('/devices/agent/files/put',
      { directoryId, requestId, path: cloudPath, data: bytes.toString('base64') }, this.state.token)
  }

  start(): void { this.polling = this.poll() }
  async close(): Promise<void> {
    this.stop.abort()
    if (this.activeContainer) {
      try { await docker(['stop', '--time', '2', this.activeContainer], 10_000) }
      catch (_alreadyStopped) { /* The current command is reconciled by the active run. */ }
    }
    await this.polling
    await this.active
  }

  private async poll(): Promise<void> {
    while (!this.stop.signal.aborted) {
      if (this.state) {
        try {
          if (!this.active) {
            for (const entry of this.journal.values()) {
              if (entry.stage === 'finished' && entry.result) await this.report(this.state, entry)
            }
          }
          const result = await this.call<{ jobs: Job[]; directories: string[] }>('/devices/agent/jobs',
            { instanceId: this.state.instanceId }, this.state.token)
          this.lastContact = Date.now()
          if (!this.active && this.journal.size === 0) this.notice = ''
          const allowed = new Set(result.directories)
          if (this.state.directories.some(item => !allowed.has(item.id))) {
            this.state.directories = this.state.directories.filter(item => allowed.has(item.id))
            await this.save(this.statePath, this.state)
          }
          this.jobs.clear()
          for (const job of result.jobs) this.jobs.set(job.executionId, job)
          if (!this.active) {
            const next = result.jobs[0]
            if (next) {
              const running = this.run(next).catch(error => { this.notice = error instanceof Error ? error.message : 'device_error' })
                .finally(() => { if (this.active === running) this.active = null })
              this.active = running
            }
          }
        } catch (error) { this.notice = error instanceof Error ? error.message : 'platform_unavailable' }
      }
      try { await delay(this.pollMs, undefined, { signal: this.stop.signal }) }
      catch (_aborted) { /* close() owns the active command and awaits its exit. */ }
    }
  }

  private async run(job: Job): Promise<void> {
    const state = this.state
    if (!state) return
    const id = job.executionId, name = `pe-local-${id.replaceAll('-', '')}`
    let entry = this.journal.get(id)
    const fresh = !entry
    if (!entry && job.state !== 'queued') {
      await this.call('/devices/agent/finish', { instanceId: state.instanceId, executionId: id,
        result: uncertain() }, state.token)
      return
    }
    if (!entry) {
      await this.call('/devices/agent/claim', { instanceId: state.instanceId, executionId: id }, state.token)
      entry = { id, container: name, stage: 'claimed', startedAt: Date.now() }
      this.journal.set(id, entry); await this.saveJournal()
    }
    if (entry.stage === 'finished' && entry.result) { await this.report(state, entry); return }
    const folder = state.directories.find(item => item.id === job.directoryId)
    if (!folder) { entry.result = uncertain(); entry.stage = 'finished'; await this.saveJournal(); await this.report(state, entry); return }
    let root: string
    try {
      root = await realpath(folder.path)
      if (root !== folder.path || !(await lstat(root)).isDirectory()) throw new Error('directory_changed')
      const requested = resolve(root, job.cwd)
      if (requested !== root && !requested.startsWith(root + '/')) throw new Error('cwd_outside_directory')
      const actual = await realpath(requested)
      if (actual !== root && !actual.startsWith(root + '/')) throw new Error('cwd_outside_directory')
    } catch (_invalidDirectory) {
      entry.result = uncertain(); entry.stage = 'finished'; await this.saveJournal(); await this.report(state, entry); return
    }
    let container = await containerState(name)
    if (!container && (!fresh || entry.stage !== 'claimed')) {
      entry.result = uncertain(); entry.stage = 'finished'; await this.saveJournal(); await this.report(state, entry); return
    }
    if (!container) {
      try {
        await docker(['create', '--name', name, '--network', 'none', '--read-only',
          '--tmpfs', '/tmp:rw,nosuid,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--pids-limit', '128', '--memory', '768m', '--cpus', '1', '--user', '1000:1000',
          '--mount', `type=bind,source=${root},target=/workspace`,
          '--workdir', `/workspace${job.cwd ? '/' + job.cwd : ''}`, '--entrypoint', '/bin/bash',
          this.image, '-lc', job.command])
        entry.stage = 'created'; await this.saveJournal()
      } catch (error) {
        container = await containerState(name)
        if (container) { entry.stage = 'created'; await this.saveJournal() }
        else {
          const message = error instanceof Error ? error.message.slice(0, 1000) : 'docker_create_failed'
          entry.result = { ...uncertain()!, state: 'failed', stderr: message }
          entry.stage = 'finished'; await this.saveJournal(); await this.report(state, entry); return
        }
      }
    }
    container ??= await containerState(name)
    if (container?.Status === 'created') {
      try { await docker(['start', name]); entry.stage = 'started'; entry.startedAt = Date.now(); await this.saveJournal() }
      catch (_startUnknown) {
        container = await containerState(name)
        if (!container?.Running) { entry.result = uncertain(); entry.stage = 'finished'; await this.saveJournal(); await this.report(state, entry); return }
      }
    }
    this.activeContainer = name
    let timedOut = false, cancelled = false, contactLost = false
    while (true) {
      container = await containerState(name)
      if (!container) { entry.result = uncertain(); break }
      if (!container.Running) break
      const current = this.jobs.get(id)
      timedOut ||= Date.now() - entry.startedAt > job.timeoutMs
      cancelled ||= !!current?.cancelRequested || (!current && Date.now() - this.lastContact < 5000)
        || this.stop.signal.aborted
      contactLost ||= Date.now() - this.lastContact > 5000
      if (timedOut || cancelled || contactLost) {
        try { await docker(['stop', '--time', '2', name], 10_000) }
        catch (_alreadyExited) { /* Inspect below distinguishes an actual exit from a lost container. */ }
      }
      await delay(250)
    }
    this.activeContainer = null
    if (!entry.result) {
      let output: { stdout: string; stderr: string }, capped = false
      try { output = await docker(['logs', name], 10_000) }
      catch (error) {
        const failure = error as { code?: string; stdout?: string; stderr?: string }
        if (failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error
        output = { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
        capped = true
      }
      const stdout = limit(output.stdout), stderr = limit(output.stderr)
      entry.result = { state: contactLost ? 'uncertain' : cancelled ? 'cancelled'
        : timedOut || container!.ExitCode !== 0 ? 'failed' : 'succeeded',
      exitCode: container!.ExitCode, stdout: stdout.text, stderr: stderr.text,
      stdoutTruncated: stdout.truncated || capped, stderrTruncated: stderr.truncated || capped, timedOut }
    }
    entry.stage = 'finished'; await this.saveJournal()
    await this.report(state, entry)
  }

  private async report(state: DeviceState, entry: JournalEntry): Promise<void> {
    if (!entry.result) return
    await this.call('/devices/agent/finish', {
      instanceId: state.instanceId, executionId: entry.id, result: entry.result,
    }, state.token)
    this.journal.delete(entry.id)
    try { await this.saveJournal() }
    catch (error) { this.journal.set(entry.id, entry); throw error }
    try { await docker(['rm', '--force', entry.container], 10_000) }
    catch (_alreadyRemoved) { /* The durable result has already been accepted by the platform. */ }
  }
}
