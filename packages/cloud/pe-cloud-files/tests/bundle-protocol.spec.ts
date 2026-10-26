/** Production frame decoder refuses incomplete closure, impossible inventory and incompatible copy reuse facts. */
import { expect, it } from 'vitest'
import { parseBundleFrame } from '../src/bundle-native.ts'
import type { FdBundleRequest } from '../src/bundle-native.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { limits } from './fixtures/bundle-limits.ts'

function request(kind: FdBundleRequest['kind']): Omit<FdBundleRequest, 'id' | 'cancel'> {
  return { kind, root: { rootPath: '/isolated', rootDevice: '1', rootInode: '2', rootMountId: '3' }, uid: 2000, gid: 2000,
    version: brandString<FdBundleRequest['version']>('11111111-1111-4111-8111-111111111111'), tree: { directories: [],
      files: [{ relativePath: 'SKILL.md', data: Uint8Array.of(1) }] }, metadata: null, expectedCopyInode: '0', retained: [],
    revision: '', limits, storage: { maxVersions: 8, maxTotalBytes: 1048576, maxTotalInodes: 128, maxFileBytes: 4096,
      reservationBytes: limits.reservationBytes } }
}
function frame(kind: FdBundleRequest['kind']): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array(128), f = new DataView(raw.buffer)
  f.setUint32(0, kind === 'bundle-prepare' ? 0x44534231 : kind === 'bundle-project' ? 0x44425031 : 0x44425231, false)
  raw[4] = 1; raw[5] = 1; raw[6] = 7
  f.setUint32(12, 1, true); f.setBigUint64(16, BigInt(2 * limits.maxCatalogBytes + 1), true)
  f.setBigUint64(24, 5n, true); f.setBigUint64(32, 1n, true); f.setBigUint64(40, 2n, true); f.setBigUint64(48, 3n, true)
  if (kind === 'bundle-reclaim') f.setUint32(80, 1, true)
  else { f.setBigUint64(56, 1n, true); f.setBigUint64(64, 4n, true); f.setBigUint64(72, 3n, true) }
  return raw
}

it.each(['bundle-prepare', 'bundle-project', 'bundle-reclaim'] as const)('accepts complete %s frames without assuming three inodes per version', (kind) => {
  expect(parseBundleFrame(frame(kind), request(kind))).toMatchObject({ outcome: 'complete', closed: true, versions: 1,
    chargedInodes: 5 })
})

it.each(['closure', 'extra', 'too-few-inodes', 'wrong-root', 'too-many-removed'] as const)(
  'refuses contradictory %s facts before granting authority', (kind) => {
    const op = kind === 'too-many-removed' ? 'bundle-reclaim' : 'bundle-prepare', raw = frame(op), f = new DataView(raw.buffer)
    if (kind === 'closure') raw[6] = 6
    else if (kind === 'extra') raw[84] = 1
    else if (kind === 'too-few-inodes') f.setBigUint64(24, 3n, true)
    else if (kind === 'wrong-root') f.setBigUint64(48, 99n, true)
    else f.setUint32(80, 8, true)
    expect(parseBundleFrame(raw, request(op))).toBeUndefined()
  },
)

it('requires the exact preexisting copy inode and preserves closed unknown as unknown', () => {
  const raw = frame('bundle-project'), expected = { ...request('bundle-project'), expectedCopyInode: '4' }
  raw[6] = 11
  expect(parseBundleFrame(raw, expected)).toMatchObject({ outcome: 'complete', reused: true })
  expect(parseBundleFrame(raw, { ...expected, expectedCopyInode: '5' })).toBeUndefined()
  raw[5] = 3; raw[6] = 5; new DataView(raw.buffer).setUint32(8, 5, true)
  expect(parseBundleFrame(raw, expected)).toMatchObject({ outcome: 'unknown', closed: true })
})
