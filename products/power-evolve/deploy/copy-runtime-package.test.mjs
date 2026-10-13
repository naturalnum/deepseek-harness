/** Image export preserves native plugin metadata and bundle composition resources. */
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { copyRuntimePackage } from './copy-runtime-package.mjs'

async function fixture(t, manifest) {
  const root = await mkdtemp(join(tmpdir(), 'pe-package-display-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), output = join(root, 'runtime')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@test/plugin', version: '1.0.0', files: ['lib', 'locale', 'icon.svg'], ...manifest }))
  return { source, output }
}

test('runtime export retains the official icon and English/Chinese display resources without source', async (t) => {
  const { source, output } = await fixture(t, { icon: './icon.svg', exports: { './locale/*.json': './locale/*.json' } })
  await mkdir(join(source, 'locale')); await mkdir(join(source, 'lib')); await mkdir(join(source, 'src'))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
  const en = JSON.stringify({ meta: { title: 'Agent Teams', description: 'Work together' } })
  const zh = JSON.stringify({ meta: { title: '智能体团队', description: '团队协作' } })
  await writeFile(join(source, 'icon.svg'), svg)
  await writeFile(join(source, 'locale/en.json'), en); await writeFile(join(source, 'locale/zh.json'), zh)
  await writeFile(join(source, 'lib/index.js'), 'export const inject = []\n')
  await writeFile(join(source, 'src/index.ts'), 'throw new Error("builder source")\n')
  await copyRuntimePackage(source, output)
  assert.equal(await readFile(join(output, 'icon.svg'), 'utf8'), svg)
  assert.equal(await readFile(join(output, 'locale/en.json'), 'utf8'), en)
  assert.equal(await readFile(join(output, 'locale/zh.json'), 'utf8'), zh)
  assert.equal(await readFile(join(output, 'lib/index.js'), 'utf8'), 'export const inject = []\n')
  assert.deepEqual((await readdir(output)).sort(), ['icon.svg', 'lib', 'locale', 'package.json'])
})

test('a manifest-declared icon with a different filename is exported', async (t) => {
  const { source, output } = await fixture(t, { icon: './brand.png', files: ['brand.png'] })
  const bytes = Buffer.from([137, 80, 78, 71])
  await writeFile(join(source, 'brand.png'), bytes)
  await copyRuntimePackage(source, output)
  assert.deepEqual(await readFile(join(output, 'brand.png')), bytes)
})

test('a missing declared icon fails image export instead of shipping a broken plugin row', async (t) => {
  const { source, output } = await fixture(t, { icon: './icon.svg' })
  await assert.rejects(copyRuntimePackage(source, output), { code: 'ENOENT' })
})

test('a declared icon cannot copy a file outside the source package', async (t) => {
  const { source, output } = await fixture(t, { icon: '../private.txt' })
  await writeFile(join(source, '../private.txt'), 'not a package asset')
  await assert.rejects(copyRuntimePackage(source, output), /must stay in its package/u)
})

test('bundle patch declarations retain nested preset files for native profile boot', async (t) => {
  const { source, output } = await fixture(t, { files: ['cordis.patch.yml', 'presets'], dsh: { bundle: { patch: ['./cordis.patch.yml', './presets/standard.patch.yml'] } } })
  await mkdir(join(source, 'presets'))
  await writeFile(join(source, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(source, 'presets/standard.patch.yml'), '- insert: []\n')
  await copyRuntimePackage(source, output)
  assert.equal(await readFile(join(output, 'presets/standard.patch.yml'), 'utf8'), '- insert: []\n')
})

test('a missing declared bundle patch rejects an incomplete native profile image', async (t) => {
  const { source, output } = await fixture(t, { dsh: { bundle: { patch: './presets/standard.patch.yml' } } })
  await assert.rejects(copyRuntimePackage(source, output), { code: 'ENOENT' })
})

test('a bundle patch declaration cannot export a file outside its package', async (t) => {
  const { source, output } = await fixture(t, { dsh: { bundle: { patch: '../private.yml' } } })
  await writeFile(join(source, '../private.yml'), '[]\n')
  await assert.rejects(copyRuntimePackage(source, output), /must stay in its package/u)
})

test('every patch declared by the official web bundle survives runtime export', async (t) => {
  const source = fileURLToPath(new URL('../../../packages/bundle/web-app/', import.meta.url))
  const output = await mkdtemp(join(tmpdir(), 'pe-native-web-patches-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  await copyRuntimePackage(source, output)
  assert.ok(manifest.dsh.bundle.patch.includes('./presets/standard.patch.yml'))
  for (const path of manifest.dsh.bundle.patch) assert.deepEqual(await readFile(join(output, path)), await readFile(join(source, path)))
})

test('npm files globs and nested ignore rules select templates without running package hooks', async (t) => {
  const { source, output } = await fixture(t, { files: ['templates/**/*.txt'], scripts: { prepack: 'node -e "require(\'fs\').writeFileSync(\'hook-ran\',\'yes\')"' } })
  await mkdir(join(source, 'templates'), { recursive: true })
  await writeFile(join(source, 'templates/keep.txt'), 'public template')
  await writeFile(join(source, 'templates/private.txt'), 'excluded template')
  await writeFile(join(source, 'templates/.npmignore'), 'private.txt\n')
  await copyRuntimePackage(source, output)
  assert.equal(await readFile(join(output, 'templates/keep.txt'), 'utf8'), 'public template')
  await assert.rejects(readFile(join(output, 'templates/private.txt')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(source, 'hook-ran')), { code: 'ENOENT' })
})

test('npm defaults apply to profiles without an explicit files list', async (t) => {
  const { source, output } = await fixture(t, { files: undefined })
  await writeFile(join(source, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(source, 'private.txt'), 'excluded')
  await writeFile(join(source, '.npmignore'), 'private.txt\n')
  await copyRuntimePackage(source, output)
  assert.equal(await readFile(join(output, 'cordis.patch.yml'), 'utf8'), '[]\n')
  await assert.rejects(readFile(join(output, 'private.txt')), { code: 'ENOENT' })
})

test('files declarations reject package traversal before copying', async (t) => {
  const { source, output } = await fixture(t, { files: ['../private.txt'] })
  await writeFile(join(source, '../private.txt'), 'outside')
  await assert.rejects(copyRuntimePackage(source, output), /must stay in its package/u)
})

test('declared resource directories cannot escape through a symlink', async (t) => {
  const { source, output } = await fixture(t, { files: ['templates'] })
  await mkdir(join(source, '../private'))
  await writeFile(join(source, '../private/key.txt'), 'outside')
  await symlink('../private', join(source, 'templates'))
  await assert.rejects(copyRuntimePackage(source, output), /symlink escapes/u)
})

test('runtime dependency links are retained without copying their external targets', async (t) => {
  const { source, output } = await fixture(t, { files: [] })
  await mkdir(join(source, 'node_modules'))
  await mkdir(join(source, '../dependency'))
  await symlink('../../dependency', join(source, 'node_modules/runtime-dependency'))
  await copyRuntimePackage(source, output)
  assert.equal(await readlink(join(output, 'node_modules/runtime-dependency')), '../../dependency')
  assert.deepEqual((await readdir(output)).sort(), ['node_modules', 'package.json'])
})

test('official package display declarations survive the runtime export', async (t) => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'pe-native-display-export-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifests = globSync('packages/*/*/package.json', { cwd: repository }).sort()
  let packages = 0, icons = 0
  for (const relative of manifests) {
    const directory = join(repository, relative.slice(0, -'/package.json'.length))
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (!manifest.icon && !Object.keys(manifest.exports ?? {}).some(key => key.includes('/locale/'))) continue
    const source = join(root, 'source', manifest.name), output = join(root, 'runtime', manifest.name)
    await mkdir(source, { recursive: true })
    await cp(join(directory, 'package.json'), join(source, 'package.json'))
    await cp(join(directory, 'locale'), join(source, 'locale'), { recursive: true })
    if (manifest.icon) {
      await cp(join(directory, manifest.icon), join(source, manifest.icon))
      icons += 1
    }
    const bundlePatches = manifest.dsh?.bundle?.patch
    for (const patch of typeof bundlePatches === 'string' ? [bundlePatches] : bundlePatches ?? []) {
      await mkdir(dirname(join(source, patch)), { recursive: true })
      await cp(join(directory, patch), join(source, patch))
    }
    await copyRuntimePackage(source, output)
    const locales = (await readdir(join(directory, 'locale'))).filter(name => name.endsWith('.json'))
    assert.ok(locales.includes('en.json'), manifest.name + ' exports its English display resource')
    for (const locale of locales) assert.deepEqual(await readFile(join(output, 'locale', locale)),
      await readFile(join(directory, 'locale', locale)))
    if (manifest.icon) assert.deepEqual(await readFile(join(output, manifest.icon)), await readFile(join(directory, manifest.icon)))
    packages += 1
  }
  assert.ok(packages >= 16, 'every baseline package declaring locale resources is exercised')
  assert.ok(icons >= 5, 'every baseline package declaring an icon is exercised')
})
