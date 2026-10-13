/** Owned Linux source-service launcher; actual test cancellation and resource drain precede the next acquisition. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { nativeDockerCoverageArguments } from '../../scripts/cloud-coverage.mjs'
import type { WorkerFlow } from './employee6-stdio-worker-source-flows.ts'

type Resource = { kind: 'container' | 'network' | 'volume'; name: string }
type Command = {
  tool: string
  phase: 'body' | 'cleanup'
  pid: number | undefined
  elapsedMs: number
  exitCode: number | string | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
}
let drain: Promise<void> = Promise.resolve(), unsafePreviousCleanup = false

/** Run one already-selected flow; incomplete prior disposal fences all later resource creation.
 * @param job Selected business flow, with its own empty database and Linux PID namespace.
 * @param signal Actual Node TestContext cancellation; independent disposal still drains.
 * @returns Natural child termination and owned resource disposal observations.
 */
export function runWorkerLinuxCase(job: WorkerFlow, signal: AbortSignal) {
  const active = drain.then(async () => {
    signal.throwIfAborted(); assert(!unsafePreviousCleanup, 'Previous owned fixture disposal must finish before another acquisition')
    return executeCase(job, signal)
  })
  drain = active.then(() => {}, () => {})
  return active
}

async function executeCase(job: WorkerFlow, signal: AbortSignal) {
  const input = process.env.PE_CLOUD_COVERAGE_INPUT
  assert(input, 'Fresh official native coverage input is required')
  const image = process.env.PE_EMPLOYEE6_STDIO_LINUX_IMAGE, pgImage = process.env.PE_EMPLOYEE6_STDIO_PG_IMAGE
  assert(image && pgImage); assert.match(image, /^sha256:[a-f0-9]{64}$/u); assert.match(pgImage, /^sha256:[a-f0-9]{64}$/u)
  const owner = 'e6-stdio-service-' + randomUUID(), suffix = randomBytes(6).toString('hex')
  const names = { network: `pe-e6-stdio-net-${suffix}`, data: `pe-e6-stdio-data-${suffix}`,
    pgdata: `pe-e6-stdio-pgdata-${suffix}`, pg: `pe-e6-stdio-pg-${suffix}`, unit: `pe-e6-stdio-unit-${suffix}` }
  const scratch = await mkdtemp(join(tmpdir(), 'pe-e6-stdio-input-')); await chmod(scratch, 0o700)
  const resources: Resource[] = [], disposed: Array<Resource & { absent: boolean }> = [], commands: Command[] = []
  const started = Date.now(), bodyEnd = started + 85_000
  let cleanupEnd = 0, context = '', bodyAborted = false, timedOut = false
  let naturalExit: number | undefined, result: unknown
  let primary: { kind: 'success' } | { kind: 'failure'; error: unknown } = { kind: 'success' }
  const cleanupErrors: string[] = [], running = new Set<Promise<unknown>>()
  const password = randomBytes(32).toString('hex')
  const invoke = (tool: string, args: string[], phase: 'body' | 'cleanup'): Promise<{ stdout: string; stderr: string }> => {
    const remaining = (phase === 'body' ? bodyEnd : cleanupEnd) - Date.now()
    assert(remaining > 0, `Owned ${phase} budget expired`)
    if (phase === 'body') signal.throwIfAborted()
    let childPid: number | undefined, deadlineHit = false, abortedBySignal = false
    const start = Date.now(), timeout = Math.min(phase === 'body' && args[0] === 'start' ? 70_000 : 15_000, remaining)
    const operation = new Promise<{ stdout: string; stderr: string }>((done, reject) => {
      const child = execFile(tool, args, { encoding: 'utf8', maxBuffer: 16_777_216 }, (error, stdout, stderr) => {
        clearTimeout(deadlineTimer); if (escalation) clearTimeout(escalation)
        signal.removeEventListener('abort', abortChild)
        const aborted = abortedBySignal
        const elapsedMs = Date.now() - start
        const wasTimeout = deadlineHit
        const termination = error && 'signal' in error && typeof error.signal === 'string' ? error.signal : null
        const code = error && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : error ? null : 0
        commands.push({ tool, phase, pid: childPid, elapsedMs, exitCode: code, signal: termination, timedOut: wasTimeout, aborted })
        if (phase === 'body') { bodyAborted ||= aborted; timedOut ||= wasTimeout }
        if (error || wasTimeout || aborted) reject(Object.assign(new Error('Owned command failed'), {
          stderr: stderr.replaceAll(password, '<private>'), commandCode: code, commandSignal: termination }))
        else done({ stdout, stderr })
      })
      childPid = child.pid
      let escalation: ReturnType<typeof setTimeout> | undefined
      const terminate = () => {
        child.kill('SIGTERM')
        escalation ??= setTimeout(() => { child.kill('SIGKILL') }, 2000)
      }
      const abortChild = () => { abortedBySignal = true; terminate() }
      const deadlineTimer = setTimeout(() => { deadlineHit = true; terminate() }, timeout)
      if (phase === 'body') {
        signal.addEventListener('abort', abortChild, { once: true })
        if (signal.aborted) abortChild()
      }
    })
    running.add(operation); void operation.then(() => running.delete(operation), () => running.delete(operation))
    return operation
  }
  const docker = (args: string[], phase: 'body' | 'cleanup' = 'body') => invoke('docker', args, phase)
  const create = async (resource: Resource, args: string[]) => { resources.push(resource); await docker(args) }
  const absent = (error: unknown) => error instanceof Error && 'stderr' in error
    && /No such (?:object|container|volume|network)|network .+ not found/iu.test(String(error.stderr))
  const copyCapture = async (phase: 'body' | 'cleanup') => {
    assert(context)
    const target = join(scratch, 'exported-evidence'); await mkdir(target, { recursive: true, mode: 0o700 })
    await docker(['cp', `${names.unit}:${context}/.`, target], phase)
    for (const folder of ['raw', 'code']) for (const name of await readdir(join(target, folder))) {
      await copyFile(join(target, folder, name), join(context, folder, name)); await chmod(join(context, folder, name), 0o600)
    }
    const receipt = join(target, 'worker-runtime-receipt.private.json')
    await copyFile(receipt, join(context, 'worker-runtime-receipt.private.json')); result = JSON.parse(await readFile(receipt, 'utf8'))
  }
  try {
    const platform = z.object({ os: z.literal('linux'), architecture: z.enum(['amd64', 'x86_64', 'arm64', 'aarch64']) })
      .parse(JSON.parse((await docker(['info', '--format',
        '{"os":{{json .OSType}},"architecture":{{json .Architecture}}}'])).stdout))
    const architecture = platform.architecture === 'arm64' || platform.architecture === 'aarch64' ? 'arm64' : 'amd64'
    for (const pin of [image, pgImage]) assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', pin])).stdout.trim(),
      `${pin} linux ${architecture}`)
    await create({ kind: 'network', name: names.network }, ['network', 'create', '--subnet', `10.247.${100 + randomBytes(1).readUInt8() % 150}.0/24`,
      '--label', `pe.owner=${owner}`, names.network])
    for (const name of [names.data, names.pgdata]) await create({ kind: 'volume', name }, ['volume', 'create', '--label', `pe.owner=${owner}`, name])
    const admin = 'pe_e6_admin_' + suffix, envFile = join(scratch, 'postgres-env-private')
    await writeFile(envFile, `POSTGRES_USER=${admin}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=postgres\n`, { flag: 'wx', mode: 0o600 })
    await create({ kind: 'container', name: names.pg }, ['create', '--name', names.pg, '--label', `pe.owner=${owner}`, '--network', names.network,
      '--env-file', envFile, '--mount', `type=volume,source=${names.pgdata},target=/var/lib/postgresql/data`, pgImage])
    await docker(['start', names.pg])
    await invoke('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=owned-e6-stdio',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], 'body')
    await chmod(join(scratch, 'key.pem'), 0o600); await chmod(join(scratch, 'cert.pem'), 0o600)
    const coverage = nativeDockerCoverageArguments(input), childInput = coverage.find(arg => arg.startsWith('PE_CLOUD_COVERAGE_INPUT='))
      ?.slice('PE_CLOUD_COVERAGE_INPUT='.length)
    assert(childInput); context = dirname(childInput)
    const parameters = join(scratch, 'parameters-private.json')
    await writeFile(parameters, JSON.stringify({ adminUrl: `postgresql://${admin}:${password}@${names.pg}:5432/postgres`,
      tlsRoot: scratch, imageId: image, imageArchitecture: architecture,
      receipt: join(context, 'worker-runtime-receipt.private.json'), job }), { flag: 'wx', mode: 0o600 })
    const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const sourceRoot = resolve(dirname(await realpath(fileURLToPath(new URL('../src/platform/stdio-v2-cloud-worker.ts', import.meta.url)))), '../../../../..')
    const fixtureMount = fixtureRoot === sourceRoot ? [] : ['--mount', `type=bind,source=${fixtureRoot},target=${fixtureRoot},readonly`]
    await create({ kind: 'container', name: names.unit }, ['create', '--name', names.unit, '--label', `pe.owner=${owner}`, '--network', names.network,
      '--user', '0:0', '--read-only', '--entrypoint', '/usr/local/bin/node', ...coverage,
      '--env', `PE_EMPLOYEE6_STDIO_INPUT_FILE=${parameters}`, '--env', 'TMPDIR=/case-data',
      ...fixtureMount,
      '--mount', `type=bind,source=${scratch},target=${scratch},readonly`, '--mount', `type=volume,source=${names.data},target=/case-data`,
      '--workdir', sourceRoot, image, '--import', '/opt/power-evolve/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs',
      '--test', '--test-reporter=tap', fileURLToPath(new URL('./employee6-stdio-worker-runtime.ts', import.meta.url))])
    const output = await docker(['start', '--attach', names.unit])
    await writeFile(join(context, 'worker-linux.stdout.tap'), output.stdout.replaceAll(password, '<private>'), { mode: 0o600 })
    const state = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', names.unit])).stdout) as { Running: boolean; ExitCode: number }
    assert.equal(state.Running, false); naturalExit = state.ExitCode
    await copyCapture('body'); assert.equal(naturalExit, 0, 'Owned Linux source flow must naturally exit0')
  } catch (error) { primary = { kind: 'failure', error } }
  finally {
    cleanupEnd = Date.now() + 25_000
    await Promise.allSettled(running)
    for (const resource of resources.reverse()) {
      try {
        const format = resource.kind === 'container' ? '{{index .Config.Labels "pe.owner"}}' : '{{index .Labels "pe.owner"}}'
        let label: string
        try { label = (await docker([resource.kind, 'inspect', '--format', format, resource.name], 'cleanup')).stdout.trim() }
        catch (error) { if (!absent(error)) throw error; disposed.push({ ...resource, absent: true }); continue }
        assert.equal(label, owner, 'Only owned resources may be disposed')
        if (resource.kind === 'container') {
          if (resource.name === names.unit) {
            const original = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', resource.name], 'cleanup')).stdout) as { Running: boolean; ExitCode: number }
            if (!original.Running && !timedOut && !bodyAborted) naturalExit = original.ExitCode
          }
          await docker(['stop', '--time', '3', resource.name], 'cleanup')
          const state = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', resource.name], 'cleanup')).stdout) as { Running: boolean }
          assert.equal(state.Running, false, 'Await actual container quiescence before removal')
          if (resource.name === names.unit && context && result === undefined) {
            try { await copyCapture('cleanup') } catch (_failedCaptureExport) { cleanupErrors.push('failed_case_capture_export_unavailable') }
          }
          await docker(['rm', resource.name], 'cleanup')
        } else await docker([resource.kind, 'rm', resource.name], 'cleanup')
        let exists = true
        try { await docker([resource.kind, 'inspect', '--format', format, resource.name], 'cleanup') }
        catch (error) { if (!absent(error)) throw error; exists = false }
        assert(!exists); disposed.push({ ...resource, absent: true })
      } catch (_ownedDisposalFailure) { disposed.push({ ...resource, absent: false }); cleanupErrors.push('owned_resource_disposal_failed') }
    }
    unsafePreviousCleanup ||= disposed.some(row => !row.absent)
    await rm(scratch, { recursive: true, force: true })
    if (context) await writeFile(join(context, 'worker-owned-lifecycle.private.json'), JSON.stringify({ job, owner, naturalExit,
      bodyAborted, timedOut, elapsedMs: Date.now() - started, disposed, commands, cleanupErrors,
      inputSecretsRemoved: true, sourceAndSdkReadonly: true, physicalPodQualified: false }, null, 2) + '\n', { mode: 0o600 })
  }
  if (primary.kind === 'failure') throw primary.error
  assert.deepEqual(cleanupErrors, []); assert(!unsafePreviousCleanup)
  return { context, naturalExit, result, disposed }
}
