/** Verify complete report ownership and the production package's resource selection. */
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectProductPaths } from '../bundle.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const inventory = JSON.parse(await readFile(new URL('./report-assets.json', import.meta.url), 'utf8'))
const files = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    const path = resolve(directory, entry.name)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Report assets must not contain links: ' + path)
    if (entry.isDirectory()) await walk(path)
    else files.push(relative(root, path).split('\\').join('/'))
  }
}
await walk(resolve(root, inventory.assetRoot))
if (files.length !== inventory.files.length || new Set(inventory.files.map(row => row.path)).size !== files.length) {
  throw new Error('Report asset inventory is incomplete or contains duplicate entries')
}
const expected = new Set(files)
for (const row of inventory.files) {
  if (!expected.has(row.path)) throw new Error('Missing report resource: ' + row.path)
  const bytes = await readFile(resolve(root, row.path))
  if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
    throw new Error('Report resource changed: ' + row.path)
  }
}
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
const products = new Set(await collectProductPaths(root, tracked))
for (const path of files) if (!products.has(path)) throw new Error('Product delivery omits report resource: ' + path)
try { await lstat(resolve(root, inventory.sourceRoot)); throw new Error('Old report asset root still exists') }
catch (error) { if (error.code !== 'ENOENT') throw error }
console.info(`Report content: ${files.length} original files, exact bytes and complete product delivery verified.`)
