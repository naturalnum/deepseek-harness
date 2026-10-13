/** Create and remove only a UUID-owned CI private input directory; external cohort and evidence paths are excluded. */
import assert from 'node:assert/strict'
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function ownedLocation({ out, owner, runnerTemp }) {
  assert.equal(typeof process.getuid, 'function', 'Private input ownership requires a POSIX UID')
  assert.match(owner, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert(isAbsolute(out) && isAbsolute(runnerTemp), 'Owned cleanup paths must be absolute')
  const expected = join(resolve(runnerTemp), 'pe-ci-built-' + owner)
  assert.equal(out, expected, 'Private input path differs from its exact CI owner path')
  const parent = await realpath(runnerTemp)
  assert.equal(await realpath(dirname(out)), parent, 'Private input parent differs from runner temp')
  return { parent, marker: join(out, 'owner.json') }
}

/** Validate the exact private directory and owner marker before assembly or deletion.
 * @param options Absolute out/runnerTemp paths, UUID owner and optional empty-directory requirement.
 * @returns {Promise<void>} Resolves only for an owned, nonsymlink 0700 directory and matching 0600 marker.
 */
export async function assertOwnedBuiltInputDirectory(options) {
  const { out, owner, empty = false } = options
  const { parent, marker } = await ownedLocation(options)
  const info = await lstat(out)
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o777) === 0o700, 'Private input directory owner or mode differs')
  assert.equal(await realpath(out), join(parent, 'pe-ci-built-' + owner), 'Private input directory resolves outside its owner path')
  const markerInfo = await lstat(marker)
  assert(markerInfo.isFile() && !markerInfo.isSymbolicLink() && markerInfo.uid === process.getuid()
    && (markerInfo.mode & 0o777) === 0o600 && markerInfo.size <= 4096, 'Private input owner marker is invalid')
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { format: 1, owner }, 'Private input owner marker differs')
  if (empty) assert.deepEqual(await readdir(out), ['owner.json'], 'Private input directory was already used')
}

async function createOwnedDirectory(options) {
  const { marker } = await ownedLocation(options)
  await mkdir(options.out, { mode: 0o700 })
  const file = await open(marker, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify({ format: 1, owner: options.owner }) + '\n')
    await file.sync()
  } finally { await file.close() }
  await assertOwnedBuiltInputDirectory({ ...options, empty: true })
  return { created: true }
}

async function removeOwnedDirectory(options) {
  await ownedLocation(options)
  let info
  try { info = await lstat(options.out) }
  catch (error) {
    if (error.code === 'ENOENT') return { removed: false, absent: true }
    throw error
  }
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Cleanup refuses an unowned or link-shaped input path')
  await assertOwnedBuiltInputDirectory(options)
  await rm(options.out, { recursive: true, force: false })
  return { removed: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = new Map()
  const allowed = new Set(['--action', '--out', '--owner', '--runner-temp'])
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1]
    assert(allowed.has(key) && value && !flags.has(key), 'Invalid owned input directory argument')
    flags.set(key, value)
  }
  for (const key of allowed) assert(flags.has(key), 'Missing owned input directory argument: ' + key)
  const action = flags.get('--action')
  assert(['create', 'remove'].includes(action), 'Invalid owned input directory action')
  const options = { out: flags.get('--out'), owner: flags.get('--owner'), runnerTemp: flags.get('--runner-temp') }
  console.log(JSON.stringify(await (action === 'create' ? createOwnedDirectory(options) : removeOwnedDirectory(options))))
}
