/** Owned source tests require native Linux amd64/arm64 images matching the Docker daemon; no real Pod or app Profile is started. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { nativeDockerCoverageArguments } from '../../scripts/cloud-coverage.mjs'
import type { SandboxUnitJob } from './sandbox-protocol-flows.ts'

const bodyBudget = 90_000, cleanupBudget = 25_000, closeBudget = 2_000
const missingResource = (error: unknown): boolean => error instanceof Error && 'stderr' in error
  && /No such (?:object|container|volume|network)|network .+ not found/iu.test(String(error.stderr))
const runtimeReceipt = z.object({ nodeVersion: z.string(), job: z.string(), roleCreated: z.boolean(), roleRemoved: z.boolean(),
  caseDatabasesRemaining: z.number(), flowPassed: z.boolean(), pgServerVersion: z.string() })
type Resource = { kind: 'container' | 'volume' | 'network'; name: string }
type Outcome = { kind: 'success' } | { kind: 'failure'; error: unknown }
type Issue = { stage: string; error: unknown }
let drainTail: Promise<void> = Promise.resolve()
let unsafe: Error | undefined

function deadline(milliseconds: number, label: string, parent?: AbortSignal) {
  const controller = new AbortController(), expires = performance.now() + milliseconds
  const abort = (): void => { controller.abort(parent?.reason) }
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(new Error(`${label} exceeded ${milliseconds}ms`)) }, milliseconds)
  return { signal: controller.signal, remaining: () => Math.max(0, expires - performance.now()), finish: () => { clearTimeout(timer) },
    dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort) } }
}
type Deadline = ReturnType<typeof deadline>

/** Run one flow with a 90s aggregate body and independent 25s cleanup, including actual command-close joins.
 * A 2s close watchdog retains unresolved children and permanently fences subsequent acquisitions in this module.
 * @param job Original ready/refusal flow, or the finite listener initialization cleanup control.
 * @param signal Actual Node TestContext signal; queued cases retain cancellation while the previous case drains.
 * @returns Natural exit, durable role receipt and ownership guarded disposal evidence.
 */
export function runSandboxLinuxCase(job: SandboxUnitJob, signal: AbortSignal) {
  const body = deadline(bodyBudget, 'Sandbox acquisition/body', signal)
  const task = drainTail.then(async () => {
    if (unsafe) throw new Error('Previous sandbox case has unresolved ownership; acquisition is fenced', { cause: unsafe })
    body.signal.throwIfAborted()
    return await ownedCase(job, body)
  }).finally(() => { body.dispose() })
  // Both rejection observation and the FIFO fence exist before any acquisition begins.
  drainTail = task.then(() => undefined, () => undefined)
  return task
}

async function ownedCase(job: SandboxUnitJob, body: Deadline) {
  const input = process.env.PE_CLOUD_COVERAGE_INPUT
  const linuxImage = process.env.PE_SANDBOX_TEST_LINUX_IMAGE, pgImage = process.env.PE_SANDBOX_TEST_PG_IMAGE
  assert.ok(input, 'Native source coverage parent input is required')
  assert.ok(linuxImage && pgImage, 'Explicit immutable Linux dependency and PG fixture images are required')
  const imagePattern = /^sha256:[a-f0-9]{64}$/u
  assert.match(linuxImage, imagePattern); assert.match(pgImage, imagePattern)
  const owner = `sandbox-service-unit-${randomUUID()}`, suffix = randomBytes(5).toString('hex')
  const names = { network: `pe-sandbox-net-${suffix}`, case: `pe-sandbox-case-${suffix}`, pgdata: `pe-sandbox-pgdata-${suffix}`,
    pg: `pe-sandbox-pg-${suffix}`, unit: `pe-sandbox-unit-${suffix}` }
  const resources: Resource[] = [], disposed: Array<Resource & { absent: boolean }> = [], issues: Issue[] = []
  const children = new Set<Promise<void>>(), filesystem = new Set<Promise<void>>()
  const commandEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'TMPDIR', 'LANG', 'LC_ALL'].includes(key)))
  let scratch = '', context = '', password = '', exitCode = -1, outcome: Outcome = { kind: 'success' }
  let result: z.infer<typeof runtimeReceipt> | undefined, temporaryRootRemoved = false

  const check = (budget: Deadline): void => {
    budget.signal.throwIfAborted()
    assert.ok(budget.remaining() > 0, 'Case stage deadline expired')
  }
  const file = <T>(budget: Deadline, action: () => Promise<T>): Promise<T> => {
    check(budget)
    const operation = action()
    const closed = operation.then(() => undefined, () => undefined)
    filesystem.add(closed); void closed.then(() => filesystem.delete(closed))
    const completion = new Promise<T>((resolveFile, rejectFile) => {
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => {
        watchdog = setTimeout(() => {
          unsafe = new Error('Sandbox filesystem operation did not settle after cancellation', { cause: budget.signal.reason })
          issues.push({ stage: 'filesystem join', error: unsafe })
          // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the exact abort identity and falsy value.
          rejectFile(budget.signal.reason)
        }, closeBudget)
      }
      const finish = (): void => { clearTimeout(watchdog); budget.signal.removeEventListener('abort', abort) }
      void operation.then((value) => {
        finish()
        if (budget.signal.aborted) {
          // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the exact abort identity and falsy value.
          rejectFile(budget.signal.reason)
        } else resolveFile(value)
      }, (error: unknown) => {
        finish()
        if (budget.signal.aborted) {
          issues.push({ stage: 'filesystem error after cancellation', error })
          // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the exact abort identity and falsy value.
          rejectFile(budget.signal.reason)
        } else {
          // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the owned operation rejection value and identity.
          rejectFile(error)
        }
      })
      budget.signal.addEventListener('abort', abort, { once: true })
      if (budget.signal.aborted) abort()
    })
    void completion.catch(() => undefined)
    return completion
  }
  const command = (program: string, args: string[], budget: Deadline): Promise<string> => {
    check(budget)
    const child = spawn(program, args, { env: commandEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, failure: Outcome = { kind: 'success' }, finished = false
    let escalation: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined
    let resolveClose!: () => void
    const closed = new Promise<void>((resolveClosed) => { resolveClose = resolveClosed })
    children.add(closed)
    void closed.then(() => children.delete(closed))
    const completion = new Promise<string>((resolveCommand, rejectCommand) => {
      const fail = (error: unknown): void => { if (failure.kind === 'success') failure = { kind: 'failure', error } }
      const kill = (signalName: NodeJS.Signals): void => {
        try { child.kill(signalName) }
        catch (error) { issues.push({ stage: `${program} ${signalName}`, error }) }
      }
      const abort = (): void => {
        fail(budget.signal.reason); kill('SIGTERM')
        escalation = setTimeout(() => { kill('SIGKILL') }, 500)
        watchdog = setTimeout(() => {
          if (finished) return
          const pending = new Error(`${program} did not close after cancellation`, {
            cause: failure.kind === 'failure' ? failure.error : undefined })
          issues.push({ stage: `${program} close join`, error: pending }); unsafe = pending
          // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the exact first cause, including falsy values.
          rejectCommand(failure.kind === 'failure' ? failure.error : pending)
        }, closeBudget)
      }
      const collect = (data: Buffer, channel: 'stdout' | 'stderr'): void => {
        bytes += data.length
        if (bytes > 16_777_216) { fail(new Error(`${program} output exceeded 16MiB`)); kill('SIGKILL'); return }
        if (channel === 'stdout') stdout += data.toString()
        else stderr += data.toString()
      }
      child.stdout.on('data', (data: Buffer) => { collect(data, 'stdout') })
      child.stderr.on('data', (data: Buffer) => { collect(data, 'stderr') })
      child.once('error', (error) => { fail(error) })
      child.once('close', (code, signalName) => {
        finished = true; clearTimeout(escalation); clearTimeout(watchdog)
        budget.signal.removeEventListener('abort', abort); resolveClose()
        if (code !== 0 || signalName !== null) {
          fail(Object.assign(new Error(`${program} exited with code ${code}, signal ${signalName}`), { stdout, stderr, code, signalName }))
        }
        if (failure.kind === 'failure') {
          // eslint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the exact first cause, including falsy values.
          rejectCommand(failure.error)
        } else resolveCommand(stdout)
      })
      budget.signal.addEventListener('abort', abort, { once: true })
      if (budget.signal.aborted) abort()
    })
    void completion.catch(() => undefined)
    return completion
  }
  const docker = (args: string[], budget = body): Promise<string> => command('docker', args, budget)
  const create = async (resource: Resource, args: string[]): Promise<void> => {
    check(body); resources.push(resource); await docker(args); check(body)
  }
  const safe = (text: string): string => text.replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, '<private-pg-url>')
    .replaceAll(password || '<no-password-created>', '<private-password>')
  const diagnostic = (error: unknown) => error instanceof Error
    ? { type: 'Error', name: error.name, message: safe(error.message), stack: safe(error.stack ?? '') }
    : { type: typeof error, value: ['string', 'number', 'boolean', 'undefined'].includes(typeof error) || error === null
      ? typeof error === 'string' ? safe(error) : error : '<non-Error object>' }
  const copyCapture = async (): Promise<void> => {
    const exported = join(scratch, 'capture'); await file(body, () => mkdir(exported, { mode: 0o700 }))
    await docker(['cp', `${names.unit}:${context}/.`, exported])
    // Copy only collected bytes, as the host owner; never rewrite the official input manifest or counters.
    for (const folder of ['raw', 'code']) {
      for (const name of await file(body, () => readdir(join(exported, folder)))) {
        const target = join(context, folder, name)
        await file(body, () => rm(target, { force: true }))
        await file(body, () => copyFile(join(exported, folder, name), target)); await file(body, () => chmod(target, 0o600))
      }
    }
    for (const name of ['sandbox-runtime-receipt.json', 'sandbox-listener-control.json']) {
      try {
        await file(body, () => copyFile(join(exported, name), join(context, name)))
        await file(body, () => chmod(join(context, name), 0o600))
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
  }
  try {
    // Publish scratch ownership before chmod or any subsequent acquisition can fail.
    await file(body, async () => { scratch = await mkdtemp(join(tmpdir(), 'pe-sandbox-linux-')); return scratch })
    await file(body, () => chmod(scratch, 0o700))
    const daemon = z.object({ os: z.literal('linux'), architecture: z.enum(['amd64', 'x86_64', 'arm64', 'aarch64']) }).parse(
      JSON.parse(await docker(['info', '--format', '{"os":{{json .OSType}},"architecture":{{json .Architecture}}}'])))
    const architecture = daemon.architecture === 'arm64' || daemon.architecture === 'aarch64' ? 'arm64' : 'amd64'
    for (const image of [linuxImage, pgImage]) {
      const fact = (await docker(['image', 'inspect', '--format', '{{.Id}} {{.Os}} {{.Architecture}}', image])).trim()
      assert.equal(fact, `${image} linux ${architecture}`, 'Both immutable images must match the native Linux Docker daemon')
    }
    // Explicit private /24 avoids the exhausted default pool; Docker refuses occupied ranges atomically.
    await create({ kind: 'network', name: names.network }, ['network', 'create', '--subnet', `10.249.${100 + randomBytes(1).readUInt8(0) % 150}.0/24`,
      '--label', `pe.owner=${owner}`, names.network])
    for (const name of [names.case, names.pgdata]) await create({ kind: 'volume', name }, ['volume', 'create', '--label', `pe.owner=${owner}`, name])
    password = randomBytes(32).toString('hex'); const user = `pe_sandbox_admin_${suffix}`, environment = join(scratch, 'postgres-env-private')
    await file(body, () => writeFile(environment, `POSTGRES_USER=${user}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=postgres\n`, { mode: 0o600 }))
    await create({ kind: 'container', name: names.pg }, ['create', '--name', names.pg, '--label', `pe.owner=${owner}`, '--network', names.network,
      '--env-file', environment, '--mount', `type=volume,source=${names.pgdata},target=/var/lib/postgresql/data`, pgImage])
    await docker(['start', names.pg])
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=owned-sandbox-unit',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], body)
    await file(body, () => chmod(join(scratch, 'key.pem'), 0o600)); await file(body, () => chmod(join(scratch, 'cert.pem'), 0o600))
    check(body); const coverage = nativeDockerCoverageArguments(input)
    const childInput = coverage.find((arg: string) => arg.startsWith('PE_CLOUD_COVERAGE_INPUT='))?.slice('PE_CLOUD_COVERAGE_INPUT='.length)
    assert.ok(childInput); context = dirname(childInput); check(body)
    assert.match(basename(context), /^[a-f0-9-]{36}$/u)
    const parameters = join(scratch, 'input-private.json')
    await file(body, () => writeFile(parameters, JSON.stringify({ adminUrl: `postgresql://${user}:${password}@${names.pg}:5432/postgres`,
      caseRole: `pe_sandbox_case_${suffix}`, job, tlsDirectory: scratch, receipt: join(context, 'sandbox-runtime-receipt.json'),
      controlReceipt: join(context, 'sandbox-listener-control.json') }), { mode: 0o600 }))
    const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const sourceRoot = resolve(dirname(await file(body, () => realpath(fileURLToPath(new URL('../src/platform/sandbox.ts', import.meta.url))))), '../../../../..')
    const fixtureMount = fixtureRoot === sourceRoot ? [] : ['--mount', `type=bind,source=${fixtureRoot},target=${fixtureRoot},readonly`]
    await create({ kind: 'container', name: names.unit }, ['create', '--name', names.unit, '--label', `pe.owner=${owner}`, '--network', names.network,
      '--user', '0:0', '--read-only', '--entrypoint', '/usr/local/bin/node', ...coverage, ...fixtureMount,
      '--env', `PE_SANDBOX_UNIT_INPUT_FILE=${parameters}`, '--env', 'TMPDIR=/case-data',
      '--mount', `type=bind,source=${scratch},target=${scratch},readonly`, '--mount', `type=volume,source=${names.case},target=/case-data`,
      '--workdir', sourceRoot, linuxImage, '--import', '/opt/power-evolve/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs',
      fileURLToPath(new URL('./sandbox-unit-runtime.ts', import.meta.url))])
    // An attach failure remains primary even if Docker later reports exit 0 or a logging operation fails.
    let attach: { kind: 'success'; output: string } | { kind: 'failure'; error: unknown }
    try { attach = { kind: 'success', output: await docker(['start', '--attach', names.unit]) } }
    catch (error) { attach = { kind: 'failure', error } }
    const output = attach.kind === 'success' ? attach.output : attach.error instanceof Error
      ? `${'stdout' in attach.error ? String(attach.error.stdout) : ''}${'stderr' in attach.error ? String(attach.error.stderr) : ''}` : ''
    try { await file(body, () => writeFile(join(context, 'sandbox-unit.log'), safe(output), { mode: 0o600 })) }
    catch (error) { if (attach.kind === 'success') throw error; issues.push({ stage: 'attach log', error }) }
    if (attach.kind === 'failure') throw attach.error
    check(body)
    const state = z.object({ Running: z.boolean(), ExitCode: z.number(), FinishedAt: z.string() }).parse(
      JSON.parse(await docker(['inspect', '--format', '{{json .State}}', names.unit])))
    assert.equal(state.Running, false, 'Child must reach its natural terminal state before capture or disposal')
    assert.ok(!state.FinishedAt.startsWith('0001-')); exitCode = state.ExitCode
    await copyCapture()
    result = runtimeReceipt.parse(JSON.parse(await file(body, () => readFile(join(context, 'sandbox-runtime-receipt.json'), 'utf8'))))
    assert.equal(exitCode, 0, 'Owned Linux flow must reach its natural successful exit')
    assert.equal(result.flowPassed, true); assert.equal(result.roleRemoved, true); assert.equal(result.caseDatabasesRemaining, 0)
  } catch (error) { outcome = { kind: 'failure', error } }
  finally {
    body.finish()
    const cleanup = deadline(cleanupBudget, 'Sandbox cleanup')
    const attempt = async (stage: string, action: () => Promise<unknown>): Promise<boolean> => {
      try { await action(); return true }
      catch (error) { issues.push({ stage, error }); return false }
    }
    try {
      // An undrained command cannot race resource disposal or a subsequent case's acquisition.
      if (children.size !== 0 || filesystem.size !== 0) {
        unsafe = new Error('Sandbox operation ownership has not reached quiescence')
        issues.push({ stage: 'pending operation ownership', error: unsafe })
      } else {
        for (const resource of resources.reverse()) {
          const format = resource.kind === 'container' ? '{{index .Config.Labels "pe.owner"}}' : '{{index .Labels "pe.owner"}}'
          let absent = false
          const inspected = await attempt(`${resource.kind} owner inspection`, async () => {
            let label: string
            try { label = (await docker([resource.kind, 'inspect', '--format', format, resource.name], cleanup)).trim() }
            catch (error) { if (!missingResource(error)) throw error; absent = true; return }
            assert.equal(label, owner, 'Refuse foreign resource disposal')
            if (resource.kind === 'container') {
              await attempt('container stop', () => docker(['stop', '--time', '3', resource.name], cleanup))
              await attempt('container remove', () => docker(['rm', '--force', resource.name], cleanup))
            } else await attempt(`${resource.kind} remove`, () => docker([resource.kind, 'rm', resource.name], cleanup))
            try { await docker([resource.kind, 'inspect', '--format', format, resource.name], cleanup) }
            catch (error) { if (!missingResource(error)) throw error; absent = true }
            assert.equal(absent, true, 'Owned resource must be confirmed absent')
          })
          disposed.push({ ...resource, absent: inspected && absent })
        }
        if (scratch) temporaryRootRemoved = await attempt('scratch remove', () => file(cleanup, () => rm(scratch, { recursive: true, force: true })))
        else temporaryRootRemoved = true
      }
      if (children.size !== 0 || filesystem.size !== 0 || disposed.length !== resources.length
        || disposed.some(resource => !resource.absent) || !temporaryRootRemoved) {
        unsafe ??= new Error('Sandbox cleanup left unresolved ownership; later acquisitions are fenced')
      }
      if (outcome.kind === 'success' && body.signal.aborted) outcome = { kind: 'failure', error: body.signal.reason }
      if (context) await attempt('lifecycle write', () => file(cleanup, () => writeFile(join(context, 'sandbox-owned-lifecycle.json'), JSON.stringify({
        owner, job, exitCode, disposed, temporaryRootRemoved, sourceAndSdkReadonly: true, nativeContextRetainedForConversion: true,
        bodyBudget, cleanupBudget, closeBudget,
        primaryOutcome: outcome.kind === 'success' ? outcome : { kind: 'failure', error: diagnostic(outcome.error) },
        issues: issues.map(issue => ({ stage: issue.stage, error: diagnostic(issue.error) })),
        pendingCommands: children.size, pendingFilesystem: filesystem.size,
        unresolvedOwnership: Boolean(unsafe), cleanupFinishedAt: new Date().toISOString(),
      }, null, 2) + '\n', { mode: 0o600 })))
    } finally { cleanup.dispose() }
  }
  if (outcome.kind === 'success' && body.signal.aborted) outcome = { kind: 'failure', error: body.signal.reason }
  if (outcome.kind === 'failure') {
    if (issues.length) throw new AggregateError([outcome.error, ...issues.map(issue => issue.error)], 'Sandbox case and diagnostic/cleanup operations failed', { cause: outcome.error })
    throw outcome.error
  }
  if (issues.length) throw new AggregateError(issues.map(issue => issue.error), 'Sandbox diagnostic/cleanup operations failed')
  assert.ok(result)
  return { context, exitCode, result, disposed }
}
