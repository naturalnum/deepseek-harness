/** Real private files and Node child-close events; Office SDK/PDF parser behavior is substituted. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { officePreviewJobSchema, officePreviewResultSchema, officePreviewFailureSchema } from '../../contracts/src/office-preview.ts'
import { inspectOfficePreviewPdf, runOfficePreview } from '../office-preview.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const kitRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/libreoffice-kit/package.json'))
const { zipSync, unzipSync } = kitRequire('fflate')
const mathNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
const docx = properties => Buffer.from(zipSync({ 'word/document.xml': Buffer.from(`<w:document xmlns:w="urn:word" xmlns:m="${mathNamespace}"><w:body><m:d><m:dPr>${properties}</m:dPr><m:e/></m:d></w:body></w:document>`) }))
const pdf = Buffer.from('%PDF-1.7\nsynthetic parser fixture\n%%EOF\n')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, extension = 'docx') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-office-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputRoot = join(root, 'input'), outputRoot = join(root, 'output')
  await mkdir(inputRoot, { mode: 0o700 }); await mkdir(outputRoot, { mode: 0o700 })
  const source = extension === 'docx' ? docx('<m:grow m:val="1"/>')
    : Buffer.from('Synthetic Office input; not an actual engine conversion')
  const job = { protocolVersion: 1, jobId: randomUUID(), nonce: randomUUID(), generation: 'a'.repeat(64),
    sourceSha256: sha(source), sourceBytes: source.length, extension,
    limits: { inputBytes: 2097152, outputBytes: 8388608, timeoutMs: 1000, archiveEntries: 1000,
      uncompressedBytes: 33554432, fontLoadedBytes: 134217728, pages: 10, fontFiles: 1000,
      fontFileBytes: 134217728, fontResolutionEntries: 4096, imageResolution: 144 } }
  await writeFile(join(inputRoot, 'job.json'), JSON.stringify(job), { mode: 0o600 })
  await writeFile(join(inputRoot, `source.${extension}`), source, { mode: 0o600 })
  const calls = []
  const dependencies = { version: '0.1.1', jobSchema: officePreviewJobSchema, resultSchema: officePreviewResultSchema, failureSchema: officePreviewFailureSchema,
    createConverter: async options => {
      calls.push({ kind: 'create', options })
      return { backend: 'wasm', render: async (request, signal) => {
        calls.push({ kind: 'render', request, signal, source: await readFile(request.inputPath) })
        await writeFile(request.outputPath, pdf, { mode: 0o600 })
        return { backend: 'wasm', missingFonts: ['Declared Missing Font'] }
      }, dispose: async () => { calls.push({ kind: 'dispose' }) } }
    },
    spawnChild: (command, args, options) => {
      assert.equal(command, '/usr/bin/pdfinfo'); assert.equal(args[0], '-isodates')
      assert.equal(options.detached, true); assert.equal(options.cwd, '/')
      assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH'])
      calls.push({ kind: 'inspect' })
      return spawn(process.execPath, ['-e', 'process.stdout.write("Pages: 1\\n")'], options)
    } }
  return { root, inputRoot, outputRoot, job, source, calls, dependencies,
    saveJob: () => writeFile(join(inputRoot, 'job.json'), JSON.stringify(job)),
    run: signal => runOfficePreview({ inputRoot, outputRoot, dependencies, signal }) }
}
async function noResult(f, expectedFailure) {
  assert.deepEqual(await readdir(f.outputRoot), expectedFailure ? ['failure.json'] : [])
  if (expectedFailure) {
    const record = officePreviewFailureSchema.parse(JSON.parse(await readFile(join(f.outputRoot, 'failure.json'), 'utf8')))
    assert.deepEqual(record, { protocolVersion: 1, jobId: f.job.jobId, nonce: f.job.nonce,
      generation: f.job.generation, sourceSha256: f.job.sourceSha256, errorCode: expectedFailure })
    assert.equal((await lstat(join(f.outputRoot, 'failure.json'))).mode & 0o777, 0o600)
  }
}
const code = expected => error => error.code === expected && !error.message.includes('/var/')

test('all fixed Office extensions publish bound bytes only after dispose and PDF child close', async t => {
  for (const extension of ['doc', 'docx', 'ppt', 'pptx']) await t.test(extension, async t => {
    const f = await fixture(t, extension), result = await f.run()
    assert.deepEqual(result, { protocolVersion: 1, jobId: f.job.jobId, nonce: f.job.nonce,
      generation: f.job.generation, sourceSha256: f.job.sourceSha256, pdfSha256: sha(pdf), pdfBytes: pdf.length,
      pages: 1, missingFonts: ['Declared Missing Font'], backend: 'wasm' })
    assert.deepEqual(JSON.parse(await readFile(join(f.outputRoot, 'result.json'), 'utf8')), result)
    assert.deepEqual(await readFile(join(f.outputRoot, 'result.pdf')), pdf)
    assert.deepEqual(await readdir(f.outputRoot), ['result.json', 'result.pdf'])
    for (const name of ['result.json', 'result.pdf']) assert.equal((await lstat(join(f.outputRoot, name))).mode & 0o777, 0o600)
    assert.deepEqual(f.calls.map(call => call.kind), ['create', 'render', 'dispose', 'inspect'])
    assert.deepEqual(f.calls[1].source, f.source)
    assert.equal(f.calls[1].request.inputPath.startsWith(f.outputRoot), true)
    assert.deepEqual(f.calls[0].options, { timeoutMs: 1000, maxInputBytes: 2097152, maxOutputBytes: 8388608,
      maxArchiveEntries: 1000, maxUncompressedBytes: 33554432, maxLoadedFontBytes: 134217728,
      maxFontFiles: 1000, maxFontFileBytes: 134217728, maxFontResolutionEntries: 4096,
      maxImageResolution: 144, fontDirectories: ['/usr/share/fonts'], fontMetadataCacheDirectory: false })
  })
})

test('DOCX converter receives only the normalized private copy while the receipt binds original bytes', async t => {
  const f = await fixture(t), original = docx('<m:begChr m:val="|"/><m:endChr m:val="|"/><m:sepChr m:val=""/>')
  await writeFile(join(f.inputRoot, 'source.docx'), original)
  f.job.sourceSha256 = sha(original); f.job.sourceBytes = original.length; await f.saveJob()
  const result = await f.run(), rendered = f.calls.find(call => call.kind === 'render').source
  assert.notDeepEqual(rendered, original)
  assert.match(Buffer.from(unzipSync(rendered)['word/document.xml']).toString(), /<m:begChr m:val="\|"\/><m:sepChr m:val=""\/><m:endChr m:val="\|"\/>/u)
  assert.deepEqual(await readFile(join(f.inputRoot, 'source.docx')), original)
  assert.equal(result.sourceSha256, sha(original)); assert.equal(f.job.sourceBytes, original.length)
  assert.equal((await lstat(f.calls.find(call => call.kind === 'render').request.inputPath).catch(() => null)), null)
})

test('invalid DOCX and render-copy overflow never create a converter and publish only bound failure', async t => {
  for (const kind of ['xml', 'overflow']) await t.test(kind, async t => {
    const f = await fixture(t), original = kind === 'xml' ? Buffer.from(zipSync({ 'word/document.xml': Buffer.from('<broken>') }))
      : docx('<m:begChr m:val="{"/><m:endChr m:val=""/><m:sepChr m:val=""/>')
    await writeFile(join(f.inputRoot, 'source.docx'), original)
    f.job.sourceSha256 = sha(original); f.job.sourceBytes = original.length
    if (kind === 'overflow') f.job.limits.inputBytes = original.length
    await f.saveJob(); await assert.rejects(f.run(), code(kind === 'overflow' ? 'input-too-large' : 'invalid-document'))
    assert.deepEqual(f.calls, []); await noResult(f, kind === 'overflow' ? 'input-too-large' : 'invalid-document')
    assert.deepEqual(await readFile(join(f.inputRoot, 'source.docx')), original)
  })
})

test('a fulfilled render cannot publish while converter disposal is pending', async t => {
  const f = await fixture(t), disposing = deferred(), release = deferred()
  const original = f.dependencies.createConverter
  f.dependencies.createConverter = async options => {
    const converter = await original(options)
    converter.dispose = async () => { disposing.resolve(); await release.promise }
    return converter
  }
  const running = f.run(); await disposing.promise
  assert.equal(f.calls.some(call => call.kind === 'inspect'), false)
  assert.equal((await readdir(f.outputRoot)).some(name => name.startsWith('result.')), false)
  release.resolve(); await running
})

test('wrong source digest/size, symlinks, directories and FIFO never reach the SDK', async t => {
  for (const kind of ['digest', 'size', 'symlink', 'directory', 'fifo']) await t.test(kind, async t => {
    const f = await fixture(t), path = join(f.inputRoot, 'source.docx')
    if (kind === 'digest') f.job.sourceSha256 = 'b'.repeat(64)
    if (kind === 'size') f.job.sourceBytes++
    if (['symlink', 'directory', 'fifo'].includes(kind)) await rm(path)
    if (kind === 'symlink') await symlink(join(f.inputRoot, 'job.json'), path)
    if (kind === 'directory') await mkdir(path)
    if (kind === 'fifo') execFileSync('/usr/bin/mkfifo', [path])
    await f.saveJob(); await assert.rejects(f.run())
    assert.deepEqual(f.calls, []); await noResult(f, ['digest', 'size'].includes(kind) ? 'source-changed' : kind === 'symlink' ? 'failed' : 'invalid-document')
  })
})

test('the shared schema rejects extra command/path/image and invalid budgets', async t => {
  for (const patch of [{ command: 'ignored?' }, { path: '/outside' }, { image: 'other' }, { extension: 'xlsx' },
    { protocolVersion: 2 }, { limits: { inputBytes: 2097153 } }]) await t.test(JSON.stringify(patch), async t => {
    const f = await fixture(t)
    Object.assign(f.job, patch.limits ? { limits: { ...f.job.limits, ...patch.limits } } : patch)
    await f.saveJob(); await assert.rejects(f.run(), code('failed'))
    assert.deepEqual(f.calls, []); await noResult(f)
  })
})

test('cancellation waits for render join and disposal without publishing', async t => {
  const f = await fixture(t), entered = deferred(), abortSeen = deferred(), release = deferred()
  const controller = new AbortController(); let settled = false, disposed = false
  f.dependencies.createConverter = async () => ({ backend: 'wasm', render: async (_request, signal) => {
    entered.resolve(); await new Promise(done => signal.addEventListener('abort', done, { once: true }))
    abortSeen.resolve(); await release.promise; throw signal.reason
  }, dispose: async () => { disposed = true } })
  const running = f.run(controller.signal).finally(() => { settled = true })
  await entered.promise; controller.abort(); await abortSeen.promise
  assert.equal(settled, false); assert.equal(disposed, false)
  release.resolve(); await assert.rejects(running, code('cancelled'))
  assert.equal(disposed, true); await noResult(f)
})

test('deadline cancellation rejects even when the SDK traps abort and returns success', async t => {
  const f = await fixture(t); let disposed = false
  f.dependencies.createConverter = async () => ({ backend: 'wasm', render: async (_request, signal) => {
    await new Promise(done => signal.addEventListener('abort', done, { once: true }))
    return { backend: 'wasm', missingFonts: [] }
  }, dispose: async () => { disposed = true } })
  await assert.rejects(f.run(), code('timeout')); assert.equal(disposed, true); await noResult(f, 'timeout')
})

test('wrong SDK/native backend and failed disposal cannot publish success', async t => {
  for (const kind of ['version', 'native', 'render-native', 'dispose']) await t.test(kind, async t => {
    const f = await fixture(t), original = f.dependencies.createConverter
    if (kind === 'version') f.dependencies.version = '0.1.2'
    f.dependencies.createConverter = async options => {
      const converter = await original(options)
      if (kind === 'native') converter.backend = 'native'
      if (kind === 'render-native') converter.render = async () => ({ backend: 'native', missingFonts: [] })
      if (kind === 'dispose') converter.dispose = async () => { throw new Error('private path and credentials') }
      return converter
    }
    await assert.rejects(f.run(), code(kind === 'dispose' ? 'failed' : 'unavailable'));
    await noResult(f, ['version', 'dispose'].includes(kind) ? undefined : 'unavailable')
  })
})

test('invalid PDF bytes, output links/size, pages and font metadata reject', async t => {
  for (const kind of ['header', 'symlink', 'oversize', 'pages', 'fonts']) await t.test(kind, async t => {
    const f = await fixture(t), original = f.dependencies.createConverter
    if (kind === 'oversize') { f.job.limits.outputBytes = 8; await f.saveJob() }
    if (kind === 'pages') f.dependencies.spawnChild = (_command, _args, options) => spawn(process.execPath, ['-e', 'console.log("Pages: 11")'], options)
    f.dependencies.createConverter = async options => {
      const converter = await original(options), render = converter.render
      converter.render = async (request, signal) => {
        const result = await render(request, signal)
        if (kind === 'header') await writeFile(request.outputPath, 'not a PDF')
        if (kind === 'symlink') { await rm(request.outputPath); await symlink(request.inputPath, request.outputPath) }
        if (kind === 'fonts') result.missingFonts = ['bad\nfont']
        return result
      }
      return converter
    }
    await assert.rejects(f.run()); await noResult(f, kind === 'oversize' ? 'output-too-large' : ['symlink', 'fonts'].includes(kind) ? 'failed' : 'invalid-output')
  })
})

test('nonempty output directory preserves existing data and cannot overwrite a receipt', async t => {
  const f = await fixture(t)
  await writeFile(join(f.outputRoot, 'result.json'), 'prior')
  await assert.rejects(f.run(), code('unavailable'))
  assert.equal(await readFile(join(f.outputRoot, 'result.json'), 'utf8'), 'prior')
  assert.deepEqual(f.calls, [])
})

test('PDF inspection requires one valid page field and successful child close', async t => {
  for (const script of ['console.log("Pages: 0")', 'console.log("Pages: 1\\nPages: 1")',
    'console.log("Pages: 1");process.exitCode=2', 'console.log("private error only")']) await t.test(script, async () => {
    const controller = new AbortController()
    await assert.rejects(inspectOfficePreviewPdf('/private.pdf', controller.signal,
      (_command, _args, options) => spawn(process.execPath, ['-e', script], options)), code('invalid-output'))
  })
})

test('PDF output overflow and cancellation kill only their owned group and await close', async t => {
  for (const kind of ['overflow', 'cancel']) await t.test(kind, async () => {
    const controller = new AbortController(), ready = deferred(); let child, closed = false
    const inspect = inspectOfficePreviewPdf('/private.pdf', controller.signal, (_command, _args, options) => {
      const script = 'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),80));process.stdout.write("ready\\n");setInterval(()=>{},1000);'
        + (kind === 'overflow' ? 'setTimeout(()=>process.stdout.write("x".repeat(17000)),30);' : '')
      child = spawn(process.execPath, ['-e', script], options)
      child.stdout.once('data', () => ready.resolve())
      child.once('close', () => { closed = true })
      return child
    })
    await ready.promise
    if (kind === 'cancel') controller.abort()
    assert.equal(closed, false)
    await assert.rejects(inspect, code(kind === 'cancel' ? 'cancelled' : 'invalid-output'))
    assert.equal(closed, true)
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH')
  })
})

test('production entry rejects all caller path/command arguments before loading resources', () => {
  const path = fileURLToPath(new URL('../office-preview.mjs', import.meta.url))
  assert.throws(() => execFileSync(process.execPath, [path, '--command', '/outside'], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
  }), error => error.status === 1 && error.stdout.length === 0
    && error.stderr.toString() === '{"protocolVersion":1,"errorCode":"unavailable"}\n')
})

test('failure marker preserves all shared reasons without diagnostics and waits for disposal', async t => {
  for (const errorCode of ['input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format',
    'invalid-output', 'timeout', 'unavailable', 'failed', 'busy', 'source-changed']) await t.test(errorCode, async t => {
    const f = await fixture(t), disposing = deferred(), release = deferred()
    f.dependencies.createConverter = async () => ({ backend: 'wasm', render: async () => {
      throw Object.assign(new Error('private path /private/source; raw Office bytes; credential'), { code: errorCode })
    }, dispose: async () => { disposing.resolve(); await release.promise } })
    const running = f.run(); await disposing.promise
    assert.equal((await readdir(f.outputRoot)).includes('failure.json'), false)
    release.resolve(); await assert.rejects(running, code(errorCode)); await noResult(f, errorCode)
    assert.equal((await readFile(join(f.outputRoot, 'failure.json'), 'utf8')).includes('private'), false)
  })
})

test('caller cancellation during cleanup suppresses a failure marker', async t => {
  const f = await fixture(t), disposing = deferred(), release = deferred(), controller = new AbortController()
  f.dependencies.createConverter = async () => ({ backend: 'wasm', render: async () => { throw Object.assign(new Error('invalid'), { code: 'invalid-document' }) },
    dispose: async () => { disposing.resolve(); await release.promise } })
  const running = f.run(controller.signal); await disposing.promise; controller.abort(); release.resolve()
  await assert.rejects(running, code('invalid-document')); await noResult(f)
})

test('failure validation cannot publish success or leave staged output', async t => {
  const f = await fixture(t)
  f.dependencies.createConverter = async () => ({ backend: 'wasm', render: async () => {
    throw Object.assign(new Error('invalid'), { code: 'invalid-document' })
  }, dispose: async () => {} })
  f.dependencies.failureSchema = { parse: () => { throw new Error('private validation diagnostic') } }
  await assert.rejects(f.run(), code('failed')); await noResult(f)
})
