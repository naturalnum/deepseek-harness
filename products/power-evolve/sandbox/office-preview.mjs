/** One credential-free Office parser task; result.json commits data only after conversion and join. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fsyncSync, linkSync, openSync, unlinkSync } from 'node:fs'
import { chmod, link, lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_VERSION = '0.1.1'
const JOB_JSON_BYTES = 65536
const PDFINFO_OUTPUT_BYTES = 16384
const PDFINFO_KILL_GRACE_MS = 300
const fontDirectories = Object.freeze(['/usr/share/fonts'])
const errorCodes = new Set(['input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format',
  'invalid-output', 'timeout', 'unavailable', 'failed', 'source-changed', 'cancelled'])
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function failure(code) {
  return Object.assign(new Error(`Office preview ${code}`), { code })
}

function checkedError(error) {
  return failure(errorCodes.has(error?.code) ? error.code : 'failed')
}

function checkCancellation(signal) {
  if (signal?.aborted) throw failure(signal.reason?.code === 'timeout' ? 'timeout' : 'cancelled')
}

async function regularBytes(path, maximum, exceededCode) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n) throw failure('invalid-document')
    if (before.size > BigInt(maximum)) throw failure(exceededCode)
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || offset !== Number(before.size)) {
      throw failure('source-changed')
    }
    if (offset > maximum) throw failure(exceededCode)
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}

async function privateWrite(path, bytes) {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() }
  finally { await handle.close() }
}

/**
 * Inspect only the isolated parser's private PDF with fixed Poppler arguments and scrubbed environment.
 * Abort, deadline and output overflow terminate the owned process group and await child close.
 * @param {string} path - Parser-owned PDF snapshot.
 * @param {AbortSignal} signal - Task cancellation and deadline.
 * @param {Function} spawnChild - Child process provider; production uses Node spawn.
 * @returns {Promise<number>} Positive page count; rejects malformed or unsuccessful output.
 */
export async function inspectOfficePreviewPdf(path, signal, spawnChild = spawn) {
  checkCancellation(signal)
  const child = spawnChild('/usr/bin/pdfinfo', ['-isodates', path], { cwd: '/', detached: true,
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let bytes = 0, failed = false, killTimer, spawnError
  const chunks = []
  const kill = name => {
    if (child.pid) {
      try { process.kill(-child.pid, name) }
      catch (error) { if (error.code !== 'ESRCH') { failed = true; spawnError = error } }
    }
  }
  const stop = () => {
    failed = true
    kill('SIGTERM')
    killTimer ??= setTimeout(() => kill('SIGKILL'), PDFINFO_KILL_GRACE_MS)
  }
  const collect = (chunk, stdout) => {
    bytes += chunk.byteLength
    if (bytes > PDFINFO_OUTPUT_BYTES) stop()
    else if (stdout) chunks.push(chunk)
  }
  child.stdout.on('data', chunk => collect(chunk, true))
  child.stderr.on('data', chunk => collect(chunk, false))
  child.once('error', error => { spawnError = error; failed = true })
  const closed = new Promise(resolveClosed => child.once('close', (code, childSignal) => resolveClosed({ code, childSignal })))
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  try {
    const result = await closed
    checkCancellation(signal)
    if (spawnError || failed || result.code !== 0 || result.childSignal) throw failure('invalid-output')
    const matches = Buffer.concat(chunks).toString('utf8').match(/^Pages:\s+([1-9][0-9]*)\s*$/gmu)
    if (matches?.length !== 1) throw failure('invalid-output')
    const pages = Number(matches[0].match(/[0-9]+/u)[0])
    if (!Number.isSafeInteger(pages)) throw failure('invalid-output')
    return pages
  } finally {
    clearTimeout(killTimer)
    signal.removeEventListener('abort', stop)
  }
}

/**
 * Load the copied shared validator and exact installed 0.1.1 Linux WASM SDK.
 * @returns {Promise<object>} Validated parser dependencies; no runtime downloads or native fallback.
 */
export async function loadOfficePreviewDependencies() {
  try {
    const require = createRequire(import.meta.url)
    const kit = JSON.parse((await regularBytes(require.resolve('@deepseek-ai/libreoffice-kit/package.json'), JOB_JSON_BYTES, 'unavailable')).toString('utf8'))
    const wasm = JSON.parse((await regularBytes(require.resolve('@deepseek-ai/libreoffice-kit-wasm/package.json'), JOB_JSON_BYTES, 'unavailable')).toString('utf8'))
    if (kit.name !== '@deepseek-ai/libreoffice-kit' || kit.version !== SDK_VERSION
      || wasm.name !== '@deepseek-ai/libreoffice-kit-wasm' || wasm.version !== SDK_VERSION) throw failure('unavailable')
    const [sdk, validators] = await Promise.all([import('@deepseek-ai/libreoffice-kit'), import('./office-preview-contract.mjs')])
    const runtime = await sdk.discoverRuntime()
    if (sdk.ENGINE_VERSION !== SDK_VERSION || runtime.version !== SDK_VERSION || runtime.backend !== 'wasm'
      || typeof validators.officePreviewJobSchema?.parse !== 'function'
      || typeof validators.officePreviewResultSchema?.parse !== 'function') throw failure('unavailable')
    return { version: SDK_VERSION, createConverter: sdk.createConverter,
      jobSchema: validators.officePreviewJobSchema, resultSchema: validators.officePreviewResultSchema }
  } catch (_unavailableRuntime) { throw failure('unavailable') }
}

/**
 * Convert one immutable task in caller-owned private directories. Production fixes /input and /output.
 * SDK and validation providers permit isolated component fixtures; JSON never selects paths, commands or images.
 * The output directory must be an empty physical private directory without other writers.
 * Publication links result.pdf then result.json exclusively in one synchronous commit; successful marker is not Pod-stop evidence.
 * @param {{ inputRoot: string, outputRoot: string, dependencies: object, signal?: AbortSignal }} input - Trusted process resources.
 * @returns {Promise<object>} Shared validated result; failure leaves no new success marker and awaits disposal.
 */
export async function runOfficePreview(input) {
  const { dependencies } = input
  let scratch, converter, timer, stagedPdf, stagedMarker, publishedPdf = false, publishedMarker = false, committed = false
  const controller = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
  const outputRoot = resolve(input.outputRoot)
  try {
    checkCancellation(signal)
    if (dependencies.version !== SDK_VERSION) throw failure('unavailable')
    const inputStatus = await lstat(input.inputRoot)
    const outputStatus = await lstat(outputRoot)
    if (!inputStatus.isDirectory() || !outputStatus.isDirectory() || (outputStatus.mode & 0o077) !== 0
      || (await readdir(outputRoot)).length !== 0) throw failure('unavailable')
    const rawJob = await regularBytes(join(input.inputRoot, 'job.json'), JOB_JSON_BYTES, 'invalid-document')
    const job = dependencies.jobSchema.parse(JSON.parse(rawJob.toString('utf8')))
    timer = setTimeout(() => controller.abort(failure('timeout')), job.limits.timeoutMs)
    const source = await regularBytes(join(input.inputRoot, `source.${job.extension}`), job.limits.inputBytes, 'input-too-large')
    checkCancellation(signal)
    if (source.byteLength !== job.sourceBytes || digest(source) !== job.sourceSha256) throw failure('source-changed')
    if (source.byteLength === 0) throw failure('invalid-document')
    scratch = await mkdtemp(join(outputRoot, '.office-preview-'))
    await chmod(scratch, 0o700)
    const sourcePath = join(scratch, `source.${job.extension}`)
    const pdfPath = join(scratch, 'result.pdf')
    await privateWrite(sourcePath, source)
    checkCancellation(signal)
    converter = await dependencies.createConverter({ timeoutMs: job.limits.timeoutMs,
      maxInputBytes: job.limits.inputBytes, maxOutputBytes: job.limits.outputBytes,
      maxArchiveEntries: job.limits.archiveEntries, maxUncompressedBytes: job.limits.uncompressedBytes,
      maxLoadedFontBytes: job.limits.fontLoadedBytes, maxFontFiles: job.limits.fontFiles,
      maxFontFileBytes: job.limits.fontFileBytes, maxFontResolutionEntries: job.limits.fontResolutionEntries,
      maxImageResolution: job.limits.imageResolution, fontDirectories: [...fontDirectories], fontMetadataCacheDirectory: false })
    checkCancellation(signal)
    if (converter.backend !== 'wasm') throw failure('unavailable')
    const rendered = await converter.render({ inputPath: sourcePath, outputPath: pdfPath }, signal)
    checkCancellation(signal)
    await converter.dispose()
    converter = undefined
    checkCancellation(signal)
    if (rendered.backend !== 'wasm') throw failure('unavailable')
    const pdf = await regularBytes(pdfPath, job.limits.outputBytes, 'output-too-large')
    if (pdf.byteLength < 8 || !pdf.subarray(0, 8).toString('ascii').startsWith('%PDF-')) throw failure('invalid-output')
    const snapshotPath = join(scratch, 'verified.pdf')
    await privateWrite(snapshotPath, pdf)
    const pages = await inspectOfficePreviewPdf(snapshotPath, signal, dependencies.spawnChild ?? spawn)
    if (pages > job.limits.pages) throw failure('invalid-output')
    const result = dependencies.resultSchema.parse({ protocolVersion: 1, jobId: job.jobId, nonce: job.nonce,
      generation: job.generation, sourceSha256: job.sourceSha256, pdfSha256: digest(pdf), pdfBytes: pdf.byteLength,
      pages, missingFonts: rendered.missingFonts, backend: 'wasm' })
    const markerPath = join(scratch, 'result.json')
    await privateWrite(markerPath, JSON.stringify(result) + '\n')
    const pdfStage = join(outputRoot, `.office-pdf-${job.nonce}`)
    const markerStage = join(outputRoot, `.office-result-${job.nonce}`)
    await link(snapshotPath, pdfStage)
    stagedPdf = pdfStage
    await link(markerPath, markerStage)
    stagedMarker = markerStage
    await rm(scratch, { recursive: true })
    scratch = undefined
    checkCancellation(signal)
    // No signal callback runs between the final cancellation check and this exclusive commit.
    const directory = openSync(outputRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      linkSync(stagedPdf, join(outputRoot, 'result.pdf'))
      publishedPdf = true
      linkSync(stagedMarker, join(outputRoot, 'result.json'))
      publishedMarker = true
      unlinkSync(stagedPdf)
      stagedPdf = undefined
      unlinkSync(stagedMarker)
      stagedMarker = undefined
      fsyncSync(directory)
    } catch (error) {
      if (publishedMarker) { unlinkSync(join(outputRoot, 'result.json')); publishedMarker = false }
      if (publishedPdf) { unlinkSync(join(outputRoot, 'result.pdf')); publishedPdf = false }
      fsyncSync(directory)
      throw error
    } finally { closeSync(directory) }
    committed = true
    return result
  } catch (error) {
    checkCancellation(signal)
    throw checkedError(error)
  } finally {
    clearTimeout(timer)
    const errors = []
    if (converter) {
      try { await converter.dispose() }
      catch (error) { errors.push(error) }
    }
    if (scratch) {
      try { await rm(scratch, { recursive: true }) }
      catch (error) { errors.push(error) }
    }
    for (const path of [stagedMarker, stagedPdf, ...(!committed ? [publishedMarker && join(outputRoot, 'result.json'),
      publishedPdf && join(outputRoot, 'result.pdf')] : [])].filter(Boolean)) {
      try { await rm(path) }
      catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw failure('failed')
  }
}

async function main() {
  const controller = new AbortController()
  const stop = () => controller.abort(failure('cancelled'))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    if (process.argv.length !== 2) throw failure('unavailable')
    const dependencies = await loadOfficePreviewDependencies()
    await runOfficePreview({ inputRoot: '/input', outputRoot: '/output', dependencies, signal: controller.signal })
    process.stdout.write('{"protocolVersion":1,"status":"succeeded"}\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ protocolVersion: 1, errorCode: checkedError(error).code }) + '\n')
    process.exitCode = 1
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
