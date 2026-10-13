/** CI-only fixed Office inputs; the production assembler owns the deployed closure definition. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleOfficePreview } from '../../products/power-evolve/sandbox/scripts/assemble-office-preview.mjs'

const inputRoot = fileURLToPath(new URL('./office-sdk-0.1.1-input/', import.meta.url))
const base = 'node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436'
// Both child manifests come from this exact parent index, retaining its Linux platform identity.
const platformBases = {
  arm64: 'node:22.23.2-bookworm-slim@sha256:253da19867dd03e2f817f433d7782adefd2a2bac8729fcd4ebc6770665167a24',
  x64: 'node:22.23.2-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066',
}
const owner = 'power-evolve-office-ci'
const expected = {
  'package.json': '245d64428e6c5a4d1866b69b888a4b19711135f2143740117f7b81eb08795cda',
  'package-lock.json': '9d5b0a4270b10871536c5048f51c750e402e7ea551a692e920b137c01cbf3d2b',
}
const flags = new Set(['--out', '--mode', '--cache', '--validator', '--docker-context', '--arch'])
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Parse the explicit CI flags; duplicate, missing, relative output and unsupported modes reject.
 * @param argv - Command arguments without Node and script names.
 * @returns Validated CI path and platform options; no package, image or executable overrides.
 */
export function parseOfficeCiArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1]
    assert.ok(flags.has(flag), 'Unknown Office CI flag')
    assert.ok(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'Missing Office CI value')
    const key = flag.slice(2)
    assert.equal(Object.hasOwn(options, key), false, 'Duplicate Office CI flag')
    if (['out', 'cache', 'validator'].includes(key)) {
      assert.equal(/[\0\r\n,]/u.test(value), false, 'Unsafe Office CI path')
    }
    options[key] = value
  }
  assert.ok(options.out && isAbsolute(options.out), '--out must be a fresh absolute path')
  assert.ok(['online', 'offline'].includes(options.mode), '--mode online|offline required')
  options.arch ??= 'arm64'
  assert.ok(['arm64', 'x64'].includes(options.arch), 'Unsupported Office CI architecture')
  if (options.mode === 'offline') assert.ok(options.cache, 'Offline CI needs its prepared npm cache')
  else assert.equal(options.cache, undefined, 'Cache is only used in offline CI')
  return options
}

function overlap(root, path) {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}

async function physicalTree(path, records = []) {
  const status = await lstat(path)
  assert.equal(status.isSymbolicLink(), false, 'Office CI resource symlink rejected')
  if (status.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await physicalTree(join(path, name), records)
  } else {
    assert.ok(status.isFile(), 'Office CI nonregular resource rejected')
    assert.equal(status.nlink, 1, 'Office CI linked resource rejected')
    records.push({ path, mode: status.mode & 0o777 })
  }
  return records
}

async function freeze(path) {
  const status = await lstat(path)
  if (status.isDirectory()) {
    for (const name of await readdir(path)) await freeze(join(path, name))
    await chmod(path, 0o555)
  } else await chmod(path, status.mode & 0o555)
}

async function preflight(options) {
  const destination = resolve(options.out), parent = await realpath(dirname(destination))
  assert.equal(parent, dirname(destination), 'Output parent must be canonical and physical')
  assert.equal(overlap(destination, resolve(inputRoot)) || overlap(inputRoot, destination), false, 'Input/output overlap')
  if (options.cache) {
    const cache = resolve(options.cache)
    assert.equal(await realpath(cache), cache, 'Cache root must be canonical and physical')
    assert.equal(overlap(destination, cache) || overlap(cache, destination), false, 'Output/cache overlap')
    await physicalTree(cache)
  }
  const validator = resolve(options.validator ?? 'products/power-evolve/contracts/lib/browser/office-preview.js')
  assert.equal(await realpath(validator), validator, 'Validator must be physical')
  assert.ok((await lstat(validator)).isFile(), 'Validator must be a regular file')
  assert.equal(overlap(destination, validator), false, 'Validator/output overlap')
  assert.equal(await realpath(inputRoot), resolve(inputRoot), 'SDK input root must be physical')
  for (const [name, digest] of Object.entries(expected)) {
    const path = join(inputRoot, name)
    await physicalTree(path)
    assert.equal(hash(await readFile(path)), digest, 'Fixed SDK input changed')
  }
  return { destination, validator }
}

function command(args, milliseconds = 30_000, signal) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = [], stdout = [], stderr = []
    let bytes = 0, timedOut = false
    const collect = (chunk, isStdout) => {
      bytes += chunk.length
      if (bytes > 64 * 1024 * 1024) child.kill('SIGKILL')
      else { chunks.push(chunk); (isStdout ? stdout : stderr).push(chunk) }
    }
    child.stdout.on('data', chunk => collect(chunk, true)); child.stderr.on('data', chunk => collect(chunk, false))
    child.once('error', reject)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, milliseconds)
    const stop = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.once('close', (status, childSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop)
      resolveResult({ status, signal: childSignal, timedOut, output: Buffer.concat(chunks).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

async function checkedCommand(prefix, args) {
  const result = await command([...prefix, ...args])
  assert.equal(result.status, 0, `Owned Docker operation failed: ${args[0]}`)
  return result.stdout.trim()
}

async function recoverInstaller(prefix, name, runId, report) {
  const found = await command([...prefix, 'inspect', '--type', 'container', name])
  report.createRecovery = { status: found.status, signal: found.signal, timedOut: found.timedOut }
  if (found.status !== 0) {
    assert.ok(found.status === 1 && found.stdout.trim() === '[]'
      && found.stderr.includes('No such container: ' + name), 'Owned installer recovery is indeterminate')
    report.createRecovery.absent = true
    return undefined
  }
  const item = JSON.parse(found.stdout)[0]
  assert.equal(item.Name, '/' + name, 'Recovered installer name changed')
  assert.equal(item.Config.Labels['codex.owner'], owner, 'Recovered installer owner changed')
  assert.equal(item.Config.Labels['powerevolve.dev/run'], runId, 'Recovered installer run identity changed')
  assert.match(item.Id, /^[a-f0-9]{64}$/u, 'Recovered installer ID invalid')
  report.containerId = item.Id
  return item.Id
}

async function cleanup(prefix, containerId, runId, report) {
  const items = JSON.parse(await checkedCommand(prefix, ['inspect', containerId]))
  const item = items[0]
  assert.equal(item.Id, containerId, 'Owned container ID changed')
  assert.equal(item.Config.Labels['codex.owner'], owner, 'Owned container label changed')
  assert.equal(item.Config.Labels['powerevolve.dev/run'], runId, 'Owned container run identity changed')
  if (item.State.Running) await checkedCommand(prefix, ['stop', '--time', '10', containerId])
  const stopped = JSON.parse(await checkedCommand(prefix, ['inspect', containerId]))[0]
  assert.equal(stopped.State.Running, false, 'Owned installer did not stop')
  assert.equal(stopped.State.Pid, 0, 'Owned installer PID remains')
  report.containerState = stopped.State
  await checkedCommand(prefix, ['rm', containerId])
  report.containerRemoved = true
}

function installerArguments(prefix, paths, options, runId) {
  const npmArgs = ['ci', '--ignore-scripts', '--bin-links=false', '--omit=dev', '--no-audit', '--no-fund']
  if (options.mode === 'offline') npmArgs.push('--offline')
  const program = [
    "const {spawnSync}=require('node:child_process');",
    `if(process.platform!=='linux'||process.arch!==${JSON.stringify(options.arch)}||process.version!=='v22.23.2')`,
    "throw Error('wrong Linux runtime');",
    'console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version}));',
    `const result=spawnSync('npm',${JSON.stringify(npmArgs)},{stdio:'inherit'});`,
    'process.exitCode=result.status??1;',
  ].join('')
  return [...prefix, 'create', '--name', 'pe-office-ci-' + runId, '--label', 'codex.owner=' + owner,
    '--label', 'powerevolve.dev/run=' + runId, '--platform', options.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    '--user', `${process.getuid()}:${process.getgid()}`, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=536870912',
    '--network', options.mode === 'offline' ? 'none' : 'bridge',
    '--mount', `type=bind,source=${paths.closure},target=/closure`,
    '--mount', `type=bind,source=${paths.cache},target=/cache`, '--workdir', '/closure',
    '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/cache', platformBases[options.arch], 'node', '-e', program]
}

/**
 * Prepare a new CI-only closure and build context from the fixed npm inputs and an existing validator.
 * All output paths are caller-owned; a failure preserves its stage log and removes only its exact owned installer.
 * @param options - Validated parseOfficeCiArguments result.
 * @param signal - Optional caller termination; installer cleanup still verifies and removes only the owned ID.
 * @returns Actual assembler inventory and paths; never publishes an image or launches the application.
 */
export async function prepareOfficeCi(options, signal) {
  signal?.throwIfAborted()
  const { destination, validator } = await preflight(options)
  await mkdir(destination, { mode: 0o700 })
  const paths = { closure: join(destination, 'closure'), cache: join(destination, 'npm-cache'),
    context: join(destination, 'context') }
  const report = { sdkVersion: '0.1.1', base, installerBase: platformBases[options.arch], options, validator, paths, stage: 'inputs' }
  const save = () => writeFile(join(destination, 'reproduction.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const prefix = options['docker-context'] ? ['--context', options['docker-context']] : []
  const runId = randomUUID()
  const containerName = 'pe-office-ci-' + runId
  report.runId = runId; report.containerName = containerName
  let containerId, failure, createStarted = false
  try {
    await mkdir(paths.closure, { mode: 0o700 }); await mkdir(paths.context, { mode: 0o700 })
    if (options.mode === 'offline') await cp(options.cache, paths.cache, { recursive: true, force: false, errorOnExist: true })
    else await mkdir(paths.cache, { mode: 0o700 })
    for (const name of Object.keys(expected)) {
      await copyFile(join(inputRoot, name), join(paths.closure, name)); await chmod(join(paths.closure, name), 0o644)
      await physicalTree(join(paths.closure, name))
      assert.equal(hash(await readFile(join(paths.closure, name))), expected[name], 'Copied fixed SDK input changed')
    }
    signal?.throwIfAborted()
    report.stage = 'base-image'; await save()
    if (options.mode === 'online') {
      const pulled = await command([...prefix, 'pull', '--platform',
        options.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64', report.installerBase], 300_000, signal)
      report.basePull = { status: pulled.status, signal: pulled.signal, timedOut: pulled.timedOut }
      await writeFile(join(destination, 'base-pull.log'), pulled.output, { mode: 0o600 })
      assert.equal(pulled.status, 0, 'Pinned Node base pull failed')
    } else await checkedCommand(prefix, ['image', 'inspect', report.installerBase])
    signal?.throwIfAborted()
    report.stage = 'create'; await save()
    const createArgs = installerArguments(prefix, paths, options, runId)
    createStarted = true
    const created = await checkedCommand([], createArgs)
    assert.match(created, /^[a-f0-9]{64}$/u, 'Unexpected owned container ID')
    containerId = created
    report.containerId = containerId; report.createArgs = createArgs; report.stage = 'install'; await save()
    signal?.throwIfAborted()
    const installed = await command([...prefix, 'start', '--attach', containerId], 300_000, signal)
    report.install = { status: installed.status, signal: installed.signal, timedOut: installed.timedOut }
    await writeFile(join(destination, 'npm-ci.log'), installed.output, { mode: 0o600 })
    assert.equal(installed.status, 0, 'npm ci failed; stage and logs preserved')
    await cleanup(prefix, containerId, runId, report); containerId = undefined
    report.stage = 'physical'; await save()
    await physicalTree(paths.closure); await freeze(paths.closure)
    report.stage = 'assemble'; await save()
    const manifest = await assembleOfficePreview({ arch: options.arch, closureRoot: paths.closure,
      validatorModule: validator, destination: join(paths.context, 'runtime') })
    await copyFile('products/power-evolve/sandbox/Dockerfile.office-preview', join(paths.context, 'Dockerfile'))
    report.manifest = manifest; report.stage = 'complete'
  } catch (error) {
    failure = error; report.failureStage = report.stage; report.error = { name: error.name, message: error.message }
  } finally {
    if (!containerId && createStarted && !report.containerRemoved) {
      try { containerId = await recoverInstaller(prefix, containerName, runId, report) }
      catch (error) { report.cleanupError = { name: error.name, message: error.message }; failure ??= error }
    }
    if (containerId) {
      try { await cleanup(prefix, containerId, runId, report) }
      catch (error) { report.cleanupError = { name: error.name, message: error.message }; failure ??= error }
    }
    await save()
  }
  if (failure) throw failure
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const stop = () => controller.abort(new Error('Office CI interrupted'))
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    const report = await prepareOfficeCi(parseOfficeCiArguments(process.argv.slice(2)), controller.signal)
    console.log(JSON.stringify({ paths: report.paths, sdkVersion: report.manifest.sdkVersion,
      packages: report.manifest.packages.length, files: report.manifest.files.length }))
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
}
