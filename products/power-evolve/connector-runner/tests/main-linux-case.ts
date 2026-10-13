/** Linux-only execution payload. The ordinary host imports the fixture, never this payload. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { MainLinuxControl } from './main-linux-fixture.ts'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function sha(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function birth(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const tick = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  assert.ok(tick && /^[1-9][0-9]*$/.test(tick))
  return 'linux:' + tick
}
async function unusedPort(): Promise<number> {
  const server = net.createServer()
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    return address.port
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => {
      if (error) reject(error)
      else done()
    }))
  }
}
function health(port: number, token: string): Promise<number> {
  return new Promise((done, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', agent: false,
      headers: { 'x-power-evolve-runner-token': token }, timeout: 200 }, (response) => {
      response.resume()
      response.once('end', () => { done(response.statusCode ?? 0) })
      response.once('error', reject)
    })
    request.once('error', reject)
    request.once('timeout', () => { request.destroy(new Error('Owned health request timed out')) })
  })
}
async function listenerClosed(port: number): Promise<boolean> {
  try { await health(port, 'unused-public-control'); return false }
  catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ECONNREFUSED'
  }
}
function signal0(pid: number): 'ESRCH' {
  try { process.kill(pid, 0) }
  catch (error: unknown) {
    assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH')
    return 'ESRCH'
  }
  throw new Error('Owned entry remains alive after its exit event')
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'linux')
  const owner = process.env.PE_CONNECTOR_OWNED_LINUX
  assert.ok(owner && owner.startsWith('connector-main-'))
  assert.equal(readFileSync('/etc/hostname', 'utf8').trim(), owner)
  const mounts = readFileSync('/proc/mounts', 'utf8').split('\n').map(line => line.split(' '))
  assert.ok(mounts.some(row => row[1] === '/run' && row[2] === 'tmpfs'))
  const selected = process.env.PE_CONNECTOR_MAIN_CONTROL
  assert.ok(selected === 'default-token' || selected === 'default-port'
    || selected === 'non-error-token-read' || selected === 'http-close-error')
  const control: MainLinuxControl = selected
  const inputPath = process.env.PE_CLOUD_COVERAGE_INPUT
  assert.ok(inputPath)
  const context = dirname(inputPath)
  const inputValue: unknown = JSON.parse(readFileSync(inputPath, 'utf8'))
  const input = record(inputValue)
  const sourceRoot = input.physicalRoot
  assert.ok(typeof sourceRoot === 'string')
  assert.equal(input.executionRoot, sourceRoot)
  const nodeModules = resolve(sourceRoot, 'products/power-evolve/connector-runner/node_modules')
  assert.ok(mounts.some(row => row[1] === nodeModules && row[2] === 'tmpfs'))
  mkdirSync(resolve(nodeModules, '@modelcontextprotocol'), { recursive: true })
  const store = '/opt/power-evolve/node_modules/.pnpm/'
  symlinkSync(store + '@modelcontextprotocol+client@2.0.0/node_modules/@modelcontextprotocol/client',
    resolve(nodeModules, '@modelcontextprotocol/client'))
  symlinkSync(store + 'ssh2@1.17.0/node_modules/ssh2', resolve(nodeModules, 'ssh2'))
  const temporary = mkdtempSync('/tmp/connector-main-')
  const token = randomBytes(32).toString('hex')
  const defaultTokenFile = control === 'default-token'
  const defaultPort = control === 'default-port'
  const tokenFile = defaultTokenFile ? '/run/power-evolve/runner-token' : resolve(temporary, 'token')
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 })
  writeFileSync(tokenFile, token, { mode: 0o600 })
  const port = defaultPort ? 8080 : await unusedPort()
  const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  const hashes = record(input.hashes)
  const mainSHA256 = sha(entry)
  assert.equal(hashes['products/power-evolve/connector-runner/src/main.ts'], mainSHA256)
  const unit = control === 'non-error-token-read' || control === 'http-close-error'
  const receipt = resolve(context, 'unit-fault.json')
  const options = process.env.NODE_OPTIONS
  const coverage = process.env.NODE_V8_COVERAGE
  assert.ok(options && coverage)
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp',
    PE_CLOUD_COVERAGE_INPUT: inputPath, NODE_V8_COVERAGE: coverage, TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH,
    NODE_OPTIONS: options + (unit ? ' --import=' + pathToFileURL(fileURLToPath(new URL('./main-linux-unit-fault.ts', import.meta.url))).href : '') }
  if (!defaultTokenFile) environment.CONNECTOR_RUNNER_TOKEN_FILE = tokenFile
  if (!defaultPort) environment.CONNECTOR_RUNNER_PORT = String(port)
  if (unit) { environment.PE_CONNECTOR_UNIT_FAULT = control; environment.PE_CONNECTOR_UNIT_RECEIPT = receipt }
  const child = spawn(process.execPath, [entry], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false, stdout = '', stderr = ''
  const exit = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { exited = true; done({ code, signal }) })
  })
  // Observe immediately so a startup failure remains handled while health readiness is being checked.
  void exit.catch(() => {})
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const cleanupErrors: unknown[] = []
  let failed = false, primary: unknown, completed: Record<string, unknown> | undefined, actualBirth: string | undefined
  const waitExit = async (ms: number): Promise<{ code: number | null; signal: string | null }> => {
    const timeout = new AbortController()
    try {
      return await Promise.race([exit, delay(ms, undefined, { signal: timeout.signal }).then(() => {
        throw new Error('Owned entry did not drain within its phase deadline')
      })])
    } finally { timeout.abort() }
  }
  const signalOwned = (signal: NodeJS.Signals): void => {
    assert.ok(child.pid && actualBirth, 'A source child requires acquired kernel identity before signalling')
    try { assert.equal(birth(child.pid), actualBirth, 'Owned source PID birth must still match') }
    catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'ENOENT')) return
      throw error
    }
    child.kill(signal)
  }
  try {
    const pid = child.pid
    assert.ok(pid)
    actualBirth = birth(pid)
    const ownershipTemporary = resolve(context, 'entry-ownership-publish-' + String(pid) + '.tmp')
    writeFileSync(ownershipTemporary, JSON.stringify({ pid, birth: actualBirth,
      directChild: true, owner, currentMainSHA256: mainSHA256, inputSHA256: sha(inputPath) }), { mode: 0o600 })
    renameSync(ownershipTemporary, resolve(context, 'entry-ownership.json'))
    // The separate cancellation control keeps the actual source child live at its observed stage.
    if (process.env.PE_CONNECTOR_STAGE_CANCEL_ONLY === '1') await delay(12_000)
    let healthStatus: number | undefined
    if (control !== 'non-error-token-read') {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && !exited) {
        try { healthStatus = await health(port, token); break }
        catch { await delay(25) }
      }
      assert.equal(healthStatus, 503, 'Actual main entry must expose its unready authenticated health endpoint')
      assert.equal(birth(pid), actualBirth)
      assert.equal(child.kill('SIGTERM'), true)
    }
    const actualExit = await waitExit(6_000)
    assert.equal(actualExit.signal, null)
    assert.equal(actualExit.code, unit ? 1 : 0)
    if (stdout.includes(token) || stderr.includes(token)) throw new Error('Synthetic credential appeared in entry output')
    assert.equal(stdout, '')
    assert.equal(stderr, control === 'non-error-token-read' ? 'Connector Runner failed to start: Error\n' : '')
    assert.equal(await listenerClosed(port), true)
    const readonlySignal0 = signal0(pid)
    const unitValue: unknown = unit ? JSON.parse(readFileSync(receipt, 'utf8')) : undefined
    const unitFault = unit ? record(unitValue) : undefined
    if (unitFault) {
      assert.equal(unitFault.pid, pid)
      assert.equal(unitFault.childLocalUnitFault, true)
    }
    completed = { control, pid, birth: actualBirth, readonlySignal0, listenerClosed: true,
      exitCode: actualExit.code, mainSHA256, inputSHA256: sha(inputPath), defaultTokenFile, defaultPort, stderr,
      ...(healthStatus === undefined ? {} : { healthStatus }), ...(unitFault ? { unitFault } : {}) }
  } catch (error: unknown) { failed = true; primary = error }
  finally {
    try {
      if (!exited) {
        signalOwned('SIGTERM')
        try { await waitExit(3_000) }
        catch (error: unknown) {
          cleanupErrors.push(error)
          signalOwned('SIGKILL')
          await waitExit(3_000)
        }
      } else await exit
    } catch (error: unknown) { cleanupErrors.push(error) }
    try { rmSync(temporary, { recursive: true, force: true }) }
    catch (error: unknown) { cleanupErrors.push(error) }
    if (defaultTokenFile) {
      try { rmSync(tokenFile) } catch (error: unknown) { cleanupErrors.push(error) }
    }
    try {
      writeFileSync(resolve(context, 'entry-cleanup.json'), JSON.stringify({ pid: child.pid ?? null,
        birth: actualBirth ?? null, actualExitCode: child.exitCode, actualExitSignal: child.signalCode, drained: exited,
        originalError: failed ? primary instanceof Error ? { name: primary.name, message: primary.message } : 'Non-Error failure' : null,
        cleanupErrors: cleanupErrors.map(error => error instanceof Error ? error.message : 'Non-Error cleanup failure') }),
      { mode: 0o600 })
    } catch (error: unknown) { cleanupErrors.push(error) }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failed ? [primary, ...cleanupErrors] : cleanupErrors,
      'Actual entry cleanup failed', failed ? { cause: primary } : {})
  }
  if (failed) throw primary
  assert.ok(completed)
  writeFileSync(resolve(context, 'entry.json'), JSON.stringify(completed, null, 2), { mode: 0o600 })
  process.stdout.write(JSON.stringify(completed) + '\n')
}

await main()
