/** Copy package runtime files and display resources into the Linux image. */
import { cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const runtimeEntries = new Set(['package.json', 'node_modules', 'lib', 'dist', 'assets', 'web', 'bin',
  'cordis.patch.yml', 'cordis.yml', 'icon.svg', 'locale'])

/** Preserve plugin icons and localized metadata alongside their runtime exports.
 * @param directory Source package directory containing its manifest.
 * @param destination Owned image output directory for this package.
 * @returns Copied package-relative paths; missing declared icons reject image export.
 */
export async function copyRuntimePackage(directory, destination) {
  const entries = await readdir(directory)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const selected = new Set(entries.filter(name => runtimeEntries.has(name)))
  if (manifest.icon !== undefined) {
    if (typeof manifest.icon !== 'string' || isAbsolute(manifest.icon)) throw new Error('Package icon must be relative: ' + directory)
    const path = relative(resolve(directory), resolve(directory, manifest.icon))
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('Package icon must stay in its package: ' + directory)
    if (!(await lstat(join(directory, path))).isFile()) throw new Error('Package icon must be a regular file: ' + directory)
    selected.add(path)
  }
  await mkdir(destination, { recursive: true })
  for (const name of selected) await cp(join(directory, name), join(destination, name), {
    recursive: true, dereference: false, verbatimSymlinks: true,
  })
  return [...selected].sort()
}
