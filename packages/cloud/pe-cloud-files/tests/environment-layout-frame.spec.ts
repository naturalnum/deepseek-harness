/** Synthetic fixed receipts test decoding only; Linux directory and durability evidence remains separate. */
import { expect, it } from 'vitest'
import { parseEnvironmentLayoutFrame } from '../src/worker-protocol.ts'

const root = { rootPath: '/environment', rootDevice: '11', rootInode: '2', rootMountId: '31' }
function frame(created = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer)
  bytes.set([68, 69, 76, 49, 1, created ? 2 : 1, 3])
  view.setBigUint64(24, 11n, true); view.setBigUint64(32, 2n, true); view.setBigUint64(40, 31n, true)
  for (let index = 0; index < 3; index++) {
    const offset = 48 + index * 64
    bytes[offset] = created ? 31 : 13
    view.setUint32(offset + 4, 2000, true); view.setUint32(offset + 8, 2000, true)
    view.setUint32(offset + 12, 0o40700, true)
    view.setBigUint64(offset + 16, 11n, true); view.setBigUint64(offset + 24, BigInt(index + 4), true)
    view.setBigUint64(offset + 32, 31n, true)
  }
  return bytes
}

it.each([false, true])('decodes fixed durable home/venv/tmp identities with creation=%s', (created) => {
  const result = parseEnvironmentLayoutFrame(frame(created), root, 2000, 2000)
  expect(result).toMatchObject({ outcome: created ? 'created' : 'existing', createdMask: created ? 7 : 0, closed: true,
    layout: { home: { inode: '4' }, venv: { inode: '5' }, tmp: { inode: '6' } } })
  expect(Object.isFrozen(result?.layout)).toBe(true)
  expect(Object.isFrozen(result?.layout.venv)).toBe(true)
})

it('distinguishes definite refusal, partial creation and unclosed outcomes', () => {
  const bytes = frame(), view = new DataView(bytes.buffer)
  bytes.fill(0, 48); bytes[5] = 3; view.setUint32(8, 28, true)
  expect(parseEnvironmentLayoutFrame(bytes, root, 2000, 2000)).toMatchObject({ outcome: 'not-prepared', errno: 28 })
  bytes[48] = 18
  expect(parseEnvironmentLayoutFrame(bytes, root, 2000, 2000)).toBeUndefined()
  bytes[5] = 4; bytes[6] = 2
  expect(parseEnvironmentLayoutFrame(bytes, root, 2000, 2000)).toMatchObject({ outcome: 'unknown', closed: false, createdMask: 1 })
})

it('rejects wrong owners, modes, domains, aliases, sync facts and unbounded or incompatible frames', () => {
  for (let index = 0; index < 3; index++) {
    for (const change of ['uid', 'gid', 'mode', 'device', 'mount', 'alias', 'sync', 'created', 'reserved']) {
      const bytes = frame(), view = new DataView(bytes.buffer), offset = 48 + index * 64
      if (change === 'uid') view.setUint32(offset + 4, 0, true)
      else if (change === 'gid') view.setUint32(offset + 8, 0, true)
      else if (change === 'mode') view.setUint32(offset + 12, 0o40755, true)
      else if (change === 'device') view.setBigUint64(offset + 16, 12n, true)
      else if (change === 'mount') view.setBigUint64(offset + 32, 32n, true)
      else if (change === 'alias') view.setBigUint64(offset + 24, 2n, true)
      else if (change === 'sync') bytes[offset] = 1
      else if (change === 'created') bytes[offset] = 15
      else bytes[offset + 63] = 1
      expect(parseEnvironmentLayoutFrame(bytes, root, 2000, 2000)).toBeUndefined()
    }
  }
  for (const offset of [0, 4, 6, 7, 12, 24, 240]) {
    const bytes = frame(); bytes[offset] = 255
    expect(parseEnvironmentLayoutFrame(bytes, root, 2000, 2000)).toBeUndefined()
  }
  const duplicate = frame(); new DataView(duplicate.buffer).setBigUint64(136, 4n, true)
  expect(parseEnvironmentLayoutFrame(duplicate, root, 2000, 2000)).toBeUndefined()
  expect(parseEnvironmentLayoutFrame(new Uint8Array(257).subarray(0, 256), root, 2000, 2000)).toBeUndefined()
  expect(parseEnvironmentLayoutFrame(frame().subarray(0, 255), root, 2000, 2000)).toBeUndefined()
})
