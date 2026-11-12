import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { create } from 'tar'
import { collectProductPaths, externalDependencyHash, readTrackedPaths, verifyBundle, writeBundle } from './bundle.mjs'

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'pe-cloud-bundle-'))
  const root = join(directory, 'source')
  const tracked = []
  async function put(path, value, track = true) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
    if (track) tracked.push(path)
  }
  try { await run({ directory, root, tracked, put }) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('external dependency compatibility ignores workspace importers and object order while retaining package and snapshot changes', () => {
  const first = { importers: { cloud: { dependencies: { local: 'workspace:*' } } },
    packages: { 'one@1': { resolution: { integrity: 'content-one' }, engines: { node: '>=24' } } },
    snapshots: { 'one@1': { dependencies: { two: '2', three: '3' } } } }
  const reordered = { snapshots: { 'one@1': { dependencies: { three: '3', two: '2' } } },
    packages: { 'one@1': { engines: { node: '>=24' }, resolution: { integrity: 'content-one' } } },
    importers: { cloud: { dependencies: { otherLocal: 'workspace:*' } } } }
  assert.equal(externalDependencyHash(first), externalDependencyHash(reordered))
  assert.equal(externalDependencyHash('packages: {}\nsnapshots: {}\n'), externalDependencyHash({ packages: {}, snapshots: {} }))
  assert.notEqual(externalDependencyHash(first), externalDependencyHash({ ...first, packages: {} }))
  assert.notEqual(externalDependencyHash(first), externalDependencyHash({ ...first, snapshots: {} }))
  assert.throws(() => externalDependencyHash({ packages: {} }), /snapshots/)
})

test('streams a tracked resource listing larger than the synchronous command buffer', async () => {
  await fixture(async ({ root }) => {
    await mkdir(root)
    const git = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
    git(['init', '--quiet'])
    const blob = git(['hash-object', '-w', '--stdin'], '').trim()
    const paths = Array.from({ length: 12000 }, (_, index) => `resources/${String(index).padStart(5, '0')}-${'x'.repeat(100)}.txt`)
    git(['update-index', '-z', '--index-info'], paths.map(name => `100644 ${blob}\t${name}\0`).join(''))
    assert.ok(Buffer.byteLength(paths.join('\0')) > 1024 * 1024)
    assert.throws(() => git(['ls-files', '-z']), error => error.code === 'ENOBUFS')
    assert.deepEqual(await readTrackedPaths(root), paths)
  })
})

test('selects vendor builds, published resources and complete research runtime assets while excluding native and private files', async () => {
  await fixture(async ({ root, directory, tracked, put }) => {
    const pkg = 'packages/cloud/sample'
    await put(`${pkg}/package.json`, { files: ['lib', 'locale/*.json', 'assets', 'runtime/agent/*.py', '!assets/omit.txt'] })
    for (const path of ['lib/index.js', 'lib/worker.js', 'assets/skill.md', 'locale/en.json', 'runtime/agent/server.py']) {
      await put(`${pkg}/${path}`, 'runtime', !path.startsWith('lib/'))
    }
    for (const path of ['lib/native.node', 'lib/.env', 'assets/.private/token', 'assets/account.private.json', 'assets/omit.txt', 'src/index.ts', 'tests/main.test.mjs']) {
      await put(`${pkg}/${path}`, 'excluded')
    }
    await put('vendor/cordis/package.json', { files: ['lib', 'locale'] })
    await put('vendor/cordis/lib/index.js', 'vendor', false)
    await put('vendor/cordis/locale/en.json', '{}')
    await put('apps/web/package.json', { files: ['dist'] })
    await put('apps/web/dist/index.html', 'web', false)
    const research = 'integrations/epri-research'
    for (const path of ['package.json', 'plugins/cloud/assets.mjs', 'plugins/cloud/git-runner.py',
      'src/reused/engine/runner.py', 'src/server/document-native.py', 'upstream/skills/science/SKILL.md',
      'upstream/skills/science/tests/test_skill.py', 'licenses/third-party.txt', 'NOTICE', 'cordis.cloud.patch.yml']) {
      await put(`${research}/${path}`, path === 'package.json' ? {} : 'research')
    }
    await put(`${research}/dist/cloud/index.mjs`, 'cloud', false)
    await put(`${research}/tests/unit.test.mjs`, 'excluded')
    await put(`${research}/node_modules/native/addon.node`, 'excluded')
    await put('deploy/bundle', 'excluded')
    await writeFile(join(directory, 'outside.txt'), 'outside')
    await symlink(join(directory, 'outside.txt'), join(root, pkg, 'assets', 'linked.txt'))
    tracked.push(`${pkg}/assets/linked.txt`)
    await symlink(directory, join(root, pkg, 'lib', 'linked-directory'))

    const paths = await collectProductPaths(root, tracked)
    assert.ok(paths.includes('vendor/cordis/lib/index.js'))
    assert.ok(paths.includes(`${pkg}/runtime/agent/server.py`))
    assert.ok(paths.includes(`${pkg}/locale/en.json`))
    assert.ok(paths.includes(`${research}/src/reused/engine/runner.py`))
    assert.ok(paths.includes(`${research}/plugins/cloud/git-runner.py`))
    assert.ok(paths.includes(`${research}/upstream/skills/science/tests/test_skill.py`))
    assert.ok(paths.includes(`${research}/dist/cloud/index.mjs`))
    for (const path of paths) assert.doesNotMatch(path, /\.node$|\.env|\.private|linked|\/src\/index\.ts|\/tests\/unit|main\.test|omit\.txt|^deploy\//)
  })
})

test('manifest describes the exact archived bytes and executable mode, and detects changed or missing archive contents', async () => {
  await fixture(async ({ root, directory, put }) => {
    const path = 'packages/cloud/sample/lib/index.js'
    await put(path, 'export const value = 1\n')
    await chmod(join(root, path), 0o755)
    const output = join(directory, 'bundle')
    const manifest = await writeBundle(root, [path], { sourceCommit: 'fixture-commit', nodeVersion: '24.19.0' }, output)
    const bytes = await readFile(join(root, path))
    assert.deepEqual(manifest.files, [{ path, size: bytes.length, mode: 0o755,
      sha256: createHash('sha256').update(bytes).digest('hex') }])
    assert.deepEqual(await verifyBundle(output), manifest)
    assert.deepEqual(manifest.managedRoots, ['packages/cloud/sample/lib'])

    await put(path, 'export const value = 2\n')
    await create({ cwd: root, file: join(output, 'products.tar.gz'), gzip: true }, [path])
    await assert.rejects(verifyBundle(output), /与清单不一致/)
    const current = await writeBundle(root, [path], {}, output)
    current.files.push({ ...current.files[0], path: 'packages/cloud/sample/lib/missing.js' })
    await writeFile(join(output, 'manifest.json'), JSON.stringify(current))
    await assert.rejects(verifyBundle(output), /缺少/)
    current.files.pop()
    current.managedRoots = ['..']
    await writeFile(join(output, 'manifest.json'), JSON.stringify(current))
    await assert.rejects(verifyBundle(output), /受管理目录/)
  })
})

test('refuses source-tree outputs and verifies archive members are regular files with no duplicates or extra paths', async () => {
  await fixture(async ({ root, directory, put }) => {
    const path = 'apps/web/dist/index.html'
    await put(path, 'web')
    await assert.rejects(writeBundle(root, [path], {}, join(root, 'bundle')), /仓库之外/)
    const output = join(directory, 'bundle')
    await writeBundle(root, [path], {}, output)
    await create({ cwd: root, file: join(output, 'products.tar.gz'), gzip: true }, [path, path])
    await assert.rejects(verifyBundle(output), /重复/)
    await symlink('index.html', join(root, 'apps/web/dist/link.html'))
    await create({ cwd: root, file: join(output, 'products.tar.gz'), gzip: true }, ['apps/web/dist/link.html'])
    await assert.rejects(verifyBundle(output), /非普通文件/)
  })
})
