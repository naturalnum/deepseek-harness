import { describe, expect, it } from 'vitest'
import { parseStaticStoragePlan, parseStorageProbeFrame, staticStorageReservation } from '../src/storage-probe.ts'
import { validateStorageView } from '../src/storage-owner.ts'
import { storageRequest, createStorageWorker } from '../src/storage-worker.ts'
import type { StaticStorageConfig } from '../src/storage-types.ts'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
function domain(index: number) {
  return { rootPath: `/domain-${index}`, rootDevice: `${index}`, rootInode: '2', rootMountId: `${index + 10}`,
    minimumBytes: '4096', maximumBytes: '8192', minimumInodes: '100', maximumInodes: '200',
    backing: { path: `/backing-${index}`, device: '9', inode: `${index + 20}`, bytes: '8192' } }
}
function raw() {
  return { version: 1, recipeVersion: 'static-first-trial', appUid: 1000, appGid: 1000, arenaReserveBytes: '8192',
    arena: domain(1), control: domain(2), accounts: [1, 2].map(index => ({ accountId: `account-${index}`,
      storageKey: `v1-${String(index).repeat(64)}`, accountRoot: `/accounts/v1-${String(index).repeat(64)}`,
      private: domain(2 * index + 1), projects: domain(2 * index + 2) })),
    baseConfigPath: '/app/base.yml', installAnchor: '/app/package.json', auxiliary: [] }
}
const config: StaticStorageConfig = { planPath: '/deployment/plan.json', planSha256: '1'.repeat(64),
  probeHelperPath: '/deployment/storage.node', probeHelperSha256: '2'.repeat(64), maxProbeAssetBytes: 1024,
  maxPlanBytes: 16384, maxMountInfoBytes: 16384, rootProbeReservationBytes: 2_000_000, probeTimeoutMs: 1000 }
const status = ['Uid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1000\t1000', 'Groups:\t1000',
  ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(key => `${key}:\t0000000000000000`),
  'NoNewPrivs:\t1', 'Seccomp:\t2'].join('\n')
const mountInfo = '12 1 8:1 / / ro,relatime - ext4 /dev/loop1 ro\n'
const view = (mounts = mountInfo, processStatus = status) =>
  ({ mountInfo: new TextEncoder().encode(mounts), status: new TextEncoder().encode(processStatus) })
function frame(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256)
  bytes.set([68, 83, 80, 49, 1, 1, 3])
  const data = new DataView(bytes.buffer)
  data.setUint32(24, 1000, true); data.setUint32(28, 1000, true)
  data.setBigUint64(32, 18446744073709551615n, true)
  return bytes
}

describe('static protected record parsing without storage authority', () => {
  it('detaches and freezes exactly two assignments while preserving u64 facts', () => {
    const record = raw()
    record.arena.backing.device = '18446744073709551615'
    const parsed = parseStaticStoragePlan(encode(record), 1024)
    expect(parsed.arena.backing.device).toBe('18446744073709551615')
    expect(parsed.accounts).toHaveLength(2)
    expect(Object.isFrozen(parsed.accounts[0].private.backing)).toBe(true)
    record.accounts[0]!.accountId = 'changed'
    expect(parsed.accounts[0].accountId).toBe('account-1')
  })
  it.each(['ready', 'quotaVerified', 'privileged', 'storageReady'])('rejects unrecognized %s assertions', (key) => {
    expect(() => parseStaticStoragePlan(encode({ ...raw(), [key]: true }), 1024)).toThrow()
  })
  it('rejects malformed nested facts, noncanonical paths, duplicate accounts and unsupported versions', () => {
    const variants = [() => ({ ...raw(), version: 2 }), () => ({ ...raw(), accounts: [] }),
      () => ({ ...raw(), arena: { ...domain(1), rootInode: '3' } }),
      () => ({ ...raw(), arena: { ...domain(1), maximumBytes: '04096' } }),
      () => ({ ...raw(), arena: { ...domain(1), minimumBytes: '9000' } }),
      () => ({ ...raw(), arena: { ...domain(1), rootPath: '/a/../b' } }),
      () => ({ ...raw(), arena: { ...domain(1), rootMountId: '18446744073709551616' } }),
      () => { const value = raw(); value.accounts[1] = value.accounts[0]!; return value }]
    for (const variant of variants) expect(() => parseStaticStoragePlan(encode(variant()), 1024)).toThrow()
    expect(() => parseStaticStoragePlan(new Uint8Array([0xff]), 1024)).toThrow()
  })
  it('reserves asset loading for every original worker and rejects insufficient or unbounded root capacity', () => {
    expect(staticStorageReservation(config, 1024, 2)).toBe(config.rootProbeReservationBytes)
    for (const changed of [{ rootProbeReservationBytes: 1 }, { maxMountInfoBytes: Infinity },
      { probeTimeoutMs: 2147483648 }, { planSha256: 'invalid' }, { probeHelperPath: '/tmp/../probe.node' }]) {
      expect(() => staticStorageReservation({ ...config, ...changed }, 1024, 2)).toThrow()
    }
  })
})

describe('closed-FD storage probe ABI1', () => {
  it('keeps exact u64 quantities without narrowing to JS numbers', () => {
    expect(parseStorageProbeFrame(frame())).toMatchObject({ device: '18446744073709551615', appUid: 1000, flags: 3 })
  })
  it.each([0, 4, 5, 7, 8, 136, 255])('rejects incompatible or reserved byte at %i', (index) => {
    const value = frame(); value[index] = 99
    expect(parseStorageProbeFrame(value)).toBeUndefined()
  })
  it('rejects unknown flags, missing closure, pooled slices and partial buffers', () => {
    const value = frame(); value[6] = 2
    expect(parseStorageProbeFrame(value)).toBeUndefined()
    value[6] = 65
    expect(parseStorageProbeFrame(value)).toBeUndefined()
    expect(parseStorageProbeFrame(new Uint8Array(257).subarray(0, 256))).toBeUndefined()
    expect(parseStorageProbeFrame(value.subarray(0, 255))).toBeUndefined()
  })
})

describe('bounded actual application view requirements', () => {
  const plan = parseStaticStoragePlan(encode(raw()), 1024)
  it('decodes observations without issuing an owner', () => {
    expect(validateStorageView(view(), plan)).toEqual([{ id: '12', path: '/', filesystem: 'ext4', source: '/dev/loop1', writable: false }])
  })
  it.each(['CapEff:\t1', 'CapBnd:\t1', 'NoNewPrivs:\t0', 'Seccomp:\t0', 'Uid:\t0\t0\t0\t0', 'Groups:\t1000\t6'])('rejects %s', (changed) => {
    const key = changed.split(':')[0]!
    const changedStatus = status.split('\n').map(line => line.startsWith(`${key}:`) ? changed : line).join('\n')
    expect(() => validateStorageView(view(mountInfo, changedStatus), plan)).toThrow()
  })
  it('rejects duplicate mount IDs and truncated mount records', () => {
    expect(() => validateStorageView(view(mountInfo + mountInfo), plan)).toThrow()
    expect(() => validateStorageView(view('12 1 8:1 / / ro'), plan)).toThrow()
    expect(() => validateStorageView(view(mountInfo, `${status}\nNoNewPrivs:\t1`), plan)).toThrow()
  })
  it('validates cancellation and canonical root commands at the worker boundary', () => {
    const request = { id: '00000000-0000-0000-0000-000000000001', kind: 'storage-probe', path: '/fixed', cancel: new SharedArrayBuffer(4) }
    expect(storageRequest(request, 1024).kind).toBe('storage-probe')
    for (const changed of [{ path: '/bad/../path' }, { path: '/bad\0path' }, { cancel: new SharedArrayBuffer(8) }, { kind: 'mount' }]) {
      expect(() => storageRequest({ ...request, ...changed }, 1024)).toThrow()
    }
  })
  it.skipIf(process.platform === 'linux')('refuses a native storage issuer on a component-only platform before loading any asset', () => {
    expect(() => createStorageWorker(config, 1024, '/deployment/fd.node')).toThrow()
  })
})
