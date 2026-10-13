/** Image export preserves the resources read by native plugin metadata. */
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { copyRuntimePackage } from './copy-runtime-package.mjs'

async function fixture(t, manifest) {
  const root = await mkdtemp(join(tmpdir(), 'pe-package-display-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), output = join(root, 'runtime')
  await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@test/plugin', ...manifest }))
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
  const { source, output } = await fixture(t, { icon: './brand.png' })
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
