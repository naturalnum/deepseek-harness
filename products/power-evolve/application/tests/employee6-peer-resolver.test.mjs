/** Fresh official resolver processes over actual protocol source and product consumer manifests. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import { collectRuntimeSourceExportUses } from '../../../../scripts/verify-package-dependencies.ts'
import { inventory } from '../../scripts/cloud-policy.mjs'
import { cloudProtocolManifestErrors, cloudProtocolResolutionErrors } from '../../scripts/cloud-peer-policy.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const require = createRequire(import.meta.url)
const scenario = process.argv[2]
const scenarios = ['shared', 'shared-platform', 'missing-provider', 'missing-peer', 'missing-linked-root', 'nested-private-helper',
  'nested-peer-helper', 'private-zod', 'version-conflict']
const manifest = owner => JSON.parse(readFileSync(resolve(root, 'products/power-evolve', owner, 'package.json'), 'utf8'))
const put = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n')
}
const link = (target, file) => {
  mkdirSync(dirname(file), { recursive: true })
  symlinkSync(target, file, 'dir')
}
const transpile = (source, file) => ts.transpileModule(source, { fileName: file, compilerOptions: {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText

async function runScenario(folder) {
  const { installRuntimeInterception } = await import(pathToFileURL(resolve(root,
    'packages/boot/app-boot/src/profile-resolution/resolver.ts')).href)
  const snapshots = new Map()
  const source = (file) => {
    const value = readFileSync(resolve(root, file), 'utf8')
    snapshots.set(file, value)
    return value
  }
  const positive = ['shared', 'shared-platform', 'nested-peer-helper'].includes(scenario)
  for (const owner of ['contracts', 'application', 'connector-runner', 'host', 'platform']) {
    source('products/power-evolve/' + owner + '/package.json')
  }
  const protocol = manifest('contracts')
  const leaves = Object.keys(protocol.exports).filter(key => key !== './package.json')
  const specifiers = leaves.map(leaf => protocol.name + leaf.slice(1))
  const zodManifest = realpathSync(require.resolve('zod/package.json'))
  const zodSource = dirname(zodManifest)
  const sharedZod = join(folder, 'shared-zod')
  const privateZod = join(folder, 'private-zod')
  cpSync(zodSource, sharedZod, { recursive: true })
  cpSync(zodSource, privateZod, { recursive: true })
  for (const dir of [sharedZod, privateZod]) {
    const entry = join(dir, 'index.js')
    put(entry, readFileSync(entry, 'utf8') + '\nexport const __employee6ESMUrl = import.meta.url;\n')
  }
  const zodVersion = JSON.parse(readFileSync(zodManifest, 'utf8')).version
  assert.equal(zodVersion, '4.4.3', 'Refresh the pinned provider deliberately if the installed Zod changes')
  const brand = join(folder, 'brand')
  put(join(brand, 'package.json'), { name: '@deepseek-ai/dsh-brand', type: 'module', exports: './index.js' })
  put(join(brand, 'index.js'), transpile(source('packages/util/brand/src/index.ts'), 'index.ts'))
  const makeProtocol = (label) => {
    const dir = join(folder, label)
    put(join(dir, 'package.json'), protocol)
    for (const leaf of leaves) {
      const file = 'products/power-evolve/contracts/src/' + leaf.slice(2) + '.ts'
      const target = protocol.exports[leaf].default
      put(resolve(dir, target), transpile(source(file), file)
        + '\nexport const __employee6ESMUrl = import.meta.url;\n')
    }
    link(scenario === 'private-zod' && label === 'provider' ? privateZod : sharedZod, join(dir, 'node_modules/zod'))
    link(brand, join(dir, 'node_modules/@deepseek-ai/dsh-brand'))
    return dir
  }
  const provider = makeProtocol('provider'), privateProtocol = makeProtocol('private-protocol')
  const roots = new Map(), consumers = []
  for (const owner of ['application', 'connector-runner']) {
    const dir = join(folder, owner), current = manifest(owner)
    if (scenario === 'missing-peer' && owner === 'connector-runner') {
      delete current.peerDependencies['@power-evolve/contracts']
      current.dependencies['@power-evolve/contracts'] = 'workspace:~'
    }
    put(join(dir, 'package.json'), current)
    link(privateProtocol, join(dir, 'node_modules/@power-evolve/contracts'))
    link(sharedZod, join(dir, 'node_modules/zod'))
    roots.set(owner, dir)
    consumers.push({ name: current.name, root: dir, needsContractsPeer: true,
      peer: current.peerDependencies?.['@power-evolve/contracts'], dev: current.devDependencies?.['@power-evolve/contracts'],
      dependency: current.dependencies?.['@power-evolve/contracts'] })
  }
  const anchor = join(folder, 'installation/package.json')
  put(anchor, manifest(scenario === 'shared-platform' ? 'platform' : 'host'))
  link(provider, join(dirname(anchor), 'node_modules/@power-evolve/contracts'))
  link(sharedZod, join(dirname(anchor), 'node_modules/zod'))
  const entries = [
    ...(scenario === 'missing-provider' ? [] : [{ name: '@power-evolve/contracts', packageDir: provider,
      version: scenario === 'version-conflict' ? '0.3.0' : protocol.version, declarer: anchor, scope: 'profile' }]),
    { name: 'zod', packageDir: sharedZod, version: zodVersion, declarer: anchor, scope: 'profile' },
  ]
  const linkedRoots = [...roots].filter(([owner]) => scenario !== 'missing-linked-root' || owner !== 'connector-runner')
    .map(([owner, realPath]) => ({ name: owner, realPath }))
  linkedRoots.push({ name: 'contracts-provider', realPath: provider })
  const resolution = { profilesDir: join(folder, 'profiles'), profileDir: join(folder, 'profiles/owned'),
    localPackageNames: [], entries, linkedRoots }
  const interception = installRuntimeInterception(resolution)
  try {
    const providers = {
      '@power-evolve/contracts': { packageDir: provider, version: entries.find(e => e.name === protocol.name)?.version,
        declarer: anchor, mapped: entries.some(e => e.name === protocol.name), urls: {}, modules: {} },
      zod: { packageDir: sharedZod, version: zodVersion, declarer: anchor, mapped: true, urls: {}, modules: {} },
    }
    const runtimeModule = loaded => Object.fromEntries(Object.entries(loaded).filter(([name]) => name !== '__employee6ESMUrl'))
    for (const leaf of leaves) {
      const specifier = protocol.name + leaf.slice(1), url = pathToFileURL(resolve(provider, protocol.exports[leaf].default)).href
      providers[protocol.name].urls[specifier] = url
      providers[protocol.name].modules[specifier] = runtimeModule(await import(url))
    }
    const sharedZodUrl = pathToFileURL(join(sharedZod, 'index.js')).href
    providers.zod.urls.zod = sharedZodUrl
    providers.zod.modules.zod = runtimeModule(await import(sharedZodUrl))
    const expectedUses = [], observations = []
    const observe = async (sourcePath, consumerRoot, specifiersToImport, file) => {
      const imports = [...new Set(specifiersToImport)]
      put(file, imports.map((s, i) => 'import * as m' + i + ' from ' + JSON.stringify(s) + ';').join('\n')
        + '\nexport const rows = [' + imports.map((s, i) => '{specifier:' + JSON.stringify(s)
          + ',module:m' + i + ',url:m' + i + '.__employee6ESMUrl}').join(',') + '];\n')
      const loaded = await import(pathToFileURL(file).href)
      for (const row of loaded.rows) {
        const selected = realpathSync(interception.packageDir(row.specifier, pathToFileURL(file).href))
        const selectedManifest = JSON.parse(readFileSync(join(selected, 'package.json'), 'utf8'))
        observations.push({ ...row, module: runtimeModule(row.module), sourcePath, root: consumerRoot,
          packageDir: selected, version: selectedManifest.version })
        expectedUses.push({ sourcePath, specifier: row.specifier })
      }
    }
    for (const owner of roots.keys()) {
      const prefix = 'products/power-evolve/' + owner + '/src/'
      for (const file of inventory(root).runtime.filter(file => file.startsWith(prefix))) {
        const uses = collectRuntimeSourceExportUses(file, source(file))
        const actual = uses.filter(use => use.specifier.startsWith('@power-evolve/contracts/')).map(use => use.specifier)
        if (actual.length === 0) continue
        // Retain the actual package/ancestor lookup positions while isolating unrelated service initialization.
        if (uses.some(use => use.specifier === 'zod')) actual.push('zod')
        await observe(file, roots.get(owner), actual, join(roots.get(owner), relative(prefix, file) + '.probe.mjs'))
      }
      await observe(owner + ':all-node-protocol-exports', roots.get(owner), [...specifiers, 'zod'],
        join(roots.get(owner), 'all-exports.probe.mjs'))
    }
    await observe('contracts:zod-production-edge', provider, ['zod'], join(provider, 'lib/zod.probe.mjs'))
    const bridgeFile = 'products/power-evolve/application/src/account-contracts.ts'
    const bridge = join(roots.get('application'), 'account-contracts.js')
    put(bridge, transpile(source(bridgeFile), bridgeFile))
    const bridgeModule = await import(pathToFileURL(bridge).href)
    const account = providers[protocol.name].modules[protocol.name + '/account']
    assert(Object.keys(bridgeModule).length > 0)
    if (positive) for (const [name, value] of Object.entries(bridgeModule)) assert.equal(value, account[name])
    if (scenario.startsWith('nested-')) {
      const helper = join(roots.get('application'), 'node_modules/helper')
      const helperManifest = { name: 'helper', type: 'module',
        ...(scenario === 'nested-peer-helper' ? { peerDependencies: { [protocol.name]: 'workspace:~' },
          devDependencies: { [protocol.name]: 'workspace:~' } } : { dependencies: { [protocol.name]: 'workspace:~' } }) }
      put(join(helper, 'package.json'), helperManifest)
      link(privateProtocol, join(helper, 'node_modules/@power-evolve/contracts'))
      consumers.push({ name: 'helper', root: roots.get('application'), needsContractsPeer: true,
        peer: helperManifest.peerDependencies?.[protocol.name], dev: helperManifest.devDependencies?.[protocol.name],
        dependency: helperManifest.dependencies?.[protocol.name] })
      await observe('nested-helper:actual-ancestor', roots.get('application'), [protocol.name + '/stdio-mcp'], join(helper, 'entry.mjs'))
    }
    const errors = cloudProtocolResolutionErrors({ providers, consumers, observations, expectedUses,
      linkedRoots: linkedRoots.map(entry => entry.realPath) })
    if (positive) assert.deepEqual(errors, [])
    else assert(errors.length > 0, 'Invalid installation must be rejected')
    const markers = { 'missing-provider': 'Missing formal runtime provider', 'missing-peer': 'Missing matching Contracts peer',
      'missing-linked-root': 'Missing linkedRoot', 'nested-private-helper': 'Private protocol copy',
      'private-zod': 'Private protocol copy', 'version-conflict': 'Protocol version conflict' }
    if (markers[scenario]) assert(errors.some(error => error.includes(markers[scenario])), errors.join('\n'))
    assert.throws(() => interception.replace({ ...resolution, entries: entries.map(entry => entry.name === 'zod'
      ? { ...entry, version: '4.4.4' } : entry) }), /process restart/u)
    const modules = Object.values(providers[protocol.name].modules)
    const runtimeExports = modules.flatMap(module => Object.values(module))
    const schemaCount = runtimeExports.filter(value => value && typeof value === 'object' && '_zod' in value).length
    assert(schemaCount > 0)
    const factory = providers[protocol.name].modules[protocol.name + '/stdio-mcp'].stdioJsonV2
    const budget = { maxDepth: 100, maxNodes: 100, maxBytes: 100 }
    const first = factory(budget), second = factory(budget)
    assert.notEqual(first, second)
    assert.equal(first.safeParse({ a: 'b' }).success, true)
    budget.maxBytes = 1
    assert.equal(first.safeParse({ a: 'b' }).success, false)
    const changed = [...snapshots].filter(([file, text]) => readFileSync(resolve(root, file), 'utf8') !== text).map(([file]) => file)
    assert.deepEqual(changed, [], 'Input changes invalidate this process observation')
    return { scenario, admission: positive ? 'admitted' : 'rejected', errorCount: errors.length, errors: errors.slice(0, 8), observedEdges: observations.length,
      actualSources: snapshots.size, nodeProtocolEntries: leaves.length, runtimeExports: runtimeExports.length, schemaCount,
      bridgeExports: Object.keys(bridgeModule).length, node: process.version,
      scope: 'Fresh official resolver with privately emitted actual Contracts; actual consumer import lookup positions, no service launch' }
  } finally { interception.dispose() }
}

if (scenario) {
  assert(scenarios.includes(scenario))
  process.stdout.write(JSON.stringify(await runScenario(process.env.EMPLOYEE6_PEER_FIXTURE)) + '\n')
} else {
  test('actual product manifests provide matching Contracts peers and explicit installation providers', () => {
    const names = ['application', 'connector-runner', 'host', 'platform']
    assert.deepEqual(cloudProtocolManifestErrors(Object.fromEntries(names.map((owner) => {
      const current = manifest(owner)
      return [current.name, current]
    }))), [])
  })
  for (const name of scenarios) test('official resolver ' + name + ' protocol admission', () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'employee6-peer-')))
    try {
      const config = join(folder, 'tsconfig.json')
      put(config, { compilerOptions: { target: 'es2024', module: 'esnext', moduleResolution: 'bundler', paths: {} } })
      const started = Date.now()
      const child = spawnSync(process.execPath, ['--import', require.resolve('tsx/esm'), fileURLToPath(import.meta.url), name], {
        cwd: root, encoding: 'utf8', shell: false, timeout: 90000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, TSX_TSCONFIG_PATH: config, EMPLOYEE6_PEER_FIXTURE: folder },
      })
      const elapsedMs = Date.now() - started
      const stdout = child.stdout ?? '', stderr = child.stderr ?? ''
      let observedReport
      try { observedReport = JSON.parse(stdout.trim()) } catch { /* Preserve invalid report as a diagnostic result. */ }
      const validProtocolReport = observedReport?.scenario === name
        && ['admitted', 'rejected'].includes(observedReport.admission)
        && Number.isSafeInteger(observedReport.errorCount) && observedReport.errorCount >= 0
        && Number.isSafeInteger(observedReport.observedEdges) && observedReport.observedEdges > 0
        && Number.isSafeInteger(observedReport.actualSources) && observedReport.actualSources > 0
      const evidence = realpathSync(mkdtempSync(join(tmpdir(), 'employee6-peer-evidence-')))
      const diagnostic = { scenario: name, pid: child.pid ?? null, elapsedMs, timeoutMs: 90000,
        status: child.status, signal: child.signal, errorCode: child.error?.code ?? null,
        errorName: child.error?.name ?? null, validProtocolReport,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), evidence }
      writeFileSync(join(evidence, 'stdout.private.log'), stdout, { flag: 'wx', mode: 0o600 })
      writeFileSync(join(evidence, 'stderr.private.log'), stderr, { flag: 'wx', mode: 0o600 })
      writeFileSync(join(evidence, 'process-receipt.private.json'), JSON.stringify(diagnostic, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 })
      const message = JSON.stringify(diagnostic)
      process.stdout.write('# protocol-child ' + message + '\n')
      assert.equal(child.error, undefined, message)
      assert.equal(child.signal, null, message)
      assert.equal(child.status, 0, message)
      const report = JSON.parse(child.stdout.trim())
      assert.equal(report.scenario, name)
      assert(report.observedEdges > 0)
      process.stdout.write('# protocol ' + JSON.stringify(report) + '\n')
    } finally { rmSync(folder, { recursive: true, force: true }) }
  })
}
