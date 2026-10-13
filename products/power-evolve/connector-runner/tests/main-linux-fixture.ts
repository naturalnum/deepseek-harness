/** Shared cancellation/drain and per-container owned native mounts for Linux controls. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { nativeDockerCoverageArguments } from '../../scripts/cloud-coverage.mjs'

export type MainLinuxControl = 'default-token' | 'default-port' | 'non-error-token-read' | 'http-close-error'
export interface MainLinuxResult {
  control: MainLinuxControl
  pid: number
  birth: string
  readonlySignal0: 'ESRCH'
  listenerClosed: true
  exitCode: number
  mainSHA256: string
  inputSHA256: string
  defaultTokenFile: boolean
  defaultPort: boolean
  healthStatus?: number
  stderr: string
  unitFault?: Record<string, unknown>
}
export interface MainLinuxFixture {
  run: (control: MainLinuxControl, options?: { stageCancelControl: true }) => Promise<MainLinuxResult>
  waitForSource: () => Promise<{ pid: number; birth: string }>
  signal: AbortSignal
}
interface CliResult { code: number | null; signal: string | null; stdout: string; stderr: string; error: Error | null }
interface Step {
  operation: string
  code: number | null
  signal: string | null
  durationMs: number
  cliError: string | null
  actualCliClose: boolean
}
interface OwnedContainer {
  name: string
  role: 'holder' | 'native'
  id?: string
  createCompleted: boolean
  mounts?: Record<string, unknown>[]
}
let fenced: string | undefined

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function json(text: string): Record<string, unknown> { const value: unknown = JSON.parse(text); return record(value) }
function sha(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function canonical(value: unknown): string {
  assert.ok(typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes(','))
  return value
}
function result(text: string, control: MainLinuxControl): MainLinuxResult {
  const row = json(text)
  assert.equal(row.control, control)
  assert.ok(typeof row.pid === 'number' && Number.isSafeInteger(row.pid) && row.pid > 1)
  assert.ok(typeof row.birth === 'string' && /^linux:[1-9][0-9]*$/.test(row.birth))
  assert.equal(row.readonlySignal0, 'ESRCH')
  assert.equal(row.listenerClosed, true)
  assert.ok(typeof row.exitCode === 'number' && (row.exitCode === 0 || row.exitCode === 1))
  assert.ok(typeof row.mainSHA256 === 'string' && /^[a-f0-9]{64}$/.test(row.mainSHA256))
  assert.ok(typeof row.inputSHA256 === 'string' && /^[a-f0-9]{64}$/.test(row.inputSHA256))
  assert.ok(typeof row.defaultTokenFile === 'boolean' && typeof row.defaultPort === 'boolean')
  assert.ok(typeof row.stderr === 'string')
  if (row.healthStatus !== undefined) assert.equal(row.healthStatus, 503)
  return { control, pid: row.pid, birth: row.birth, readonlySignal0: 'ESRCH', listenerClosed: true,
    exitCode: row.exitCode, mainSHA256: row.mainSHA256, inputSHA256: row.inputSHA256,
    defaultTokenFile: row.defaultTokenFile, defaultPort: row.defaultPort, stderr: row.stderr,
    ...(row.healthStatus === undefined ? {} : { healthStatus: 503 }),
    ...(row.unitFault === undefined ? {} : { unitFault: record(row.unitFault) }) }
}

/** Acquire a context-free holder, then execute in a separate context-mounted owned guest.
 * @param t Actual parent context; cancellation joins acquisition, callback and run before teardown.
 * @param callback Caller of one native run; its signal supports cancellation-aware caller work.
 * @returns Completion after the shared finite drain and all actual container removals.
 */
export async function withOwnedMainLinux(t: TestContext, callback: (linux: MainLinuxFixture) => Promise<void>): Promise<void> {
  if (fenced) throw new Error('Linux fixture fenced after unconfirmed cleanup: ' + fenced)
  const inputPath = canonical(process.env.PE_CLOUD_COVERAGE_INPUT)
  const input = json(readFileSync(inputPath, 'utf8'))
  const sourceRoot = canonical(input.physicalRoot), directory = canonical(input.directory), hashes = record(input.hashes)
  const prefix = 'products/power-evolve/connector-runner/tests/'
  const helpers = ['main-linux-entry.test.mjs', 'main-linux-fixture.ts', 'main-linux-case.ts',
    'main-linux-unit-fault.ts', 'main-linux-fs-boundary.mjs']
  const helperHashes = Object.fromEntries(helpers.map(name => [name, sha(resolve(sourceRoot, prefix, name))]))
  const mainRelative = 'products/power-evolve/connector-runner/src/main.ts'
  assert.equal(hashes[mainRelative], sha(resolve(sourceRoot, mainRelative)))
  assert.equal(hashes[prefix + 'main-linux-entry.test.mjs'], helperHashes['main-linux-entry.test.mjs'])
  const parentHash = sha(inputPath), image = process.env.PE_CONNECTOR_TEST_LINUX_IMAGE
  assert.ok(image && /^sha256:[a-f0-9]{64}$/.test(image), 'An existing immutable Linux dependency carrier is required')
  assert.ok(process.platform === 'darwin' || process.platform === 'linux', 'POSIX Docker source paths are required')
  const uid = process.getuid?.(), gid = process.getgid?.()
  assert.ok(uid !== undefined && gid !== undefined && uid > 0)
  const owner = 'connector-main-' + randomUUID(), docker = process.env.PE_CONNECTOR_TEST_DOCKER ?? 'docker'
  const nodeModules = resolve(sourceRoot, 'products/power-evolve/connector-runner/node_modules')
  assert.equal(realpathSync(nodeModules), nodeModules, 'Guest dependency overlay requires a real directory')
  const cancellation = new AbortController(), operations = new Set<Promise<unknown>>()
  const steps: Step[] = [], cleanupErrors: unknown[] = [], containers: OwnedContainer[] = []
  const receipt: Record<string, unknown> = { owner, image, hostPlatform: process.platform, parentInputSHA256: parentHash,
    helperHashes, sourceRoot, steps, hostRunWritten: false, host8080Bound: false, startedAt: new Date().toISOString(),
    budget: { workMs: 80_000, sharedJoinMs: 20_000, cleanupPerContainerMs: 30_000, parentTestMs: 180_000 },
    holderHasNativeMount: false, guestMountsOnlyOwnedNativeContext: true }
  let phase: 'active' | 'closing' | 'closed' = 'active', contextPath: string | undefined, runFinished = false
  let finalized = false, cleanupPromise: Promise<void> | undefined, callbackStarted = false
  const guard = (): void => {
    if (cancellation.signal.aborted) { const reason: unknown = cancellation.signal.reason; throw reason }
    if (t.signal.aborted) { const reason: unknown = t.signal.reason; throw reason }
    if (phase !== 'active') throw new Error('Owned Linux fixture closing or closed')
  }
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    guard()
    const operation = Promise.resolve().then(async () => { guard(); return await work() })
    operations.add(operation)
    void operation.then(() => { operations.delete(operation) }, () => { operations.delete(operation) })
    return operation
  }
  const cli = (operation: string, args: string[], timeout: number, signal?: AbortSignal): Promise<CliResult> => {
    const started = Date.now()
    return new Promise((done) => {
      let callbackResult: CliResult | undefined, closed = false, settled = false
      const finish = (ended: CliResult, actualClose: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(drainDeadline)
        steps.push({ operation, code: ended.code, signal: ended.signal, durationMs: Date.now() - started,
          cliError: ended.error?.name ?? null, actualCliClose: actualClose })
        if (!actualClose) {
          const error = new Error('Owned Docker CLI close was not confirmed')
          cleanupErrors.push(error)
          fenced = owner
          closeGate(error)
        }
        done(ended)
      }
      const child = execFile(docker, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
        const code = error ? typeof error.code === 'number' ? error.code : null : 0
        callbackResult = { code, signal: error?.signal ?? null, stdout, stderr, error }
        if (closed) finish(callbackResult, true)
      })
      child.once('close', (code, signal) => {
        closed = true
        if (callbackResult) finish({ ...callbackResult, signal: callbackResult.signal ?? signal,
          code: callbackResult.error ? callbackResult.code : code }, true)
      })
      const drainDeadline = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ code: null, signal: null, stdout: callbackResult?.stdout ?? '', stderr: callbackResult?.stderr ?? '',
          error: new Error('Owned Docker CLI drain deadline exceeded') }, false)
      }, timeout + 2_000)
    })
  }
  const inspect = async (owned: OwnedContainer): Promise<Record<string, unknown> | undefined> => {
    const seen = await cli('inspect-' + owned.role, ['inspect', owned.id ?? owned.name], 3_000)
    if (seen.code === 1 && /no such (?:object|container)/i.test(seen.stderr)) return undefined
    assert.equal(seen.code, 0, 'Owned container inspection must complete')
    const list: unknown = JSON.parse(seen.stdout)
    assert.ok(Array.isArray(list) && list.length === 1)
    const row = record(list[0])
    assert.equal(record(record(row.Config).Labels)['powerevolve.owner'], owner)
    assert.ok(typeof row.Id === 'string' && /^[a-f0-9]{64}$/.test(row.Id))
    owned.id = row.Id
    return row
  }
  const closeGate = (reason: unknown): void => {
    if (phase === 'active') phase = 'closing'
    if (!cancellation.signal.aborted) cancellation.abort(reason)
  }
  const onCancel = (): void => { closeGate(t.signal.reason) }
  t.signal.addEventListener('abort', onCancel, { once: true })
  if (t.signal.aborted) onCancel()
  const workTimer = setTimeout(() => { closeGate(new Error('Owned Linux work deadline exceeded')) }, 80_000)
  const cleanup = (): Promise<void> => {
    closeGate(new Error('Owned Linux fixture closing or closed'))
    cleanupPromise ??= (async () => {
      clearTimeout(workTimer)
      const joined = [...operations]
      const joinCancellation = new AbortController()
      let drained = false
      try {
        drained = await Promise.race([Promise.allSettled(joined).then(() => true),
          delay(20_000, false, { signal: joinCancellation.signal })])
      } finally { joinCancellation.abort() }
      receipt.joinedOperations = joined.length
      receipt.sharedDrainConfirmed = drained
      if (!drained) cleanupErrors.push(new Error('Acquisition/callback/run shared drain exceeded its deadline'))
      const closures: Record<string, unknown>[] = []
      for (const owned of [...containers].reverse()) {
        const closure: Record<string, unknown> = { name: owned.name, role: owned.role, id: owned.id ?? null,
          actualMounts: owned.mounts ?? null }
        try {
          const row = await inspect(owned)
          if (row) {
            assert.ok(owned.id)
            if (record(row.State).Running === true) {
              const stopped = await cli('stop-' + owned.role, ['stop', '--time', '3', owned.id], 7_000)
              if (stopped.code !== 0) cleanupErrors.push(new Error('Owned container stop did not complete'))
            }
            try {
              const stopped = await inspect(owned)
              if (stopped && record(stopped.State).Running === false) {
                closure.namespaceStopped = true
                closure.namespaceExitCode = record(stopped.State).ExitCode
                closure.state = record(stopped.State).Status
              }
            } catch (error: unknown) { cleanupErrors.push(error) }
            const removed = await cli('remove-' + owned.role, ['rm', '-f', owned.id], 4_000)
            if (removed.code !== 0) cleanupErrors.push(new Error('Owned container removal did not complete'))
            try {
              const remaining = await inspect(owned)
              closure.removed = remaining === undefined
              if (remaining) cleanupErrors.push(new Error('Owned container remains after removal'))
            } catch (error: unknown) { cleanupErrors.push(error) }
          } else {
            closure.removed = true
            if (!owned.createCompleted) cleanupErrors.push(new Error('Acquisition outcome cannot be confirmed after failed create'))
            else cleanupErrors.push(new Error('Owned container disappeared before stopped state verification'))
          }
        } catch (error: unknown) { cleanupErrors.push(error) }
        closures.push(closure)
      }
      receipt.containers = closures
      receipt.namespaceStopped = closures.length > 0 && closures.every(row => row.namespaceStopped === true)
      receipt.removed = closures.length > 0 && closures.every(row => row.removed === true)
      try {
        for (const [name, hash] of Object.entries(helperHashes)) assert.equal(sha(resolve(sourceRoot, prefix, name)), hash)
        assert.equal(sha(inputPath), parentHash)
      } catch (error: unknown) { cleanupErrors.push(error) }
      phase = 'closed'
      t.signal.removeEventListener('abort', onCancel)
      if (cleanupErrors.length) fenced = owner
      receipt.fenced = fenced !== undefined
      receipt.callbackStarted = callbackStarted
      receipt.contextPath = contextPath ?? null
      receipt.endedAt = new Date().toISOString()
      receipt.cleanupErrors = cleanupErrors.map(error => error instanceof Error ? error.message : 'Non-Error cleanup failure')
      try { writeFileSync(resolve(directory, 'linux-owner-' + owner + '.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 }) }
      catch (error: unknown) { cleanupErrors.push(error); fenced = owner }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned Linux cleanup failed')
    })()
    return cleanupPromise
  }
  t.after(async () => { if (!finalized) await cleanup() }, { timeout: 85_000 })
  const common = (owned: OwnedContainer): string[] => ['--name', owned.name, '--hostname', owner,
    '--label', 'powerevolve.owner=' + owner, '--network', 'none', '--read-only', '--user', `${uid}:${gid}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=128m,mode=700,uid=${uid},gid=${gid}`,
    '--tmpfs', `/run:rw,nosuid,nodev,size=16m,mode=700,uid=${uid},gid=${gid}`]
  const createAndStart = async (owned: OwnedContainer, args: string[]): Promise<void> => {
    guard()
    // Acquire commands finish under their own deadline before shared cleanup joins and inspects ownership.
    const created = await cli('create-' + owned.role, ['create', ...common(owned), ...args], 7_000)
    owned.createCompleted = created.code === 0
    if (created.code === 0) { owned.id = created.stdout.trim(); assert.ok(/^[a-f0-9]{64}$/.test(owned.id)) }
    guard()
    assert.equal(created.code, 0, 'Owned Linux container creation must complete')
    assert.ok(owned.id)
    const started = await cli('start-' + owned.role, ['start', owned.id], 7_000)
    guard()
    assert.equal(started.code, 0, 'Owned Linux start must complete')
    const actual = await inspect(owned)
    guard()
    assert.ok(actual)
    assert.equal(actual.Image, image)
    if (owned.role === 'holder') assert.equal(record(actual.State).Running, true)
    else assert.ok(record(actual.State).Running === true || record(actual.State).Status === 'exited')
    const host = record(actual.HostConfig)
    assert.equal(host.NetworkMode, 'none')
    assert.deepEqual(host.PortBindings, {})
    assert.equal(host.ReadonlyRootfs, true)
    assert.ok(Array.isArray(actual.Mounts))
    owned.mounts = actual.Mounts.map((value: unknown) => {
      const mount = record(value)
      return { type: mount.Type, destination: mount.Destination, rw: mount.RW }
    })
    assert.deepEqual(owned.mounts.filter(mount => mount.type === 'bind' && mount.rw === true)
      .map(mount => mount.destination), owned.role === 'holder' ? [] : [contextPath])
  }
  const run = async (
    control: MainLinuxControl,
    options?: { stageCancelControl: true },
  ): Promise<MainLinuxResult> => await track(async () => {
    assert.equal(contextPath, undefined, 'Each fixture runs exactly one native context')
    guard()
    const nativeArgs = nativeDockerCoverageArguments(inputPath)
    const environment: string[] = []
    for (let index = 0; index < nativeArgs.length; index += 2) {
      const value = nativeArgs[index + 1]
      assert.ok(typeof value === 'string')
      if (nativeArgs[index] === '--env') environment.push(value)
      else assert.equal(nativeArgs[index], '--mount')
    }
    const childInput = environment.find(value => value.startsWith('PE_CLOUD_COVERAGE_INPUT='))
    const nativeOptions = environment.find(value => value.startsWith('NODE_OPTIONS='))
    assert.ok(childInput && nativeOptions && environment.length === 3)
    const childInputPath = canonical(childInput.slice('PE_CLOUD_COVERAGE_INPUT='.length))
    contextPath = dirname(childInputPath)
    assert.equal(dirname(contextPath), resolve(directory, 'contexts'))
    assert.equal(json(readFileSync(childInputPath, 'utf8')).parentInputHash, parentHash)
    const nativeMounts = nativeArgs.filter((_, index) => nativeArgs[index - 1] === '--mount')
    const writable = nativeMounts.filter(value => !value.endsWith(',readonly'))
    assert.deepEqual(writable, ['type=bind,source=' + realpathSync(contextPath) + ',target=' + contextPath])
    receipt.nativeMounts = nativeMounts
    writeFileSync(resolve(contextPath, 'guest-tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', allowImportingTsExtensions: true,
    } }), { mode: 0o600 })
    const tsx = '/opt/power-evolve/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs'
    const guestEnvironment = environment.filter(value => !value.startsWith('NODE_OPTIONS='))
    guestEnvironment.push(nativeOptions + ' --import=' + pathToFileURL(tsx).href)
    const guest: OwnedContainer = { name: owner + '-native', role: 'native', createCompleted: false }
    guard()
    containers.push(guest)
    await createAndStart(guest, ['--tmpfs', `${nodeModules}:rw,nosuid,nodev,size=16m,mode=700,uid=${uid},gid=${gid}`,
      ...nativeArgs, '--workdir', sourceRoot, '--entrypoint', '/usr/bin/env', image,
      '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'TMPDIR=/tmp',
      'PE_CONNECTOR_OWNED_LINUX=' + owner, 'PE_CONNECTOR_MAIN_CONTROL=' + control,
      'PE_CONNECTOR_STAGE_CANCEL_ONLY=' + (options?.stageCancelControl ? '1' : '0'),
      'TSX_TSCONFIG_PATH=' + resolve(contextPath, 'guest-tsconfig.json'), ...guestEnvironment,
      '/usr/local/bin/node', resolve(sourceRoot, prefix, 'main-linux-case.ts')])
    assert.ok(guest.id)
    const waited = await cli('wait-native', ['wait', guest.id], 25_000, cancellation.signal)
    guard()
    assert.equal(waited.code, 0, 'Owned native guest must drain before its deadline')
    const logs = await cli('logs-native', ['logs', guest.id], 4_000, cancellation.signal)
    guard()
    writeFileSync(resolve(contextPath, 'guest.log'), logs.stdout + logs.stderr, { mode: 0o600 })
    assert.equal(logs.code, 0)
    assert.equal(waited.stdout.trim(), '0', 'Actual Linux control must complete its entry cleanup')
    const actual = result(logs.stdout, control)
    assert.equal(actual.mainSHA256, hashes[mainRelative])
    assert.equal(actual.inputSHA256, sha(childInputPath))
    assert.ok(readdirSync(resolve(contextPath, 'raw')).some(name => /^coverage-\d+-\d+-\d+\.json$/.test(name)))
    receipt.control = control
    receipt.entry = actual
    receipt.nativeMounts = nativeMounts
    runFinished = true
    return actual
  })
  const waitForSource = (): Promise<{ pid: number; birth: string }> => track(async () => {
    const deadline = Date.now() + 6_000
    while (Date.now() < deadline) {
      guard()
      if (contextPath && existsSync(resolve(contextPath, 'entry-ownership.json'))) {
        const owned = json(readFileSync(resolve(contextPath, 'entry-ownership.json'), 'utf8'))
        const guest = containers.find(row => row.role === 'native')
        assert.ok(guest && !runFinished)
        const live = await inspect(guest)
        guard()
        assert.ok(live && record(live.State).Running === true, 'Stage cancel requires an actual running guest')
        assert.ok(typeof owned.pid === 'number' && typeof owned.birth === 'string')
        receipt.sourceStartedForCancel = { pid: owned.pid, birth: owned.birth }
        return { pid: owned.pid, birth: owned.birth }
      }
      await delay(10, undefined, { signal: cancellation.signal })
    }
    throw new Error('Actual owned source child was not observed before the stage deadline')
  })
  const aborted = new Promise<{ tag: 'cancelled'; reason: unknown }>((done) => {
    const publish = (): void => {
      const reason: unknown = cancellation.signal.reason
      done({ tag: 'cancelled', reason })
    }
    if (cancellation.signal.aborted) publish()
    else cancellation.signal.addEventListener('abort', publish, { once: true })
  })
  let primary: unknown, failed = false
  try {
    const work = track(async () => {
      await track(async () => {
        const holder: OwnedContainer = { name: owner + '-holder', role: 'holder', createCompleted: false }
        guard()
        containers.push(holder)
        await createAndStart(holder, ['--entrypoint', '/usr/bin/env', image, '-i', 'PATH=/usr/local/bin:/usr/bin:/bin',
          'HOME=/tmp', '/usr/local/bin/node', '-e', 'process.once("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'])
        receipt.acquired = true
      })
      guard()
      await track(async () => {
        callbackStarted = true
        await callback({ run, waitForSource, signal: cancellation.signal })
      })
    })
    const outcome = await Promise.race([work.then(() => ({ tag: 'complete' as const })), aborted])
    if (outcome.tag === 'cancelled') throw outcome.reason
  } catch (error: unknown) {
    primary = error
    failed = true
    receipt.callbackError = error instanceof Error ? { name: error.name, message: error.message } : 'Non-Error callback failure'
  }
  try { await cleanup() }
  catch (error: unknown) {
    finalized = true
    if (failed) throw new AggregateError([primary, error], 'Linux callback and cleanup both failed', { cause: primary })
    throw error
  }
  finalized = true
  if (failed) throw primary
}
