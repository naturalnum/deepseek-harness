import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountMountInput } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import { parseStaticStoragePlan, parseStorageProbeFrame, staticStorageReservation } from '../src/storage-probe.ts'
import { RootStorageOwner, validateStorageView, type StaticAccountStorageLease, type StaticStorageDriver } from '../src/storage-owner.ts'
import { storageRequest, createStorageWorker } from '../src/storage-worker.ts'
import type { StaticStorageConfig, StorageProbeFacts } from '../src/storage-types.ts'

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


describe('two retained static preparations with serial verification', () => {
  const owners: RootStorageOwner[] = []
  const releases: Array<() => void> = []
  const pending: Promise<StaticAccountStorageLease>[] = []

  beforeEach(() => {
    // Protocol fixtures exercise scheduling only; synthetic facts never establish a Linux deployment.
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'linux' } }))
  })
  afterEach(async () => {
    for (const owner of owners.splice(0)) owner.closeAdmission()
    for (const release of releases.splice(0)) release()
    await Promise.allSettled(pending.splice(0))
    vi.unstubAllGlobals()
  })

  async function fixture() {
    const record = raw()
    record.arena.minimumBytes = record.arena.maximumBytes = record.arena.backing.bytes = '65536'
    for (const row of record.accounts) {
      row.private.rootPath = `${row.accountRoot}/private`
      row.projects.rootPath = `${row.accountRoot}/projects`
    }
    for (const domain of [record.control, ...record.accounts.flatMap(row => [row.private, row.projects])]) {
      domain.backing.device = record.arena.rootDevice
    }
    const encoded = encode(record), plan = parseStaticStoragePlan(encoded, 1024)
    const domains = [plan.arena, plan.control, ...plan.accounts.flatMap(row => [row.private, row.projects])]
    const facts = new Map<string, StorageProbeFacts>()
    const fact = (change: Partial<StorageProbeFacts>): StorageProbeFacts => ({ flags: 3, uid: 0, gid: 0, mode: 0o40755,
      appUid: 1000, appGid: 1000, device: '99', inode: '2', mountId: '1', filesystem: '61267',
      blockBytes: '4096', blocks: '2', freeBlocks: '1', availableBlocks: '1', inodes: '100', freeInodes: '99',
      size: '0', allocatedBytes: '0', links: '1', ...change })
    facts.set('/', fact({ flags: 35 }))
    for (const path of [plan.baseConfigPath, plan.installAnchor]) facts.set(path, fact({ mode: 0o100444, flags: 11 }))
    for (const [index, domain] of domains.entries()) {
      facts.set(domain.rootPath, fact({ device: domain.rootDevice, inode: domain.rootInode, mountId: domain.rootMountId,
        flags: index < 2 ? 3 : 31, uid: index < 2 ? 0 : 1000, gid: index < 2 ? 0 : 1000,
        mode: index < 2 ? 0o40755 : 0o40700, blocks: index === 0 ? '16' : '2', availableBlocks: index === 0 ? '16' : '1' }))
      facts.set(domain.backing.path, fact({ device: domain.backing.device, inode: domain.backing.inode,
        mode: 0o100600, size: domain.backing.bytes, allocatedBytes: domain.backing.bytes }))
    }
    const mounts = ['1 0 8:0 / / ro - ext4 /dev/test-root ro', ...domains.map((domain, index) =>
      `${domain.rootMountId} 1 8:${index + 1} / ${domain.rootPath} rw - ext4 /dev/test-${index} rw`)].join('\n')
    const driver = {
      record: vi.fn(async () => encoded), view: vi.fn(async () => view(mounts)),
      probe: vi.fn(async (path: string) => {
        const observed = facts.get(path)
        if (observed === undefined) throw new Error('Unexpected fixture probe')
        return observed
      }),
      assertPoolCurrent: vi.fn(() => {}), bind: vi.fn((): never => { throw new Error('No native lane expected') }),
      joinEpoch: vi.fn(async () => {}),
    } satisfies StaticStorageDriver
    const owner = new RootStorageOwner({ ...config, planSha256: createHash('sha256').update(encoded).digest('hex') }, 1024, driver)
    owners.push(owner)
    await owner.initializeStatic()
    const probePaths = driver.probe.mock.calls.map(call => call[0])
    driver.record.mockClear(); driver.view.mockClear(); driver.probe.mockClear()
    const controllers = plan.accounts.map(() => new AbortController())
    const inputs = plan.accounts.map((row, index): AccountMountInput => {
      const root = row.private.rootPath
      return Object.freeze({ binding: Object.freeze({ accountId: row.accountId,
        epoch: '1' as AccountMountInput['binding']['epoch'], recipeVersion: plan.recipeVersion, lifetime: controllers[index]!.signal }),
      instanceId: 'fixture-instance' as AccountMountInput['instanceId'],
      layout: Object.freeze({ storageKey: row.storageKey, accountRoot: row.accountRoot, privateRoot: root,
        profileRoot: `${root}/profile`, patchPath: `${root}/profile/cordis.patch.yml`, credentialsRoot: `${root}/credentials`,
        sessionsRoot: `${root}/sessions`, storageRoot: `${root}/storage`, attachmentsRoot: `${root}/attachments`,
        skillsRoot: `${root}/skills`, instructionsRoot: `${root}/instructions`, projectsRoot: row.projects.rootPath,
        environmentsRoot: `${row.accountRoot}/environments`, localIndexRoot: `/cache/${row.storageKey}` }),
      environment: Object.freeze({ get: () => undefined, getFrom: () => undefined }) })
    })
    const prepare = (input: AccountMountInput) => {
      const result = owner.prepareAccount(input)
      pending.push(result)
      return result
    }
    return { owner, driver, facts, plan, encoded, controllers, inputs, prepare, probePaths }
  }

  function pauseLastProbe(f: Awaited<ReturnType<typeof fixture>>) {
    const path = f.plan.accounts[1].projects.backing.path
    const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<StorageProbeFacts>()
    let waiting = false, first = true
    const probe = f.driver.probe.getMockImplementation()!, record = f.driver.record.getMockImplementation()!
    f.driver.probe.mockImplementation((actual) => {
      if (actual !== path || !first) return probe(actual)
      first = false; waiting = true; entered.resolve(undefined)
      return resume.promise.finally(() => { waiting = false })
    })
    f.driver.record.mockImplementation(() => {
      expect(waiting, 'another preparation must not start while the original probe is pending').toBe(false)
      return record()
    })
    const finish = () => { resume.resolve(f.facts.get(path)!) }
    releases.push(finish)
    return { entered: entered.promise, finish, fail: (cause: Error) => { resume.reject(cause) } }
  }

  it('retains B and its duplicates while A is pending, then verifies B only after the complete A verification', async () => {
    const f = await fixture(), gate = pauseLastProbe(f)
    const a = f.prepare(f.inputs[0]!), bIssued = vi.fn(), aIssued = vi.fn()
    void a.then(aIssued, () => {})
    await gate.entered
    const b = f.prepare(f.inputs[1]!)
    void b.then(bIssued, () => {})
    for (let index = 0; index < 20; index++) expect(f.prepare({ ...f.inputs[1]! })).toBe(b)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(aIssued).not.toHaveBeenCalled()
    expect(bIssued).not.toHaveBeenCalled()
    expect(f.driver.record).toHaveBeenCalledTimes(1)
    expect(f.driver.view).toHaveBeenCalledTimes(1)
    gate.finish()
    const [first, second] = await Promise.all([a, b])
    expect(first).not.toBe(second)
    expect(f.driver.record).toHaveBeenCalledTimes(2)
    expect(f.driver.probe.mock.calls.map(call => call[0])).toEqual([...f.probePaths, ...f.probePaths])
    first.assertCurrent(); second.assertCurrent()
    expect(f.prepare(f.inputs[0]!)).toBe(a)
    expect(f.prepare(f.inputs[1]!)).toBe(b)
  })

  it.each(['failed verification', 'closed admission'] as const)('blocks queued I/O and lease issuance after %s without early settlement', async (outcome) => {
    const f = await fixture(), gate = pauseLastProbe(f), cause = new Error('held probe failed')
    const a = f.prepare(f.inputs[0]!), settled = vi.fn()
    await gate.entered
    const b = f.prepare(f.inputs[1]!)
    void a.then(settled, settled); void b.then(settled, settled)
    if (outcome === 'closed admission') f.owner.closeAdmission()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    if (outcome === 'failed verification') gate.fail(cause)
    else gate.finish()
    const results = await Promise.allSettled([a, b])
    expect(results[0]).toMatchObject({ status: 'rejected', reason: outcome === 'failed verification' ? cause : { code: 'files/prerequisite-missing' } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'files/prerequisite-missing' } })
    expect(f.driver.record).toHaveBeenCalledTimes(1)
    expect(f.driver.view).toHaveBeenCalledTimes(1)
    expect(() => { f.owner.assertRootCurrent() }).toThrow()
    expect(f.driver.bind).not.toHaveBeenCalled()
  })

  it('keeps an aborted queued B retained until A settles, then rejects before B starts I/O', async () => {
    const f = await fixture(), gate = pauseLastProbe(f), a = f.prepare(f.inputs[0]!)
    await gate.entered
    const b = f.prepare(f.inputs[1]!), settled = vi.fn()
    void b.then(settled, settled)
    f.controllers[1]!.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    expect(f.driver.record).toHaveBeenCalledTimes(1)
    gate.finish()
    const lease = await a
    await expect(b).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    lease.assertCurrent()
    expect(f.driver.record).toHaveBeenCalledTimes(1)
    expect(f.driver.view).toHaveBeenCalledTimes(1)
    expect(f.driver.bind).not.toHaveBeenCalled()
  })

  it('rejects a queued preparation if admission closes before its first callback without any I/O', async () => {
    const f = await fixture(), a = f.prepare(f.inputs[0]!), b = f.prepare(f.inputs[1]!)
    f.owner.closeAdmission()
    await expect(a).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
    await expect(b).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
    expect(f.driver.record).not.toHaveBeenCalled()
    expect(f.driver.view).not.toHaveBeenCalled()
    expect(f.driver.probe).not.toHaveBeenCalled()
  })

  it('retains an active verification after abort and refuses its lease only after actual settlement', async () => {
    const f = await fixture(), gate = pauseLastProbe(f), a = f.prepare(f.inputs[0]!), settled = vi.fn()
    void a.then(settled, settled)
    await gate.entered
    f.controllers[0]!.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).not.toHaveBeenCalled()
    gate.finish()
    await expect(a).rejects.toMatchObject({ code: 'cloud/stale-generation' })
    f.owner.assertRootCurrent()
    expect(f.driver.record).toHaveBeenCalledTimes(1)
  })

  it('keeps the original fixed-account and generation refusals without adding a third preparation', async () => {
    const f = await fixture(), gate = pauseLastProbe(f), input = f.inputs[0]!, a = f.prepare(input)
    await gate.entered
    const b = f.prepare(f.inputs[1]!)
    for (const change of [{ binding: { ...input.binding, epoch: '2' as AccountMountInput['binding']['epoch'] } },
      { layout: { ...input.layout } }, { instanceId: 'other' as AccountMountInput['instanceId'] }]) {
      expect(() => f.prepare({ ...input, ...change })).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
    }
    for (const binding of [{ ...input.binding, accountId: 'third' as AccountMountInput['binding']['accountId'] },
      { ...input.binding, recipeVersion: 'different' }, { ...input.binding, lifetime: AbortSignal.abort() }]) {
      expect(() => f.prepare({ ...input, binding })).toThrow(expect.objectContaining({ code: 'files/prerequisite-missing' }))
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.driver.record).toHaveBeenCalledTimes(1)
    gate.finish()
    const [lease] = await Promise.all([a, b])
    expect(f.driver.record).toHaveBeenCalledTimes(2)
    const replacement = { ...input, binding: { ...input.binding, epoch: '2' as AccountMountInput['binding']['epoch'] } }
    expect(() => f.prepare(replacement)).toThrow()
    await lease.closeAfterActualDrain()
    const next = await f.prepare(replacement)
    next.assertCurrent()
    expect(f.driver.record).toHaveBeenCalledTimes(3)
  })

  it('rechecks the protected record for B and fails the owner on changed bytes after A settled', async () => {
    const f = await fixture(), gate = pauseLastProbe(f), a = f.prepare(f.inputs[0]!)
    await gate.entered
    const b = f.prepare(f.inputs[1]!)
    f.driver.record.mockResolvedValue(encode({ ...raw(), recipeVersion: 'tampered' }))
    gate.finish()
    const lease = await a
    await expect(b).rejects.toMatchObject({ code: 'files/prerequisite-missing' })
    expect(f.driver.record).toHaveBeenCalledTimes(2)
    expect(f.driver.view).toHaveBeenCalledTimes(1)
    expect(() => { lease.assertCurrent() }).toThrow()
  })
})
