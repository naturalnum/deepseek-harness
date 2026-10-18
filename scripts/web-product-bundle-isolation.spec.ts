/** Exercise real Vite build inputs, including files absent from ordinary chunk imports. */

import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Plugin } from 'vite'
import { browserDependencyAnalysis, productWebBundleIsolation } from '../apps/web/product-isolation.ts'
import { WebProductBundleIsolation, type WebOutputBundle, type WebOutputChunk } from './web-product-bundle-isolation.ts'
import { EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS } from './experimental-package-policy.ts'
import { BundleInputIsolation } from './bundle-input-isolation.ts'

const filesystem = vi.hoisted(() => ({ missingRoot: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => !filesystem.missingRoot && actual.existsSync(path),
  }
})

// Vite is owned by the Web app rather than the repository's scripting dependencies.
const vite = createRequire(new URL('../apps/web/package.json', import.meta.url))('vite') as {
  build(config: Record<string, unknown>): Promise<unknown>
}

function fixture() {
  // Vite resolves inputs with native realpath, which expands Windows short names.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-web-bundle-isolation-')))
  const web = join(root, 'apps/web')
  const links: string[] = []
  onTestFinished(() => {
    for (const path of links) unlinkSync(path)
    rmSync(root, { recursive: true, force: true })
  })
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  write('package.json', '{"name":"isolation-fixture","type":"module"}')
  write('apps/web/package.json', '{"name":"@deepseek-ai/dsh-web-frontend","type":"module"}')
  write('apps/web/index.html', '<script type="module" src="/src/main.js"></script>')
  write('apps/web/src/main.js', 'globalThis.product = true')
  write('apps/web/src/preview.js', 'import "../../../packages/experimental/prototype/index.js"')
  write('packages/experimental/prototype/package.json', '{"name":"@deepseek-ai/dsh-experimental-prototype","type":"module"}')
  write('packages/experimental/prototype/index.js', 'globalThis.experimental = true')
  write('packages/experimental/prototype/style.css', '.experimental { color: red }')
  write('packages/experimental/prototype/tiny.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const run = (extra: Record<string, unknown> = {}): Promise<unknown> => vite.build({
    configFile: false,
    root: web,
    logLevel: 'silent',
    plugins: productWebBundleIsolation(root, web),
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: { index: join(web, 'index.html'), bootstrap: join(web, 'src/preview.js') },
      },
    },
    ...extra,
  })
  return { root, web, write, run, links }
}

describe('default Web bundle input isolation', () => {
  it('requires explicit analysis intent before allowing externalized inputs in a non-writing build', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "external-lib"; globalThis.product = true')
    const externalize = {
      name: 'fixture-external-analysis',
      resolveId(id: string) { return id === 'external-lib' ? { id, external: true } : null },
    }
    await expect(test.run({ plugins: [...productWebBundleIsolation(test.root, test.web), externalize] }))
      .rejects.toThrow(/external module external-lib has no bundled input proof/)
    await expect(test.run({ plugins: [
      ...productWebBundleIsolation(test.root, test.web), browserDependencyAnalysis(), externalize,
    ] })).resolves.toBeDefined()
    expect(existsSync(join(test.web, 'dist'))).toBe(false)
  })

  it('refuses output writing when dependency analysis bypasses the product check', async () => {
    const test = fixture()
    const output = join(test.root, 'analysis-output')
    await expect(test.run({
      plugins: [...productWebBundleIsolation(test.root, test.web), browserDependencyAnalysis()],
      build: { write: true, outDir: output },
    })).rejects.toThrow(/browser dependency analysis requires build.write: false/)
    expect(existsSync(output)).toBe(false)
  })

  it('allows experimental code in the separately emitted preview entry', async () => {
    const output: unknown = expect.arrayContaining([
      expect.objectContaining({ type: 'asset', fileName: 'index.html' }),
      expect.objectContaining({ type: 'chunk', name: 'bootstrap' }),
    ])
    await expect(fixture().run()).resolves.toMatchObject({ output })
  })

  it.each([
    ['static import', 'import "../../../packages/experimental/prototype/index.js"'],
    ['dynamic import', 'void import("../../../packages/experimental/prototype/index.js")'],
    ['raw query import', 'import text from "../../../packages/experimental/prototype/index.js?raw"; console.log(text)'],
  ])('rejects a product %s of experimental input', async (_name, source) => {
    const test = fixture()
    test.write('apps/web/src/main.js', source)
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks inline HTML modules after Vite resolves and bundles them', async () => {
    const test = fixture()
    test.write('apps/web/index.html', '<script type="module">import "../../packages/experimental/prototype/index.js"</script>')
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks resolver aliases by the actual file owner', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "feature"')
    await expect(test.run({ resolve: { alias: { feature: join(test.root, 'packages/experimental/prototype/index.js') } } }))
      .rejects.toThrow(/Web product isolation: experimental input/)
  })

  it.each(['@deepseek-ai/dsh-experimental-aliased', ...Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS)])('checks npm alias package identity %s independently of its directory name', async (name) => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "ordinary-name"')
    test.write('apps/web/node_modules/ordinary-name/package.json',
      JSON.stringify({ name, type: 'module', main: 'index.js' }))
    test.write('apps/web/node_modules/ordinary-name/index.js', 'globalThis.aliased = true')
    await expect(test.run()).rejects.toThrow(/belongs to experimental package/)
  })

  it('follows virtual module edges to their resolved inputs', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "virtual:feature"')
    await expect(test.run({ plugins: [...productWebBundleIsolation(test.root, test.web), {
      name: 'fixture-virtual-module',
      resolveId(id: string) { return id === 'virtual:feature' ? '\u0000virtual:feature' : null },
      load(id: string) {
        return id === '\u0000virtual:feature'
          ? `import ${JSON.stringify(join(test.root, 'packages/experimental/prototype/index.js'))}` : null
      },
    }] })).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('rejects experimental inputs merged into a product-reachable shared chunk', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "./shared.js"; globalThis.product = true')
    test.write('apps/web/src/shared.js', 'globalThis.shared = true')
    await expect(test.run({ build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: { index: join(test.web, 'index.html'), bootstrap: join(test.web, 'src/preview.js') },
        output: { manualChunks: (id: string) => id.endsWith('/shared.js') || id.includes('/packages/experimental/')
          ? 'shared' : undefined },
      },
    } })).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('checks symlinked package ownership', async () => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "ordinary-name/index.js"')
    const link = join(test.web, 'node_modules/ordinary-name')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(test.root, 'packages/experimental/prototype'), link, process.platform === 'win32' ? 'junction' : 'dir')
    test.links.push(link)
    await expect(test.run({ resolve: { preserveSymlinks: true } }))
      .rejects.toThrow(/Web product isolation: experimental input/)
  })

  it.each([
    ['stylesheet import', '@import "../../../packages/experimental/prototype/style.css";'],
    ['inlined image', '.product { background: url("../../../packages/experimental/prototype/tiny.svg") }'],
    ['emitted image', '.product { background: url("../../../packages/experimental/prototype/tiny.svg?no-inline") }'],
  ])('checks the actual CSS transform inputs for %s', async (_name, css) => {
    const test = fixture()
    test.write('apps/web/src/main.js', 'import "./style.css"; globalThis.product = true')
    test.write('apps/web/src/style.css', css)
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('allows experimental CSS only used by preview', async () => {
    const test = fixture()
    test.write('apps/web/src/preview.js', 'import "./preview.css"; globalThis.preview = true')
    test.write('apps/web/src/preview.css', '@import "../../../packages/experimental/prototype/style.css";')
    await expect(test.run()).resolves.toBeDefined()
  })

  it.each([
    ['URL worker', 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" })'],
    ['inline worker', 'import Worker from "./worker.js?worker&inline"; new Worker()'],
  ])('checks %s subbuild inputs when the product loads it', async (_name, source) => {
    const test = fixture()
    test.write('apps/web/src/main.js', source)
    test.write('apps/web/src/worker.js', 'import "../../../packages/experimental/prototype/index.js"')
    await expect(test.run()).rejects.toThrow(/Web product isolation: experimental input/)
  })

  it('allows an experimental worker loaded only by preview', async () => {
    const test = fixture()
    test.write('apps/web/src/preview.js', 'new Worker(new URL("./worker.js", import.meta.url), { type: "module" })')
    test.write('apps/web/src/worker.js', 'import "../../../packages/experimental/prototype/index.js"')
    await expect(test.run()).resolves.toBeDefined()
  })

  it('rejects an emitted entry without its original HTML input', () => {
    const test = fixture()
    const inputs = new WebProductBundleIsolation(test.root, test.web)
    expect(() => { inputs.verify({}, () => null) }).toThrow(/index.html is missing its original HTML input/)
  })

  it('rejects a worker asset whose subbuild was not observed', () => {
    const test = fixture()
    const inputs = new WebProductBundleIsolation(test.root, test.web)
    inputs.assetReference('worker.js', 'index.html', 'asset')
    expect(() => { inputs.verify({
      'index.html': { type: 'asset', fileName: 'index.html', names: ['index.html'], originalFileNames: ['index.html'] },
      'worker.js': { type: 'asset', fileName: 'worker.js', names: [], originalFileNames: [] },
    }, () => null) }).toThrow(/worker.js has no recorded original files/)
  })
})

describe('output graph compatibility without a build', () => {
  function graph() {
    const root = fileURLToPath(new URL('../', import.meta.url)), web = join(root, 'apps/web')
    const source = join(web, 'src/main.ts')
    const forbidden = join(root, 'packages/experimental/agent-team/src/index.ts')
    const inputs = new WebProductBundleIsolation(root, web)
    const chunk = (overrides: Partial<WebOutputChunk> = {}): WebOutputChunk => ({
      type: 'chunk', fileName: 'main.js', facadeModuleId: source,
      modules: { [source]: {} }, imports: [], dynamicImports: [], ...overrides,
    })
    const bundle: WebOutputBundle = {
      'index.html': { type: 'asset', fileName: 'index.html', names: ['index.html'], originalFileNames: ['index.html'] },
      'main.js': chunk(),
    }
    inputs.assetReference('main.js', 'index.html', 'asset')
    const moduleInfo = () => ({ importedIds: [], dynamicallyImportedIds: [], isIncluded: true, isExternal: false })
    const verify = (): void => { inputs.captureChunks(bundle); inputs.verify(bundle, moduleInfo) }
    return { inputs, chunk, bundle, forbidden, source, moduleInfo, verify, root, web }
  }

  function runHook(hook: unknown, context: object, ...args: unknown[]): unknown {
    if (typeof hook === 'function') return Reflect.apply(hook, context, args)
    if (hook !== null && typeof hook === 'object' && 'handler' in hook && typeof hook.handler === 'function') {
      return Reflect.apply(hook.handler, context, args)
    }
    throw new Error('Expected a callable plugin hook')
  }

  function adapter() {
    const test = graph(), plugins = productWebBundleIsolation(test.root, test.web)
    const capture = plugins[0]!, guard = plugins[1]!
    const forwarded: string[] = []
    const context = { addWatchFile(file: string) { forwarded.push(file) } }
    const worker: Plugin = { name: 'vite:worker',
      load: { order: 'pre', async handler(id) { this.addWatchFile(id); return 'loaded' } },
      transform: { order: 'post', async handler(code) { this.addWatchFile(code); return code } },
    }
    const url: Plugin = { name: 'vite:worker-import-meta-url',
      transform: { order: 'pre', async handler(code) { this.addWatchFile(code); return code } },
    }
    const css: Plugin = { name: 'vite:css', transform(code) { this.addWatchFile(code); return code } }
    runHook(guard.configResolved, {}, { plugins: [worker, url, css], build: { write: true } })
    const config = runHook(guard.config, {}, {}) as {
      worker: { plugins(): Plugin[] }
      experimental: { renderBuiltUrl(file: string, context: { hostId: string; type: 'asset' }): unknown }
    }
    runHook(guard.buildStart, {})
    config.experimental.renderBuiltUrl('main.js', { hostId: 'index.html', type: 'asset' })
    const verify = (): void => {
      runHook(capture.generateBundle, {}, {}, test.bundle)
      runHook(guard.generateBundle, { getModuleInfo: test.moduleInfo }, {}, test.bundle)
    }
    return { ...test, guard, worker, url, css, config, context, forwarded, verify }
  }

  it('checks public Rolldown module records without Rollup inclusion and external flags', () => {
    const test = graph()
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, () => ({ code: '', importedIds: [], dynamicallyImportedIds: [] })) })
      .not.toThrow()
    expect(() => { test.inputs.verify(test.bundle, id => ({ code: '', importedIds: id === test.source ? [test.forbidden] : [],
      dynamicallyImportedIds: [] })) }).toThrow(/experimental input/)
    expect(() => { test.inputs.verify(test.bundle, () => ({ code: null, importedIds: [], dynamicallyImportedIds: [] })) })
      .toThrow(/has no bundled input proof/)
  })

  it('keeps Rollup explicitly excluded dependencies excluded', () => {
    const test = graph()
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, id => ({ ...test.moduleInfo(), isIncluded: id === test.source,
      importedIds: id === test.source ? [test.forbidden] : [],
    })) }).not.toThrow()
  })

  it.each(['transform', 'url'] as const)('checks real worker watch-file calls from %s without getWatchFiles', async (hook) => {
    const test = adapter()
    const result = await runHook((hook === 'url' ? test.url : test.worker).transform, test.context, test.forbidden, test.source)
    expect(result).toBe(test.forbidden)
    expect(test.forwarded).toEqual([test.forbidden])
    expect(test.verify).toThrow(/experimental input/)
  })

  it('records worker load dependencies separately from the module id', async () => {
    const test = adapter()
    const load: Plugin = { name: 'vite:worker', load(id) { this.addWatchFile(test.forbidden); return id }, transform: () => null }
    const url: Plugin = { name: 'vite:worker-import-meta-url', transform: () => null }
    const css: Plugin = { name: 'vite:css', transform: () => null }
    runHook(test.guard.configResolved, {}, { plugins: [load, url, css], build: { write: true } })
    await runHook(load.load, test.context, test.source)
    expect(test.verify).toThrow(/experimental input/)
  })

  it.each(['?worker', '?worker&inline', '?sharedworker', '?sharedworker&inline'])(
    'keeps the complete forwarded file list for %s wrappers without emitted worker assets', async (query) => {
      const test = adapter(), id = test.source + query
      const load: Plugin = { name: 'vite:worker',
        load() { this.addWatchFile(test.forbidden); return 'wrapper' }, transform: () => null,
      }
      const url: Plugin = { name: 'vite:worker-import-meta-url', transform: () => null }
      const css: Plugin = { name: 'vite:css', transform: () => null }
      runHook(test.guard.configResolved, {}, { plugins: [load, url, css], build: { write: true } })
      const worker = test.config.worker.plugins()[0]!
      runHook(worker.generateBundle, { getModuleIds: () => [test.source].values() }, {}, { 'worker.js': test.chunk() })
      await runHook(load.load, test.context, id)
      test.bundle['main.js'] = test.chunk({ modules: { [id]: {} } })
      expect(test.forwarded).toEqual([test.forbidden])
      expect(test.verify).toThrow(/experimental input/)
    },
  )

  it('preserves separate load and transform observations and replaces only a rerun hook', async () => {
    const test = adapter()
    await runHook(test.worker.transform, test.context, test.forbidden, test.source)
    await runHook(test.url.transform, test.context, test.source, test.source)
    expect(test.verify).toThrow(/experimental input/)
    await runHook(test.worker.transform, test.context, test.source, test.source)
    expect(test.verify).not.toThrow()
  })

  it('retains cached worker watch observations across a build reset', async () => {
    const test = adapter()
    await runHook(test.url.transform, test.context, test.forbidden, test.source)
    runHook(test.guard.buildStart, {})
    test.config.experimental.renderBuiltUrl('main.js', { hostId: 'index.html', type: 'asset' })
    expect(test.verify).toThrow(/experimental input/)
  })

  it('captures all worker graph module ids on a Rolldown context without getWatchFiles', () => {
    const test = adapter(), worker = test.config.worker.plugins()[0]!
    const workerChunk = test.chunk({ fileName: 'worker.js', modules: { [test.source]: {} } })
    runHook(worker.generateBundle, { getModuleIds: () => [test.source, test.forbidden].values() }, {}, { 'worker.js': workerChunk })
    test.bundle['worker.js'] = { type: 'asset', fileName: 'worker.js', names: [], originalFileNames: [] }
    test.config.experimental.renderBuiltUrl('worker.js', { hostId: 'main.js', type: 'asset' })
    expect(test.verify).toThrow(/experimental input/)
  })

  it('accepts a clean worker graph with only the public Rolldown plugin context APIs', () => {
    const test = adapter(), worker = test.config.worker.plugins()[0]!
    runHook(worker.generateBundle, { getModuleIds: () => [test.source].values() }, {}, {
      'worker.js': test.chunk({ fileName: 'worker.js' }),
    })
    test.bundle['worker.js'] = { type: 'asset', fileName: 'worker.js', names: [], originalFileNames: [] }
    test.config.experimental.renderBuiltUrl('worker.js', { hostId: 'main.js', type: 'asset' })
    expect(test.verify).not.toThrow()
  })

  it('preserves worker hook metadata while recording inputs', () => {
    const test = adapter()
    expect(test.worker.load).toMatchObject({ order: 'pre' })
    expect(test.worker.transform).toMatchObject({ order: 'post' })
    expect(test.url.transform).toMatchObject({ order: 'pre' })
  })

  it('keeps Rollup worker watch files that are absent from its module graph', () => {
    const test = adapter(), worker = test.config.worker.plugins()[0]!
    runHook(worker.generateBundle, {
      getModuleIds: () => [test.source].values(), getWatchFiles: () => [test.forbidden],
    }, {}, { 'worker.js': test.chunk({ fileName: 'worker.js' }) })
    test.bundle['worker.js'] = { type: 'asset', fileName: 'worker.js', names: [], originalFileNames: [] }
    test.config.experimental.renderBuiltUrl('worker.js', { hostId: 'main.js', type: 'asset' })
    expect(test.verify).toThrow(/experimental input/)
  })

  it('keeps CSS addWatchFile ownership after sharing the context adapter', () => {
    const test = adapter()
    runHook(test.css.transform, test.context, test.forbidden, test.source)
    expect(test.forwarded).toEqual([test.forbidden])
    expect(test.verify).toThrow(/experimental input/)
  })

  it('fails closed when Vite worker hook instrumentation is unavailable', () => {
    const test = adapter()
    expect(() => runHook(test.guard.configResolved, {}, { plugins: [test.css], build: { write: true } }))
      .toThrow(/worker input instrumentation is unavailable/)
  })

  it('accepts the public Rolldown chunk fields without Rollup-only edge metadata', () => {
    const test = graph()
    expect(Object.hasOwn(test.bundle['main.js']!, 'implicitlyLoadedBefore')).toBe(false)
    expect(Object.hasOwn(test.bundle['main.js']!, 'referencedFiles')).toBe(false)
    expect(test.verify).not.toThrow()
  })

  it.each(['imports', 'dynamicImports', 'implicitlyLoadedBefore'] as const)('follows present %s edges to forbidden chunks', (edge) => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ [edge]: ['forbidden.js'] })
    test.bundle['forbidden.js'] = test.chunk({ fileName: 'forbidden.js', modules: { [test.forbidden]: {} } })
    expect(test.verify).toThrow(/experimental input/)
  })

  it.each(['imports', 'dynamicImports', 'implicitlyLoadedBefore', 'referencedFiles'] as const)('rejects missing output reached through %s', (edge) => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ [edge]: ['missing.js'] })
    expect(test.verify).toThrow(/referenced output missing.js is missing/)
  })

  it('preserves a present Rollup referencedFiles asset edge', () => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ implicitlyLoadedBefore: [], referencedFiles: ['forbidden.bin'] })
    test.bundle['forbidden.bin'] = { type: 'asset', fileName: 'forbidden.bin', names: [], originalFileNames: [test.forbidden] }
    expect(test.verify).toThrow(/experimental input/)
  })

  it('keeps Vite imported-asset edges when Rollup-only fields are absent', () => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ viteMetadata: { importedCss: new Set(), importedAssets: new Set(['forbidden.bin']) } })
    test.bundle['forbidden.bin'] = { type: 'asset', fileName: 'forbidden.bin', names: [], originalFileNames: [test.forbidden] }
    expect(test.verify).toThrow(/experimental input/)
  })

  it('keeps captured pure-CSS ownership after Vite removes the wrapper chunk', () => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ viteMetadata: { importedCss: new Set(['style.css']), importedAssets: new Set() } })
    test.bundle['style.js'] = test.chunk({ fileName: 'style.js', modules: { [test.forbidden]: {} },
      viteMetadata: { importedCss: new Set(['style.css']), importedAssets: new Set() } })
    test.bundle['style.css'] = { type: 'asset', fileName: 'style.css', names: [], originalFileNames: [] }
    test.inputs.captureChunks(test.bundle)
    delete test.bundle['style.js']
    expect(() => { test.inputs.verify(test.bundle, test.moduleInfo) }).toThrow(/experimental input/)
  })

  it('keeps recorded asset URL edges when Rollup-only fields are absent', () => {
    const test = graph()
    test.inputs.assetReference('forbidden.bin', 'main.js', 'asset')
    test.bundle['forbidden.bin'] = { type: 'asset', fileName: 'forbidden.bin', names: [], originalFileNames: [test.forbidden] }
    expect(test.verify).toThrow(/experimental input/)
  })

  it('keeps recorded public-file ownership checks when Rollup-only fields are absent', () => {
    const test = graph()
    test.inputs.assetReference(test.forbidden, 'main.js', 'public')
    expect(test.verify).toThrow(/experimental input/)
  })

  it('keeps included module dependency ownership checks when Rollup-only fields are absent', () => {
    const test = graph()
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, id => ({ ...test.moduleInfo(),
      importedIds: id === test.source ? [test.forbidden] : [],
    })) }).toThrow(/experimental input/)
  })

  it('still rejects missing and external module records when Rollup-only fields are absent', () => {
    const test = graph()
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, () => null) }).toThrow(/has no Rollup module record/)
    const external = () => ({ ...test.moduleInfo(), isExternal: true })
    expect(() => { test.inputs.verify(test.bundle, external) }).toThrow(/has no bundled input proof/)
  })

  it('accepts only the exact generated Rolldown runtime without a public module record', () => {
    const test = graph(), runtime = '\0rolldown/runtime.js'
    test.bundle['main.js'] = test.chunk({ modules: { [runtime]: {}, [test.source]: {} } })
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, id => id === runtime ? null : test.moduleInfo()) }).not.toThrow()
  })

  it.each(['importedIds', 'dynamicallyImportedIds'] as const)('accepts the exact generated runtime on a module %s edge', (edge) => {
    const test = graph(), runtime = '\0rolldown/runtime.js'
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, id => id === runtime ? null : { ...test.moduleInfo(), [edge]: [runtime] }) })
      .not.toThrow()
  })

  it.each([
    '\0virtual:rolldown/runtime.js', '\0rolldown/runtime.js?raw', '\0rolldown/runtime.js?worker',
    '\0rolldown/runtime.js/extra', '\0rolldown/runtime.jsx', 'rolldown/runtime.js',
    '\0other/runtime.js',
  ])('rejects a different virtual runtime identity without a module record: %j', (id) => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ modules: { [id]: {}, [test.source]: {} } })
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, value => value === id ? null : test.moduleInfo()) })
      .toThrow(/has no Rollup module record/)
  })

  it('keeps physical path rejection for a literal backslash runtime lookalike', () => {
    const test = graph(), lookalike = '\\0rolldown/runtime.js'
    test.bundle['main.js'] = test.chunk({ modules: { [lookalike]: {}, [test.source]: {} } })
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, () => null) }).toThrow(/input .* is missing/)
  })

  it('does not count a generated runtime as proof of a reachable application module', () => {
    const test = graph()
    test.bundle['main.js'] = test.chunk({ modules: { '\0rolldown/runtime.js': {} } })
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, () => null) }).toThrow(/index.html has no recorded reachable modules/)
  })

  it('still checks a public module record supplied for the exact runtime identity', () => {
    const test = graph(), runtime = '\0rolldown/runtime.js'
    test.bundle['main.js'] = test.chunk({ modules: { [runtime]: {}, [test.source]: {} } })
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, () => ({ ...test.moduleInfo(), isExternal: true })) })
      .toThrow(/has no bundled input proof/)
    expect(() => { test.inputs.verify(test.bundle, id => ({ ...test.moduleInfo(),
      importedIds: id === runtime ? [test.forbidden] : [],
    })) }).toThrow(/experimental input/)
  })

  it('does not hide a forbidden sibling module beside the generated runtime', () => {
    const test = graph(), runtime = '\0rolldown/runtime.js'
    test.bundle['main.js'] = test.chunk({ modules: { [runtime]: {}, [test.forbidden]: {} } })
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, id => id === runtime ? null : test.moduleInfo()) }).toThrow(/experimental input/)
  })

  it.each(['imports', 'dynamicImports', 'implicitlyLoadedBefore', 'referencedFiles'] as const)(
    'checks %s edges of a chunk that contains the generated runtime', (edge) => {
      const test = graph(), runtime = '\0rolldown/runtime.js'
      test.bundle['main.js'] = test.chunk({ imports: ['runtime.js'] })
      test.bundle['runtime.js'] = test.chunk({ fileName: 'runtime.js', modules: { [runtime]: {} }, [edge]: ['forbidden.js'] })
      test.bundle['forbidden.js'] = test.chunk({ fileName: 'forbidden.js', modules: { [test.forbidden]: {} } })
      test.inputs.captureChunks(test.bundle)
      expect(() => { test.inputs.verify(test.bundle, id => id === runtime ? null : test.moduleInfo()) }).toThrow(/experimental input/)
    },
  )

  it('keeps asset and worker ownership checks on a chunk containing the generated runtime', () => {
    const test = graph(), runtime = '\0rolldown/runtime.js'
    test.bundle['main.js'] = test.chunk({ modules: { [runtime]: {}, [test.source]: {} },
      viteMetadata: { importedCss: new Set(), importedAssets: new Set(['worker.js']) } })
    test.bundle['worker.js'] = { type: 'asset', fileName: 'worker.js', names: [], originalFileNames: [] }
    test.inputs.workerBundle({ 'worker.js': test.chunk({ fileName: 'worker.js', modules: { [test.forbidden]: {} } }) }, [test.forbidden])
    test.inputs.captureChunks(test.bundle)
    expect(() => { test.inputs.verify(test.bundle, id => id === runtime ? null : test.moduleInfo()) }).toThrow(/experimental input/)
  })
})

describe('bundler input ownership', () => {
  it.each(Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS))('rejects retained identity %s in unresolved inputs and source-map ownership', (name) => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    for (const reference of [name, `${name}/client`, `\u0000virtual:${name}/client?raw`]) {
      expect(() => { ownership.assertInput(reference) }).toThrow(/experimental input/)
    }
    const absentWindowsSource = `C:\\omitted\\node_modules\\${name.replaceAll('/', '\\')}\\src\\index.ts`
    expect(() => { ownership.assertSourceMapInput(absentWindowsSource) }).toThrow(/experimental input/)
    test.write('apps/web/node_modules/upstream/package.json', JSON.stringify({ name }))
    expect(() => { ownership.assertSourceMapInput(join(test.web, 'node_modules/upstream/src/omitted.js')) })
      .toThrow(/belongs to experimental package/)
  })

  it('refuses source-map paths whose filesystem root is unavailable', () => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    filesystem.missingRoot = true
    try {
      expect(() => { ownership.assertSourceMapInput(join(test.web, 'missing/source.js')) })
        .toThrow(/has no existing filesystem root/)
    } finally {
      filesystem.missingRoot = false
    }
  })

  it('retains ownership through queries, filesystem URLs, and virtual path wrappers', () => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    const file = join(test.root, 'packages/experimental/prototype/index.js')
    for (const id of [file, `${file}?raw`, `${pathToFileURL(file).href}?import`, `\u0000${file}?commonjs-proxy`,
      `virtual:${file}`, `/@fs/${file.replaceAll('\\', '/')}`, file.replaceAll('/', '\\')]) {
      expect(() => { ownership.assertInput(id) }, id).toThrow(/experimental input/)
    }
  })

  it('distinguishes missing actual inputs from omitted upstream source-map files', () => {
    const test = fixture()
    const ownership = new BundleInputIsolation(test.root, 'fixture')
    const file = join(test.web, 'node_modules/upstream/src/omitted.js')
    test.write('apps/web/node_modules/upstream/package.json', '{"name":"upstream"}')
    expect(() => { ownership.assertInput(file) }).toThrow(/is missing/)
    expect(() => { ownership.assertSourceMapInput(file) }).not.toThrow()
    test.write('apps/web/node_modules/upstream/package.json', '{"name":"@deepseek-ai/dsh-experimental-upstream"}')
    ownership.reset()
    expect(() => { ownership.assertSourceMapInput(file) }).toThrow(/belongs to experimental package/)
  })
})
