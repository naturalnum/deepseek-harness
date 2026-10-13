/** Destroy only the registered fixture storage contents after its containers and Kind nodes are gone. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { chown, lstat, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function privateJson(file, allowedUid, maximum) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    assert(before.isFile() && before.nlink === 1 && allowedUid.includes(before.uid)
      && (before.mode & 0o777) === 0o600 && before.size <= maximum)
    const bytes = await handle.readFile(), after = await handle.stat()
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(bytes.length, before.size)
    return JSON.parse(bytes.toString('utf8'))
  } finally { await handle.close() }
}

/** Delete only this UUID owner's storage children; disposal facts never qualify a source writer stop.
 * @param options Exact readonly request file and the single UUID-owned writable output mount.
 * @returns Secret-free disposal facts after the original directory inode and ownership remain unchanged.
 */
export async function cleanupOwnedSchema37Storage(options) {
  const { requestFile, markerFile, storageRoot, outRoot } = options
  assert.equal(process.getuid(), 0, 'Owned source storage destruction requires its privileged helper')
  assert.equal(outRoot, '/pe-ci-cleanup/out')
  assert.equal(storageRoot, '/pe-ci-cleanup/out/storage')
  assert.equal(markerFile, '/pe-ci-cleanup/out/owner.json')
  assert.equal(requestFile, '/pe-ci-cleanup/request.json')
  const markerInfo = await lstat(markerFile)
  assert(markerInfo.isFile() && !markerInfo.isSymbolicLink())
  const request = await privateJson(requestFile, [0, markerInfo.uid], 65536)
  assert.equal(request.format, 'power-evolve-owned-storage-disposal')
  assert.match(request.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  assert(Number.isSafeInteger(request.hostUid) && request.hostUid > 0)
  assert(Number.isSafeInteger(request.hostGid) && request.hostGid >= 0)
  assert.equal(request.hostUid, markerInfo.uid)
  assert(isAbsolute(request.hostOut) && basename(request.hostOut) === 'pe-ci-built-' + request.owner)
  const marker = await privateJson(markerFile, [request.hostUid], 4096)
  assert.deepEqual(marker, { format: 1, owner: request.owner })
  const holder = await lstat(outRoot, { bigint: true })
  assert(holder.isDirectory() && !holder.isSymbolicLink()); assert.equal(await realpath(outRoot), outRoot)
  assert.deepEqual({ dev: holder.dev.toString(), ino: holder.ino.toString(), uid: Number(holder.uid),
    gid: Number(holder.gid), mode: Number(holder.mode & 0o777n) }, request.outIdentity)
  assert.equal(Number(holder.uid), request.hostUid); assert.equal(Number(holder.gid), request.hostGid)
  assert.equal(Number(holder.mode & 0o777n), 0o700)
  assert.equal(request.purpose, 'destruction-only-not-writer-qualification')
  for (const container of request.containers) {
    assert(['bootstrap', 'stdio', 'resolution', 'seal'].some(role =>
      container.name === 'pe-ci-producer-' + role + '-' + request.owner))
    assert.equal(container.gone, true, 'Owned fixture container remains active or unresolved')
    if (container.id !== null) assert.match(container.id, /^[a-f0-9]{64}$/u)
  }
  assert.equal(request.cluster.name, 'pe-ci-' + request.owner.slice(0, 18))
  assert.equal(request.cluster.gone, true, 'Owned Kind cluster remains active or unresolved')
  for (const id of request.cluster.nodeIds) assert.match(id, /^[a-f0-9]{64}$/u)
  const before = await lstat(storageRoot, { bigint: true })
  assert(before.isDirectory() && !before.isSymbolicLink())
  assert.equal(await realpath(storageRoot), storageRoot)
  assert.deepEqual({ dev: before.dev.toString(), ino: before.ino.toString(), uid: Number(before.uid),
    gid: Number(before.gid), mode: Number(before.mode & 0o777n) }, request.storageIdentity)
  assert.equal(Number(before.uid), request.hostUid); assert.equal(Number(before.gid), request.hostGid)
  assert.equal(Number(before.mode & 0o777n), 0o700)
  const children = await readdir(storageRoot)
  assert(children.every(name => name === 'shared'), 'Fixture storage has an unexpected top-level entry')
  for (const name of children) await rm(join(storageRoot, name), { recursive: true, force: false })
  assert.deepEqual(await readdir(storageRoot), [])
  const after = await lstat(storageRoot, { bigint: true })
  assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino)
  assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid); assert.equal(after.mode, before.mode)
  async function returnPrivateHolderOwnership(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === outRoot && ['storage', 'context', 'bin', 'parameters'].includes(entry.name)) continue
      const file = join(directory, entry.name), info = await lstat(file)
      if (info.isSymbolicLink()) continue
      if (directory === join(outRoot, 'cohort') && entry.name === 'detached-files') {
        await chown(file, request.hostUid, request.hostGid)
        continue
      }
      assert(info.isFile() || info.isDirectory())
      if (info.isDirectory()) await returnPrivateHolderOwnership(file)
      await chown(file, request.hostUid, request.hostGid)
    }
  }
  await returnPrivateHolderOwnership(outRoot)
  return { owner: request.owner, removedStorageChildren: children.length, storageRootRetained: true,
    originalStorageMetadataRewritten: false, usedAsWriterStopQualification: false,
    privateEvidenceBytesAndModesUnchanged: true, detachedPayloadOwnersPreserved: true }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2)
  const result = await cleanupOwnedSchema37Storage({ requestFile: '/pe-ci-cleanup/request.json',
    markerFile: '/pe-ci-cleanup/out/owner.json', storageRoot: '/pe-ci-cleanup/out/storage', outRoot: '/pe-ci-cleanup/out' })
  console.log(JSON.stringify(result))
}
