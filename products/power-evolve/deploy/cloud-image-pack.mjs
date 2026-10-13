/** Export Linux-built dependencies and explicit runtime files without shipping builder source or Desktop applications. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { copyRuntimePackage } from './copy-runtime-package.mjs'
const target = '/runtime'
await mkdir(target, { recursive: true })
async function copy(path) { await cp(path, join(target, path), { recursive: true, dereference: false, verbatimSymlinks: true }) }
for (const file of ['package.json', 'node_modules', 'image-source.json', 'image-build.json']) await copy(file)
const roots = ['vendor', 'packages', 'native/system/packages', 'apps', 'products/power-evolve']
for (const prefix of roots) {
  const directories = prefix === 'packages'
    ? (await Promise.all((await readdir(prefix, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(async group =>
      (await readdir(join(prefix, group.name), { withFileTypes: true })).filter(entry => entry.isDirectory())
        .map(entry => join(prefix, group.name, entry.name))))).flat()
    : (await readdir(prefix, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(prefix, entry.name))
  for (const directory of directories) {
    if (prefix === 'apps' && directory !== 'apps/cli' && directory !== 'apps/web') continue
    if (directory === 'products/power-evolve/application') continue
    let files
    try { files = await readdir(directory) } catch (error) { if (error.code === 'ENOTDIR') continue; throw error }
    if (!files.includes('package.json')) continue
    await copyRuntimePackage(directory, join(target, directory))
  }
}
await mkdir(join(target, 'products/power-evolve/deploy'), { recursive: true })
for (const name of ['start.mjs', 'lifecycle.mjs', 'backup.mjs', 'backup-tree.mjs', 'backup-postgres.mjs']) await copy('products/power-evolve/deploy/' + name)
for (const name of ['cloud-capture.mjs', 'cloud-coverage.mjs']) await copy('products/power-evolve/scripts/' + name)
const application = 'products/power-evolve/application'
const packDirectory = '/build/.image-packs/application'
await mkdir(packDirectory, { recursive: true })
const packed = spawnSync('pnpm', ['--dir', application, 'pack', '--pack-destination', packDirectory], { stdio: 'inherit' })
if (packed.error || packed.status !== 0) throw new Error('Application package export failed')
const archives = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'))
if (archives.length !== 1) throw new Error('Application package export must produce one archive')
const archive = join(packDirectory, archives[0])
const applicationTarget = join(target, application)
await mkdir(applicationTarget, { recursive: true })
const extracted = spawnSync('tar', ['-xf', archive, '--strip-components=1', '-C', applicationTarget], { stdio: 'inherit' })
if (extracted.error || extracted.status !== 0) throw new Error('Application package extraction failed')
await copy(application + '/node_modules')
const { CURRENT_SCHEMA_VERSION } = await import(
  pathToFileURL(join(applicationTarget, 'lib/platform/database.js')).href,
)
const schemaAssets = Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1)
  .flatMap(version => [`assets/cloud-schema-v${version}.sql`, `assets/cloud-schema-v${version}.manifest.json`])
for (const asset of [...schemaAssets, 'src/platform/safe-posix.py']) {
  if (!(await lstat(join(applicationTarget, asset))).isFile()) throw new Error('Application package is missing required runtime file: ' + asset)
}
const { BuiltinSkillCatalog } = await import(pathToFileURL(join(applicationTarget, 'lib/platform/builtin-skills.js')).href)
const builtinCatalog = new BuiltinSkillCatalog(undefined, ['builtin.pdf'])
const builtinReleases = await builtinCatalog.list()
if (builtinReleases.length !== 1 || builtinReleases[0].id !== 'builtin.pdf'
  || await builtinCatalog.get('builtin.pdf', builtinReleases[0].version) === null) throw new Error('Application package is missing the verified PDF Skill release')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const profileEntries = {}
const patchSchema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
for (const role of ['host', 'platform']) {
  const consumer = createRequire(join(target, 'products/power-evolve', role, 'package.json'))
  const patch = load(await readFile('products/power-evolve/' + role + '/cordis.patch.yml', 'utf8'), { schema: patchSchema })
  const entries = [...new Set(patch.flatMap(row => row.insert ?? []).map(row => row.name))]
  for (const entry of entries) await import(pathToFileURL(consumer.resolve(entry)).href)
  profileEntries[role] = entries
}
const queryExports = ['@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-format-catalog', '@deepseek-ai/dsh-session-format-catalog/message-projections']
const applicationConsumer = createRequire(join(applicationTarget, 'package.json'))
for (const entry of queryExports) await import(pathToFileURL(applicationConsumer.resolve(entry)).href)
await writeFile(join(target, 'image-pack.json'), JSON.stringify({
  applicationManifestSha256: digest(await readFile(application + '/package.json')),
  applicationArchiveSha256: digest(await readFile(archive)), schemaVersion: CURRENT_SCHEMA_VERSION,
  builtinPdfArchiveSha256: builtinReleases[0].archiveDigest,
  profileEntries, queryExports,
}) + '\n')
for (const path of ['apps/cli/lib/bin.js', 'products/power-evolve/application/lib/platform/index.js',
  'products/power-evolve/cloud-web/dist/index.html', 'native/system/packages/linux-' + process.arch + '/bin/glibc/system.node']) {
  if (!(await lstat(join(target, path))).isFile()) throw new Error('Missing cold runtime artifact: ' + path)
}
