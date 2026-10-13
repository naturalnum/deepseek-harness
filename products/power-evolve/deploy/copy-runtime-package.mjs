/** Export npm-selected package files while retaining runtime dependency links. */
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function packagePath(directory, value, kind) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.split(/[\\/]/u).includes('..')) throw new Error('Package ' + kind + ' must stay in its package: ' + directory)
  const path = relative(resolve(directory), resolve(directory, value))
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('Package ' + kind + ' must stay in its package: ' + directory)
  return path
}

async function rejectEscapingLinks(path, root) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    const target = relative(root, await realpath(path))
    if (target === '..' || target.startsWith('..' + sep) || isAbsolute(target)) throw new Error('Package resource symlink escapes its package: ' + path)
    return
  }
  if (info.isDirectory()) {
    for (const name of await readdir(path)) {
      if (path === root && name === 'node_modules') continue
      await rejectEscapingLinks(join(path, name), root)
    }
  }
}

async function packageFiles(directory) {
  const temporary = await mkdtemp(join(tmpdir(), 'pe-npm-pack-list-'))
  try {
    const emptyConfig = join(temporary, 'npmrc')
    const globalConfig = join(temporary, 'global-npmrc')
    await writeFile(emptyConfig, '')
    await writeFile(globalConfig, '')
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--workspaces=false',
      '--userconfig', emptyConfig, '--globalconfig', globalConfig, '--cache', join(temporary, 'cache')], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary },
    })
    if (packed.error) throw packed.error
    if (packed.status !== 0) throw new Error('npm package file selection failed: ' + directory + '\n' + packed.stderr)
    const result = JSON.parse(packed.stdout)
    if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) throw new Error('npm must select exactly one package: ' + directory)
    return result[0].files.map(file => packagePath(directory, file.path, 'packed file'))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Copy npm's public file selection and the existing dependency links into an empty image directory.
 * @param directory Source package with a built runtime and package manifest.
 * @param destination Empty owned output directory; package resources may not escape through symlinks.
 * @returns Copied package-relative files plus node_modules when present; lifecycle hooks never run.
 */
export async function copyRuntimePackage(directory, destination) {
  const source = await realpath(directory)
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (manifest.files !== undefined && (!Array.isArray(manifest.files) || !manifest.files.every(value => typeof value === 'string' && value.length > 0))) throw new Error('Runtime package files must be a list of patterns: ' + source)
  if (manifest.files === undefined) await rejectEscapingLinks(source, source)
  for (const declaration of manifest.files ?? []) {
    const pattern = declaration.replace(/^!/u, '')
    // npm owns glob and ignore semantics; the image exporter rejects paths and symlink roots that could leave the package.
    if (pattern !== '.' && pattern !== './') packagePath(source, pattern, 'files declaration')
    const parts = pattern.split(/[\\/]/u)
    const staticParts = []
    for (const part of parts) {
      if (/[*?{[()]/u.test(part)) break
      staticParts.push(part)
    }
    const prefix = staticParts.length === 0 ? source : resolve(source, ...staticParts)
    try { await lstat(prefix) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    await rejectEscapingLinks(prefix, source)
  }
  const selected = new Set(await packageFiles(source))
  const declared = []
  if (manifest.icon !== undefined) declared.push([manifest.icon, 'icon'])
  const bundlePatches = manifest.dsh?.bundle?.patch
  if (bundlePatches !== undefined) {
    const patches = typeof bundlePatches === 'string' ? [bundlePatches] : bundlePatches
    if (!Array.isArray(patches)) throw new Error('Package bundle patches must be a file path or a list: ' + source)
    for (const patch of patches) declared.push([patch, 'bundle patch'])
  }
  for (const [value, kind] of declared) {
    const path = packagePath(source, value, kind)
    if (!(await lstat(join(source, path))).isFile()) throw new Error('Package ' + kind + ' must be a regular file: ' + source)
    if (!selected.has(path)) throw new Error('Package ' + kind + ' is excluded from its public files: ' + source)
  }
  for (const path of selected) {
    if (path.startsWith('node_modules' + sep)) continue
    const target = relative(source, await realpath(join(source, path)))
    if (target === '..' || target.startsWith('..' + sep) || isAbsolute(target)) throw new Error('Packed file escapes its package: ' + path)
    if (!(await lstat(join(source, path))).isFile()) throw new Error('Packed resource must be a regular file: ' + path)
  }
  await mkdir(destination, { recursive: true })
  if ((await lstat(destination)).isSymbolicLink() || (await readdir(destination)).length !== 0) throw new Error('Runtime destination must be an empty owned directory: ' + destination)
  for (const path of selected) {
    if (path.startsWith('node_modules' + sep)) continue
    await mkdir(dirname(join(destination, path)), { recursive: true })
    await cp(join(source, path), join(destination, path), { dereference: false, verbatimSymlinks: true })
  }
  if ((await readdir(source)).includes('node_modules')) {
    await cp(join(source, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true })
    selected.add('node_modules')
  }
  return [...selected].sort()
}
