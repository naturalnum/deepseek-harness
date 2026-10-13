/** Tiny physical package fixtures exercise copying and hash rejection, not the real WASM engine. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import test from 'node:test'
import { assembleOfficePreview } from '../scripts/assemble-office-preview.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pe-office-closure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const closureRoot = join(root, 'closure'), destination = join(root, 'assembled')
  const kit = join(closureRoot, 'node_modules/@deepseek-ai/libreoffice-kit')
  const wasm = join(closureRoot, 'node_modules/@deepseek-ai/libreoffice-kit-wasm')
  const dependency = join(closureRoot, 'node_modules/fflate')
  await mkdir(kit, { recursive: true }); await mkdir(join(wasm, 'assets'), { recursive: true }); await mkdir(dependency)
  const kitManifest = { name: '@deepseek-ai/libreoffice-kit', version: '0.1.1', type: 'module',
    exports: { '.': './index.js', './package.json': './package.json' }, dependencies: { fflate: '0.8.2' },
    optionalDependencies: { '@deepseek-ai/libreoffice-kit-wasm': '0.1.1', '@deepseek-ai/libreoffice-kit-darwin-arm64': '0.1.1' } }
  await writeFile(join(kit, 'package.json'), JSON.stringify(kitManifest))
  await writeFile(join(kit, 'worker.js'), 'physical worker fixture')
  await writeFile(join(kit, 'index.js'), 'export const ENGINE_VERSION="0.1.1";export const createConverter=()=>{};export const discoverRuntime=async()=>({version:"0.1.1",backend:"wasm"})\n')
  await writeFile(join(wasm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.1' }))
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fflate', version: '0.8.2' }))
  await writeFile(join(dependency, 'index.js'), 'physical dependency fixture')
  const assets = { loader: 'assets/loader.cjs', wasm: 'assets/engine.wasm', data: 'assets/engine.data', metadata: 'assets/engine.metadata' }
  const files = {}
  for (const path of Object.values(assets)) {
    const bytes = Buffer.from(`tiny fixture ${path}`)
    await writeFile(join(wasm, path), bytes); files[path] = sha(bytes)
  }
  const prebuilds = { schemaVersion: 1, version: '0.1.1', platform: 'wasm', status: 'built',
    engine: { kind: 'wasm', ...assets, programDirectory: '/instdir/program' }, files }
  await writeFile(join(wasm, 'prebuilds.json'), JSON.stringify(prebuilds))
  const validatorModule = join(root, 'shared-validator.mjs')
  await writeFile(validatorModule, 'export const officePreviewJobSchema={parse(){throw Error("fixture only")}};export const officePreviewResultSchema=officePreviewJobSchema;export const officePreviewFailureSchema=officePreviewJobSchema\n')
  return { root, closureRoot, destination, kit, wasm, dependency, validatorModule, kitManifest, prebuilds,
    run: () => assembleOfficePreview({ closureRoot, destination, arch: 'arm64', validatorModule }) }
}

test('offline assembly preserves Linux package resolution and every copied byte', async (t) => {
  const f = await fixture(t), result = await f.run()
  assert.deepEqual(result.target, { platform: 'linux', arch: 'arm64' })
  assert.equal(result.backend, 'wasm'); assert.equal(result.sdkVersion, '0.1.1')
  assert.deepEqual(result.packages.map(pkg => pkg.name).sort(), ['@deepseek-ai/libreoffice-kit', '@deepseek-ai/libreoffice-kit-wasm', 'fflate'])
  assert.deepEqual(JSON.parse(await readFile(join(f.destination, 'office-preview-closure.json'), 'utf8')), result)
  for (const file of result.files) {
    const bytes = await readFile(join(f.destination, file.path))
    assert.equal(bytes.length, file.bytes); assert.equal(sha(bytes), file.sha256)
  }
  assert.equal(await readFile(join(f.destination, 'office-preview-contract.mjs'), 'utf8'), await readFile(f.validatorModule, 'utf8'))
  assert.equal(await readFile(join(f.destination, 'office-preview-docx.mjs'), 'utf8'),
    await readFile(new URL('../office-preview-docx.mjs', import.meta.url), 'utf8'))
  assert.equal(await readFile(join(f.destination, 'node_modules/@deepseek-ai/libreoffice-kit/worker.js'), 'utf8'), 'physical worker fixture')
  await writeFile(join(f.kit, 'worker.js'), 'changed input after assembly')
  assert.equal(await readFile(join(f.destination, 'node_modules/@deepseek-ai/libreoffice-kit/worker.js'), 'utf8'), 'physical worker fixture')
})

test('assembled DOCX render-copy module resolves actual codecs through nested kit dependencies', async (t) => {
  const f = await fixture(t)
  const kitRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/libreoffice-kit/package.json'))
  const nested = join(f.kit, 'node_modules')
  await mkdir(nested)
  for (const name of ['fflate', 'saxes', 'xmlchars']) {
    const owner = name === 'xmlchars' ? createRequire(kitRequire.resolve('saxes')) : kitRequire
    const resolved = owner.resolve(name)
    const root = name === 'fflate' ? dirname(dirname(resolved)) : dirname(resolved)
    await cp(root, join(nested, name), { recursive: true })
  }
  f.kitManifest.dependencies = { fflate: '0.8.2', saxes: '6.0.0' }
  await writeFile(join(f.kit, 'package.json'), JSON.stringify(f.kitManifest))
  await f.run()
  assert.equal((await readdir(join(f.destination, 'node_modules'))).includes('fflate'), false)
  const copied = await import(pathToFileURL(join(f.destination, 'office-preview-docx.mjs')))
  const { zipSync, unzipSync } = kitRequire('fflate')
  const source = Buffer.from(zipSync({ 'word/document.xml': Buffer.from('<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/><m:sepChr m:val=""/></m:dPr><m:e/></m:d></m:oMath>') }))
  const before = Buffer.from(source)
  const copy = copied.prepareOfficePreviewDocx(source,
    { inputBytes: 2097152, archiveEntries: 100, uncompressedBytes: 33554432, timeoutMs: 1000 }, new AbortController().signal)
  assert.deepEqual(source, before)
  assert.match(Buffer.from(unzipSync(copy)['word/document.xml']).toString(), /<m:begChr m:val="\{"\/><m:sepChr m:val=""\/><m:endChr m:val=""\/>/u)
})

test('private caller umask preserves copied modes and readable generated resources', async (t) => {
  const f = await fixture(t), previous = process.umask(0o077)
  let result
  try { result = await f.run() }
  finally { process.umask(previous) }
  for (const file of result.files) assert.equal((await lstat(join(f.destination, file.path))).mode & 0o777, file.mode)
  for (const path of ['', 'node_modules', 'node_modules/@deepseek-ai',
    'node_modules/@deepseek-ai/libreoffice-kit-wasm/assets']) {
    assert.equal((await lstat(join(f.destination, path))).mode & 0o777, 0o755)
  }
  assert.equal((await lstat(join(f.destination, 'office-preview-closure.json'))).mode & 0o777, 0o644)
})

test('missing WASM/dependency and wrong package or native engine cannot assemble', async (t) => {
  for (const kind of ['wasm-missing', 'dependency', 'kit-version', 'wasm-version', 'native']) await t.test(kind, async (t) => {
    const f = await fixture(t)
    if (kind === 'wasm-missing') await rm(f.wasm, { recursive: true })
    if (kind === 'dependency') await rm(f.dependency, { recursive: true })
    if (kind === 'kit-version') { f.kitManifest.version = '0.1.2'; await writeFile(join(f.kit, 'package.json'), JSON.stringify(f.kitManifest)) }
    if (kind === 'wasm-version') await writeFile(join(f.wasm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.2' }))
    if (kind === 'native') {
      f.kitManifest.optionalDependencies['@deepseek-ai/libreoffice-kit-linux-arm64'] = '0.1.1'
      await writeFile(join(f.kit, 'package.json'), JSON.stringify(f.kitManifest))
    }
    await assert.rejects(f.run())
    assert.equal((await readdir(f.root)).includes('assembled'), false)
  })
})

test('WASM missing/tampered assets and traversal declarations fail before destination creation', async (t) => {
  for (const kind of ['missing', 'digest', 'traversal', 'undeclared']) await t.test(kind, async (t) => {
    const f = await fixture(t)
    if (kind === 'missing') await rm(join(f.wasm, 'assets/engine.wasm'))
    if (kind === 'digest') await writeFile(join(f.wasm, 'assets/engine.wasm'), 'changed')
    if (kind === 'traversal') f.prebuilds.files['../outside'] = 'a'.repeat(64)
    if (kind === 'undeclared') delete f.prebuilds.files[f.prebuilds.engine.loader]
    await writeFile(join(f.wasm, 'prebuilds.json'), JSON.stringify(f.prebuilds))
    await assert.rejects(f.run()); assert.equal((await readdir(f.root)).includes('assembled'), false)
  })
})

test('incompatible WASM distribution manifests reject before any output allocation', async (t) => {
  const cases = [
    ['schema-version', { schemaVersion: 2 }],
    ['engine-version', { version: '0.1.2' }],
    ['native-platform', { platform: 'linux' }],
    ['unfinished-build', { status: 'pending' }],
    ['native-engine', { engine: { kind: 'native' } }],
    ['program-directory', { engine: { kind: 'wasm', programDirectory: '/other/program' } }],
    ['missing-file-table', { files: null }],
    ['scalar-file-table', { files: 'invalid' }],
    ['array-file-table', { files: [] }],
  ]
  for (const [name, patch] of cases) await t.test(name, async (t) => {
    const f = await fixture(t)
    await writeFile(join(f.wasm, 'prebuilds.json'), JSON.stringify({ ...f.prebuilds, ...patch }))
    await assert.rejects(f.run(), /Office WASM manifest is incompatible/u)
    assert.equal((await readdir(f.root)).includes('assembled'), false)
  })
})

test('physical closure and validation asset reject aliases', async (t) => {
  for (const kind of ['resource', 'dependency-directory', 'validator']) await t.test(kind, async (t) => {
    const f = await fixture(t)
    if (kind === 'resource') await symlink(f.validatorModule, join(f.kit, 'aliased'))
    if (kind === 'dependency-directory') { await rm(f.dependency, { recursive: true }); await symlink(f.kit, f.dependency) }
    if (kind === 'validator') { const alias = join(f.root, 'validator-alias'); await symlink(f.validatorModule, alias); f.validatorModule = alias }
    await assert.rejects(assembleOfficePreview({ closureRoot: f.closureRoot, destination: f.destination, arch: 'arm64', validatorModule: f.validatorModule }))
    assert.equal((await readdir(f.root)).includes('assembled'), false)
  })
})

test('existing destination is preserved and overlapping sources are rejected', async (t) => {
  const f = await fixture(t)
  await mkdir(f.destination); await writeFile(join(f.destination, 'keep'), 'old')
  await assert.rejects(f.run())
  assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'old')
  await assert.rejects(assembleOfficePreview({ closureRoot: f.closureRoot, destination: join(f.closureRoot, 'nested'), arch: 'arm64', validatorModule: f.validatorModule }))
  assert.equal((await readdir(f.closureRoot)).includes('nested'), false)
})

test('copied process loader enforces actual package/runtime versions and shared validator exports', async (t) => {
  for (const kind of ['valid', 'kit-version', 'wasm-version', 'runtime-version', 'native', 'validator']) await t.test(kind, async (t) => {
    const f = await fixture(t)
    await f.run()
    const kit = join(f.destination, 'node_modules/@deepseek-ai/libreoffice-kit')
    if (kind === 'kit-version') await writeFile(join(kit, 'package.json'), JSON.stringify({ ...f.kitManifest, version: '0.1.2' }))
    if (kind === 'wasm-version') await writeFile(join(f.destination, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.2' }))
    if (kind === 'runtime-version' || kind === 'native') await writeFile(join(kit, 'index.js'), `export const ENGINE_VERSION="0.1.1";export const discoverRuntime=async()=>({version:"${kind === 'runtime-version' ? '0.1.2' : '0.1.1'}",backend:"${kind === 'native' ? 'native' : 'wasm'}"})`)
    if (kind === 'validator') await writeFile(join(f.destination, 'office-preview-contract.mjs'), 'export const wrong=1')
    const copied = await import(pathToFileURL(join(f.destination, 'office-preview.mjs')))
    if (kind === 'valid') {
      const dependencies = await copied.loadOfficePreviewDependencies()
      assert.equal(dependencies.version, '0.1.1')
      assert.equal(typeof dependencies.jobSchema.parse, 'function')
      assert.equal(typeof dependencies.resultSchema.parse, 'function')
      assert.equal(typeof dependencies.failureSchema.parse, 'function')
    } else await assert.rejects(copied.loadOfficePreviewDependencies(), error => error.code === 'unavailable' && !error.message.includes(f.root))
  })
})

test('unsupported architecture and physical root aliases reject without a destination', async (t) => {
  const f = await fixture(t)
  await assert.rejects(assembleOfficePreview({ closureRoot: f.closureRoot, destination: f.destination,
    arch: 'ppc64', validatorModule: f.validatorModule }))
  const alias = join(f.root, 'closure-alias'); await symlink(f.closureRoot, alias)
  await assert.rejects(assembleOfficePreview({ closureRoot: alias, destination: f.destination,
    arch: 'arm64', validatorModule: f.validatorModule }))
  await assert.rejects(assembleOfficePreview({ closureRoot: f.validatorModule, destination: f.destination,
    arch: 'arm64', validatorModule: f.validatorModule }))
  assert.equal((await readdir(f.root)).includes('assembled'), false)
})

test('WASM loader references must name declared physical assets', async (t) => {
  for (const loader of [1, 'assets/undeclared.cjs']) {
    const f = await fixture(t)
    f.prebuilds.engine.loader = loader
    await writeFile(join(f.wasm, 'prebuilds.json'), JSON.stringify(f.prebuilds))
    await assert.rejects(f.run(), /Office WASM asset is undeclared/u)
    assert.equal((await readdir(f.root)).includes('assembled'), false)
  }
})

test('a physical FIFO in the closure rejects without opening it or allocating output', async (t) => {
  const f = await fixture(t)
  execFileSync('mkfifo', [join(f.kit, 'unsafe-resource')])
  await assert.rejects(f.run(), /nonregular resource/u)
  assert.equal((await readdir(f.root)).includes('assembled'), false)
})

test('a validator changed after inventory cannot publish an assembled directory', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 64; index++) await writeFile(join(f.kit, `resource-${index}`), Buffer.alloc(4096, index))
  const worker = new Worker(`
    const { existsSync, writeFileSync } = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    parentPort.postMessage('ready');
    const deadline = Date.now() + 5000;
    while (!existsSync(workerData.destination) && Date.now() < deadline) {}
    if (!existsSync(workerData.destination)) throw Error('Owned destination not observed');
    writeFileSync(workerData.validator, 'export const validatorChangedAfterInventory=true\\n');
    parentPort.postMessage('changed');
  `, { eval: true, workerData: { destination: f.destination, validator: f.validatorModule } })
  t.after(() => worker.terminate())
  const messages = [], ready = new Promise((resolve, reject) => {
    worker.on('message', (message) => { messages.push(message); if (message === 'ready') resolve() })
    worker.once('error', reject)
  })
  await ready
  await assert.rejects(f.run(), /copied resource changed/u)
  assert.equal(messages.includes('changed'), true)
  assert.equal((await readdir(f.root)).includes('assembled'), false)
  assert.equal(await readFile(f.validatorModule, 'utf8'), 'export const validatorChangedAfterInventory=true\n')
})
