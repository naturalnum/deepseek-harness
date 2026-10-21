/** Fixed native receipt decoding; these synthetic bytes do not establish kernel directory or fsync results. */
import { expect, it } from 'vitest'
import { parseProjectMetadataFrame } from '../src/worker-protocol.ts'

const root = { rootPath: '/project', rootDevice: '11', rootInode: '21', rootMountId: '31' }
function frame(created = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(96), view = new DataView(bytes.buffer)
  bytes.set([68, 80, 77, 49, 1, created ? 2 : 1, created ? 127 : 31])
  view.setUint32(12, 2000, true); view.setUint32(16, 2000, true); view.setUint32(20, 0o40700, true)
  for (const [offset, value] of [[24, 11], [32, 21], [40, 31], [48, 11], [56, 41], [64, 31]]) {
    view.setBigUint64(offset!, BigInt(value!), true)
  }
  return bytes
}

it.each([false, true])('accepts only durable closed identities for an existing/created directory: %s', (created) => {
  const facts = parseProjectMetadataFrame(frame(created), root, 2000, 2000)
  expect(facts).toMatchObject({ outcome: created ? 'created' : 'existing', closed: true, created,
    directorySynced: true, parentSynced: true, directory: { device: '11', inode: '41', mountId: '31', mode: 0o40700 } })
  expect(Object.isFrozen(facts?.directory)).toBe(true)
})

it('keeps a genuinely unknown or unclosed receipt distinct from a definite no-preparation result', () => {
  const known = frame(), data = new DataView(known.buffer)
  known[5] = 3; known[6] = 3; data.setUint32(8, 28, true)
  expect(parseProjectMetadataFrame(known, root, 2000, 2000)).toMatchObject({ outcome: 'not-prepared', errno: 28, closed: true })
  known[6] = 99
  expect(parseProjectMetadataFrame(known, root, 2000, 2000)).toBeUndefined()
  const unknown = frame(true)
  unknown[5] = 4; unknown[6] = 126; new DataView(unknown.buffer).setUint32(8, 5, true)
  expect(parseProjectMetadataFrame(unknown, root, 2000, 2000)).toMatchObject({ outcome: 'unknown', closed: false, created: true })
})

it('refuses contradictory flags, identities, permissions, capabilities, reserved bytes and pooled frames', () => {
  for (const change of ['uid', 'mode', 'mount', 'root', 'sync', 'close', 'flags', 'reserved', 'version']) {
    const bytes = frame(), data = new DataView(bytes.buffer)
    if (change === 'uid') data.setUint32(12, 0, true)
    else if (change === 'mode') data.setUint32(20, 0o40777, true)
    else if (change === 'mount') data.setBigUint64(64, 99n, true)
    else if (change === 'root') data.setBigUint64(32, 22n, true)
    else if (change === 'sync') bytes[6] = 7
    else if (change === 'close') bytes[6] = 30
    else if (change === 'flags') bytes[6] = 255
    else if (change === 'reserved') bytes[95] = 1
    else bytes[4] = 2
    expect(parseProjectMetadataFrame(bytes, root, 2000, 2000)).toBeUndefined()
  }
  expect(parseProjectMetadataFrame(new Uint8Array(97).subarray(0, 96), root, 2000, 2000)).toBeUndefined()
  expect(parseProjectMetadataFrame(frame().subarray(0, 95), root, 2000, 2000)).toBeUndefined()
})
