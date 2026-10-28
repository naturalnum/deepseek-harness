/** Mock-only Node descriptor/proc composition; actual Linux volumes and backend views remain Root qualification. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SkillProjectGrant } from '../src/skill-files-types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { createRetainedExecutionExports, createSharedPathExecutionExports, ExecutionExportFailure } from '../src/export-share.ts'
import { SESSION_DIRECTORY_SERVER_IMAGE_DIGEST } from '../src/bootstrap/deployment-input.ts'

interface Directory { readonly path: string; readonly device: string; readonly inode: string; readonly mountId: string }
type Opened = { readonly kind: 'directory'; readonly value: Directory } | { readonly kind: 'proc'; readonly bytes: Buffer; offset: number }

const fs = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), read: vi.fn(), stat: vi.fn(), geometry: vi.fn(), parent: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  openSync: fs.open, closeSync: fs.close, readSync: fs.read, fstatSync: fs.stat, statfsSync: fs.geometry, lstatSync: fs.parent }))
afterEach(() => { vi.resetAllMocks() })

function fixture(mode: 'keeper' | 'shared-path' = 'keeper', sessionDirectories = false) {
  const base = `/var/lib/docker/dsh-root-exports/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const storage = [`v1-${'1'.repeat(64)}`, `v1-${'2'.repeat(64)}`]
  const directories = new Map<string, Directory>(), opened = new Map<number, Opened>()
  const events: string[] = []
  let next = 50, writableAlias = false, failedClose: number | undefined
  let transformMountInfo = (value: string): string => value
  const add = (path: string, device: string, inode: string, mountId: string): void => {
    directories.set(path, { path, device, inode, mountId })
  }
  const facts = (device: string, mountId: string) => ({ device, inode: '2', mountId, mode: String(0o40700), uid: '2000', gid: '2000',
    filesystem: '61267', blockBytes: '4096', blocks: '256', inodes: '128' })
  const entries = storage.flatMap((key, index) => (['projects', 'environment'] as const).map((role, roleIndex) => {
    const device = String(11 + index * 2 + roleIndex)
    const source = `/srv/accounts/${key}/${role === 'projects' ? 'projects' : 'environments/one'}`
    const alias = mode === 'shared-path' ? source : `${base}/a${index}/${role === 'projects' ? 'projects' : 'env-one'}`
    const sourceFacts = facts(device, String((mode === 'shared-path' ? 499 : 101) + index * 2 + roleIndex))
    add(alias, device, '2', mode === 'shared-path' ? sourceFacts.mountId : String(9001 + index * 2 + roleIndex))
    return { accountId: `account-${index}`, storageKey: key, role, bankId: role === 'environment' ? `bank-${index}` : null,
      slotId: role === 'environment' ? 'one' : null, sourceDomainPath: source, sourceFacts,
      daemon: { namespace: 'daemon', path: alias, mountId: String(201 + index * 2 + roleIndex),
        facts: facts(device, String(201 + index * 2 + roleIndex)), readonly: false },
      control: { namespace: 'r8Init', path: alias, mountId: String(301 + index * 2 + roleIndex),
        facts: facts(device, String(301 + index * 2 + roleIndex)), readonly: true } }
  }))
  const projectAlias = mode === 'shared-path' ? `/srv/accounts/${storage[1]}/projects` : `${base}/a1/projects`
  const environmentPool = mode === 'shared-path' ? `/srv/accounts/${storage[1]}/environments/one` : `${base}/a1/env-one`
  const sessionDirectory = 'a3b6347d-137e-4bdd-8da6-ef90f85d834c'
  const environmentAlias = sessionDirectories ? `${environmentPool}/${sessionDirectory}` : environmentPool, leaf = 'default-workspace'
  const projectMountId = mode === 'shared-path' ? '501' : '9003', environmentMountId = mode === 'shared-path' ? '502' : '9004'
  add(`${projectAlias}/${leaf}`, '13', '1011', projectMountId); add(`${projectAlias}/${leaf}/.pe`, '13', '1012', projectMountId)
  add(`${projectAlias}/${leaf}/.pe/skills`, '13', '1013', projectMountId)
  if (sessionDirectories) add(environmentAlias, '14', '2020', environmentMountId)
  for (const [index, name] of ['home', 'venv', 'tmp'].entries()) add(`${environmentAlias}/${name}`, '14', String(1021 + index), environmentMountId)
  const manifest = Buffer.from(JSON.stringify({ schema: 'root-daemon-exports-v1', resourceId: 'a'.repeat(32), runId: 'b'.repeat(32),
    daemonNamespace: 'mnt:[10]', sourceNamespace: 'mnt:[11]',
    keeper: { pid: 123, startTicks: '99', mountNamespace: 'mnt:[12]', comm: 'python3' },
    liveness: { kind: 'inherited-fifo-v1', device: '3', inode: '4', nonce: 'c'.repeat(64), frameBytes: 128 },
    privateExported: false, exports: entries }))
  const originalDirectory = (fd: number): Directory => {
    const value = opened.get(fd)
    if (value?.kind !== 'directory') throw new Error('Synthetic descriptor is not a directory')
    return value.value
  }
  const mountInfo = (): string => [...directories.values()].filter(value => value.inode === '2').map((value) => {
    const project = value.path.endsWith('/projects'), flags = mode === 'shared-path' || value.path === projectAlias && writableAlias ? 'rw' : 'ro'
    return `${value.mountId} 1 7:1 / ${value.path} ${flags},nosuid,nodev${project ? ',noexec' : ''} - ext4 /dev/loop1 rw\n`
  }).join('')
  fs.open.mockImplementation((name: string, flags: number): number => {
    events.push(`open:${name}`)
    let value: Opened
    if (name === '/proc/self/mountinfo') value = { kind: 'proc', bytes: Buffer.from(transformMountInfo(mountInfo())), offset: 0 }
    else if (name.startsWith('/proc/self/fdinfo/')) {
      const directory = originalDirectory(Number(name.slice('/proc/self/fdinfo/'.length)))
      value = { kind: 'proc', bytes: Buffer.from(`pos:\t0\nflags:\t02300000\nmnt_id:\t${directory.mountId}\n`), offset: 0 }
    } else {
      if ((flags & constants.O_DIRECTORY) === 0 || (flags & constants.O_NOFOLLOW) === 0) {
        throw new Error('Synthetic directory open must be nofollow')
      }
      const relative = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(name)
      const canonical = relative === null ? name : `${originalDirectory(Number(relative[1])).path}/${relative[2]}`
      const directory = directories.get(canonical)
      if (directory === undefined) throw new Error('Synthetic exact directory is absent')
      value = { kind: 'directory', value: directory }
    }
    const fd = next++; opened.set(fd, value); return fd
  })
  fs.close.mockImplementation((fd: number): void => {
    events.push(`close:${fd}`)
    if (!opened.has(fd)) throw new Error('Synthetic descriptor closed twice')
    if (fd === failedClose) throw new Error('Synthetic unconfirmed close')
    opened.delete(fd)
  })
  fs.read.mockImplementation((fd: number, bytes: Uint8Array, offset: number, length: number): number => {
    const value = opened.get(fd)
    if (value?.kind !== 'proc') throw new Error('Synthetic content reads are forbidden')
    const count = Math.min(length, value.bytes.length - value.offset)
    bytes.set(value.bytes.subarray(value.offset, value.offset + count), offset); value.offset += count; return count
  })
  fs.stat.mockImplementation((fd: number) => {
    const directory = originalDirectory(fd)
    return { dev: BigInt(directory.device), ino: BigInt(directory.inode), uid: 2000n, gid: 2000n, mode: 0o40700n, isDirectory: () => true }
  })
  fs.geometry.mockImplementation((name: string) => {
    originalDirectory(Number(name.slice('/proc/self/fd/'.length)))
    return { type: 61267n, bsize: 4096n, blocks: 256n, files: 128n }
  })
  fs.parent.mockImplementation(() => ({ uid: 0n, gid: 0n, mode: 0o40755n, isDirectory: () => true }))
  const controller = new AbortController(), nativeController = new AbortController()
  const current = vi.fn(() => { events.push('grant') }), keeper = vi.fn(() => { events.push('keeper') })
  const layout = (inode: string) => ({ device: '14', inode, mountId: '502', uid: 2000, gid: 2000, mode: 0o40700 })
  const sourceRoot = `/srv/accounts/${storage[1]}`
  const grant = Object.freeze<ExecutionMountGrant>({ binding: Object.freeze({
    accountId: brandString<ExecutionMountGrant['binding']['accountId']>('account-1'),
    epoch: brandString<ExecutionMountGrant['binding']['epoch']>('1'), recipeVersion: 'v1', lifetime: nativeController.signal }),
  sessionId: brandString<ExecutionMountGrant['sessionId']>('session'),
  workspaceId: brandString<ExecutionMountGrant['workspaceId']>('workspace'),
  project: { rootPath: `${sourceRoot}/projects/${leaf}`, rootDevice: '13', rootInode: '1011', rootMountId: '501',
    mountVersion: '13:1011:501',
    quota: { device: '13', mountId: '501', maximumBytes: '1048576', maximumInodes: '128' }, readOnlyPaths: ['.pe'],
    metadataDirectory: { device: '13', inode: '1012', mountId: '501', uid: 2000, gid: 2000, mode: 0o40700, relativePath: '.pe' } },
  environment: { rootPath: `${sourceRoot}/environments/one${sessionDirectories ? `/${sessionDirectory}` : ''}`,
    rootDevice: '14', rootInode: sessionDirectories ? '2020' : '2', rootMountId: '502',
    bankId: 'bank-1', slotId: 'one', slotGeneration: 1, environmentVersion: 'env-v1', targetPath: '/opt/session-env',
    rootReadOnly: true, writablePaths: ['home', 'venv', 'tmp'],
    quota: { device: '14', mountId: '502', maximumBytes: '1048576', maximumInodes: '128' },
    layout: { home: layout('1021'), venv: layout('1022'), tmp: layout('1023') } } })
  const domain = (path: string, device: string, mountId: string) => ({ rootPath: path, rootDevice: device, rootInode: '2', rootMountId: mountId,
    minimumBytes: '1048576', maximumBytes: '1048576', minimumInodes: '128', maximumInodes: '128',
    backing: { path: `/backing/${device}`, device: '7', inode: device, bytes: '1048576' } })
  const plan = { version: 2, recipeVersion: 'v1', appUid: 2000, appGid: 2000, arenaReserveBytes: '1048576',
    arena: domain('/arena', '1', '101'), control: domain('/control', '2', '102'),
    baseConfigPath: '/app/base.yml', installAnchor: '/app/package.json', auxiliary: [],
    accounts: storage.map((storageKey, index) => {
      const accountRoot = `/srv/accounts/${storageKey}`
      return { accountId: `account-${index}`, storageKey, accountRoot, private: domain(`${accountRoot}/private`, String(3 + index), String(103 + index)),
        projects: domain(`${accountRoot}/projects`, String(11 + index * 2), String(499 + index * 2)),
        environmentBank: { bankId: `bank-${index}`, ...sessionDirectories ? { mode: 'session-directories' } : {}, slots: [{ slotId: 'one', domain: domain(`${accountRoot}/environments/one`, String(12 + index * 2), String(500 + index * 2)) }] } }
    }) }
  const planBytes = Buffer.from(JSON.stringify(plan)), digest = createHash('sha256').update(planBytes).digest('hex')
  const planCurrent = vi.fn(() => {
    if (controller.signal.aborted) throw new ExecutionExportFailure('verification')
  })
  const limits = { maxPlanBytes: 32768, maxMountInfoBytes: 32768, maxPathBytes: 512, maxShares: 1, maxResidentBytes: 4000000 }
  const exports = mode === 'shared-path' ? createSharedPathExecutionExports(planBytes, digest, planCurrent, limits,
    sessionDirectories ? SESSION_DIRECTORY_SERVER_IMAGE_DIGEST : undefined)
    : createRetainedExecutionExports(manifest, createHash('sha256').update(manifest).digest('hex'),
      { signal: controller.signal, assertAvailable: keeper }, { ...limits, maxManifestBytes: 32768 })
  return { exports, grant, current, keeper, opened, events, projectAlias, environmentAlias, environmentPool, controller, nativeController,
    plan, planBytes, digest, planCurrent, limits, directories,
    mountInfo: (transform: (value: string) => string) => { transformMountInfo = transform },
    makeWritable: () => { writableAlias = true }, failClose: (fd: number) => { failedClose = fd } }
}

it('retains the original grant and exactly three account-selected daemon paths with current CLI mount measurements', async () => {
  const f = fixture(), share = await f.exports.share(f.grant, f.current)
  expect(share.value.grant).toBe(f.grant)
  expect(share.value.exports).toEqual({ project: `${f.projectAlias}/default-workspace`,
    protectedProject: `${f.projectAlias}/default-workspace/.pe`,
    environment: f.environmentAlias })
  expect(f.opened.size).toBe(7); expect(f.exports.retainedShares).toBe(1)
  expect(() => { f.exports.assertEpochReleased(f.grant.binding) }).toThrow(ExecutionExportFailure)
  expect(f.events.slice(0, 2)).toEqual(['grant', 'keeper']); expect(f.events.slice(-2)).toEqual(['grant', 'keeper'])
  share.value.assertCurrent()
  expect(f.opened.size).toBe(7); expect(f.current).toHaveBeenCalledTimes(4); expect(f.keeper).toHaveBeenCalledTimes(4)
  share.release(); share.release()
  expect(f.opened.size).toBe(0); expect(f.exports.retainedShares).toBe(0)
  expect(() => { f.exports.assertEpochReleased(f.grant.binding) }).not.toThrow()
  expect(() => { share.value.assertCurrent() }).toThrow(ExecutionExportFailure)
})

it('refuses another account environment selection before opening paths or consuming retained capacity', async () => {
  const f = fixture()
  const wrong: ExecutionMountGrant = { ...f.grant, environment: { ...f.grant.environment, bankId: 'bank-0' } }
  await expect(f.exports.share(wrong, f.current)).rejects.toMatchObject({ phase: 'selection' })
  // Scalar negative selection only; this is not an original CloudAccountFiles issued parent or authority fixture.
  const parent: SkillProjectGrant = { binding: f.grant.binding, workspaceId: f.grant.workspaceId,
    project: { ...f.grant.project, rootMountId: '83', quota: { ...f.grant.project.quota, device: '999' } },
    metadataDirectory: f.grant.project.metadataDirectory,
    skillsDirectory: { ...f.grant.project.metadataDirectory, inode: '1013' } }
  await expect(f.exports.share(f.grant, f.current, { grant: parent, maxCopies: 4 })).rejects.toMatchObject({ phase: 'selection' })
  expect(fs.open).not.toHaveBeenCalled(); expect(f.exports.retainedShares).toBe(0)
})

it('refuses a control alias that becomes writable while retaining the existing allocation share', async () => {
  const f = fixture(), share = await f.exports.share(f.grant, f.current)
  f.makeWritable()
  expect(() => { share.value.assertCurrent() }).toThrow(ExecutionExportFailure)
  expect(f.opened.size).toBe(7); expect(f.exports.retainedShares).toBe(1)
  expect(() => { f.exports.assertCurrent() }).toThrow(ExecutionExportFailure)
  share.release()
  expect(f.opened.size).toBe(0); expect(f.exports.retainedShares).toBe(0)
})

it('keeps finite capacity and every share through EOF, and exposes sticky unconfirmed close without retrying its descriptor', async () => {
  const f = fixture(), share = await f.exports.share(f.grant, f.current)
  await expect(f.exports.share(f.grant, f.current)).rejects.toMatchObject({ code: 'cloud/capacity' })
  const before = [...f.opened.keys()]
  f.controller.abort()
  expect(() => { share.value.assertCurrent() }).toThrow(ExecutionExportFailure)
  expect([...f.opened.keys()]).toEqual(before); expect(f.exports.retainedShares).toBe(1)
  const uncertain = before[0]
  if (uncertain === undefined) throw new Error('Expected a retained original descriptor')
  f.failClose(uncertain)
  expect(() => { share.release() }).toThrow('Export descriptor closure is unconfirmed')
  const calls = fs.close.mock.calls.length
  expect(() => { share.release() }).toThrow('Export descriptor closure is unconfirmed')
  expect(fs.close.mock.calls).toHaveLength(calls)
  expect([...f.opened.keys()]).toEqual([uncertain]); expect(f.exports.retainedShares).toBe(1)
  expect(() => { f.exports.assertCurrent() }).toThrow('Export descriptor closure is unconfirmed')
})

it('retains epoch cleanup uncertainty when verification rejects before a share handle can be published', async () => {
  const f = fixture()
  f.failClose(50) // The initial mountinfo descriptor: no share handle has been returned.
  await expect(f.exports.share(f.grant, f.current)).rejects.toMatchObject({ phase: 'close-unknown' })
  expect(f.exports.retainedShares).toBe(1)
  expect(() => { f.exports.assertEpochReleased(f.grant.binding) }).toThrow('Export descriptor closure is unconfirmed')
  expect(fs.close.mock.calls.filter(([fd]) => fd === 50)).toHaveLength(1)
})

it('retains exact shared-path grants, optional skill parents and stable paths until allocation release', async () => {
  const f = fixture('shared-path')
  const parent: SkillProjectGrant = { binding: f.grant.binding, workspaceId: f.grant.workspaceId,
    project: { ...f.grant.project, rootMountId: f.grant.project.quota.mountId },
    metadataDirectory: f.grant.project.metadataDirectory,
    skillsDirectory: { ...f.grant.project.metadataDirectory, inode: '1013' } }
  const skills = { grant: parent, maxCopies: 4 }, share = await f.exports.share(f.grant, f.current, skills)
  expect(share.value.grant).toBe(f.grant); expect(share.value.skills).toBe(skills)
  expect(share.value.exports).toEqual({ project: f.grant.project.rootPath, protectedProject: `${f.grant.project.rootPath}/.pe`,
    environment: f.grant.environment.rootPath, skills: `${f.grant.project.rootPath}/.pe/skills` })
  expect(f.opened.size).toBe(8); expect(f.exports.retainedShares).toBe(1)
  expect(() => { f.exports.assertEpochReleased(f.grant.binding) }).toThrow(ExecutionExportFailure)
  expect(() => { f.exports.assertEpochReleased({ ...f.grant.binding }) }).not.toThrow()
  await expect(f.exports.share(f.grant, f.current)).rejects.toMatchObject({ code: 'cloud/capacity' })
  share.value.assertCurrent()
  expect(f.opened.size).toBe(8); expect(f.planCurrent).toHaveBeenCalledTimes(7); expect(f.keeper).not.toHaveBeenCalled()
  share.release(); share.release()
  expect(f.opened.size).toBe(0); expect(f.exports.retainedShares).toBe(0)
  expect(() => { f.exports.assertEpochReleased(f.grant.binding) }).not.toThrow()
  expect(() => { share.value.assertCurrent() }).toThrow(ExecutionExportFailure)
})

it('requires the original protected plan capability, digest, bounded capacities and explicit v2 banks', () => {
  const f = fixture('shared-path'), create = (bytes: Uint8Array, digest: string) =>
    createSharedPathExecutionExports(bytes, digest, f.planCurrent, f.limits)
  expect(() => create(f.planBytes, '0'.repeat(64))).toThrow(ExecutionExportFailure)
  expect(() => create(new Uint8Array(), f.digest)).toThrow(ExecutionExportFailure)
  const v1 = Buffer.from(JSON.stringify({ ...f.plan, version: 1,
    accounts: f.plan.accounts.map(({ environmentBank: _bank, ...account }) => account) }))
  expect(() => create(v1, createHash('sha256').update(v1).digest('hex'))).toThrow(ExecutionExportFailure)
  const malformed = Buffer.from('{}')
  expect(() => create(malformed, createHash('sha256').update(malformed).digest('hex'))).toThrow(ExecutionExportFailure)
  for (const changed of [{ maxPlanBytes: 1 }, { maxResidentBytes: 1 }, { maxShares: Infinity }]) {
    expect(() => createSharedPathExecutionExports(f.planBytes, f.digest, f.planCurrent, { ...f.limits, ...changed })).toThrow()
  }
  f.controller.abort()
  expect(() => create(f.planBytes, f.digest)).toThrow(ExecutionExportFailure)
  expect(fs.open).not.toHaveBeenCalled()
})

it.each([undefined, 'sha256:fec2756169ff3e9baf123c0f2e9664baf3f2214898372c180847d991559ce0fd'])(
  'refuses Session directory storage with Native guard %s before opening sources', (serverImage) => {
    const f = fixture('shared-path', true)
    expect(() => createSharedPathExecutionExports(f.planBytes, f.digest, f.planCurrent, f.limits, serverImage))
      .toThrow(ExecutionExportFailure)
    expect(fs.open).not.toHaveBeenCalled()
  },
)

it.each(['account', 'recipe', 'slot', 'quota', 'project'] as const)('refuses shared-path %s mismatch before opening sources', async (changed) => {
  const f = fixture('shared-path')
  const grant: ExecutionMountGrant = changed === 'account' ? { ...f.grant, binding: { ...f.grant.binding,
    accountId: brandString<ExecutionMountGrant['binding']['accountId']>('account-0') } }
    : changed === 'recipe' ? { ...f.grant, binding: { ...f.grant.binding, recipeVersion: 'another' } }
      : changed === 'slot' ? { ...f.grant, environment: { ...f.grant.environment, slotId: 'other' } }
        : changed === 'quota' ? { ...f.grant, project: { ...f.grant.project, quota: { ...f.grant.project.quota, maximumBytes: '2097152' } } }
          : { ...f.grant, project: { ...f.grant.project, rootPath: `${f.projectAlias}/../../private` } }
  await expect(f.exports.share(grant, f.current)).rejects.toMatchObject({ phase: 'selection' })
  expect(fs.open).not.toHaveBeenCalled(); expect(f.exports.retainedShares).toBe(0)
})

it('requires the original files/native current-grant check even when a copied grant has matching JSON fields', async () => {
  const f = fixture('shared-path'), copied = { ...f.grant }, denied = new Error('Original files grant was not retained')
  const originalOnly = () => { if (copied !== f.grant) throw denied }
  await expect(f.exports.share(copied, originalOnly)).rejects.toBe(denied)
  expect(fs.open).not.toHaveBeenCalled(); expect(f.exports.retainedShares).toBe(0)
})

it.each(['missing', 'inode', 'mount', 'geometry', 'nested', 'propagation', 'readonly', 'symlink'] as const)(
  'refuses shared-path %s source measurement without retaining a published share or creating directories', async (changed) => {
    const f = fixture('shared-path')
    if (changed === 'missing') f.mountInfo(value => value.split('\n').filter(line => !line.startsWith('501 ')).join('\n'))
    else if (changed === 'nested') f.mountInfo(value => value + `999 1 7:1 / ${f.projectAlias}/child rw,nosuid,nodev,noexec - ext4 /dev/loop1 rw\n`)
    else if (changed === 'propagation') f.mountInfo(value => value.replaceAll('rw,nosuid,nodev,noexec -', 'rw,nosuid,nodev,noexec shared:22 -'))
    else if (changed === 'readonly') f.mountInfo(value => value.replaceAll('rw,nosuid,nodev', 'ro,nosuid,nodev'))
    else if (changed === 'geometry') fs.geometry.mockReturnValue({ type: 61267n, bsize: 4096n, blocks: 255n, files: 128n })
    else if (changed === 'symlink') f.directories.delete(f.projectAlias)
    else {
      const path = changed === 'inode' ? `${f.grant.project.rootPath}/.pe` : f.projectAlias
      const original = f.directories.get(path)
      if (original === undefined) throw new Error('Expected the original fixture directory')
      f.directories.set(path, { ...original, ...changed === 'inode' ? { inode: '999' } : { mountId: '999' } })
    }
    await expect(f.exports.share(f.grant, f.current)).rejects.toMatchObject({ phase: 'verification' })
    expect(f.opened.size).toBe(0); expect(f.exports.retainedShares).toBe(0)
    expect(() => { f.exports.assertCurrent() }).toThrow(ExecutionExportFailure)
  })

it('retains existing shared-path allocations when a later project replacement or protected-plan loss closes admission', async () => {
  const f = fixture('shared-path'), share = await f.exports.share(f.grant, f.current)
  const metadata = f.directories.get(`${f.grant.project.rootPath}/.pe`)
  if (metadata === undefined) throw new Error('Expected original metadata directory')
  f.directories.set(metadata.path, { ...metadata, inode: '999' })
  expect(() => { share.value.assertCurrent() }).toThrow(ExecutionExportFailure)
  expect(f.opened.size).toBe(7); expect(f.exports.retainedShares).toBe(1)
  f.controller.abort()
  share.release()
  expect(f.opened.size).toBe(0); expect(f.exports.retainedShares).toBe(0)
})

it.each(['plan', 'native'] as const)('retains shared-path descriptors through revoked %s authority until allocation release', async (authority) => {
  const f = fixture('shared-path'), share = await f.exports.share(f.grant, f.current), before = [...f.opened.keys()]
  if (authority === 'plan') f.controller.abort()
  else f.nativeController.abort(new ExecutionExportFailure('verification'))
  expect(() => { share.value.assertCurrent() }).toThrow(ExecutionExportFailure)
  expect([...f.opened.keys()]).toEqual(before); expect(f.exports.retainedShares).toBe(1)
  share.release()
  expect(f.opened.size).toBe(0); expect(f.exports.retainedShares).toBe(0)
})

it.each(['initial', 'recheck', 'release'] as const)('keeps shared-path %s close uncertainty sticky and never retries a descriptor number', async (phase) => {
  const f = fixture('shared-path')
  if (phase === 'initial') {
    f.failClose(50)
    await expect(f.exports.share(f.grant, f.current)).rejects.toMatchObject({ phase: 'close-unknown' })
  } else {
    const share = await f.exports.share(f.grant, f.current)
    if (phase === 'recheck') {
      fs.close.mockImplementationOnce(() => { throw new Error('Synthetic temporary proc close is unconfirmed') })
      expect(() => { share.value.assertCurrent() }).toThrow('Export descriptor closure is unconfirmed')
    } else {
      const fd = [...f.opened.keys()][0]
      if (fd === undefined) throw new Error('Expected original share descriptor')
      f.failClose(fd)
    }
    expect(() => { share.release() }).toThrow('Export descriptor closure is unconfirmed')
    const calls = fs.close.mock.calls.length
    expect(() => { share.release() }).toThrow('Export descriptor closure is unconfirmed')
    expect(fs.close.mock.calls).toHaveLength(calls)
  }
  expect(f.exports.retainedShares).toBe(1); expect(f.opened.size).toBe(1)
  expect(() => { f.exports.assertEpochReleased(f.grant.binding) }).toThrow('Export descriptor closure is unconfirmed')
  expect(() => { f.exports.assertCurrent() }).toThrow('Export descriptor closure is unconfirmed')
})


it('shares only the verified Session child while keeping the original pool quota and retained FD bound', async () => {
  const f = fixture('shared-path', true), share = await f.exports.share(f.grant, f.current)
  expect(share.value.exports.environment).toBe(f.environmentAlias)
  expect(share.value.exports.environment).not.toBe(f.environmentPool)
  expect(f.opened.size).toBe(7)
  expect([...f.opened.values()].filter(item => item.kind === 'directory').map(item => item.value.path))
    .not.toContain(f.environmentPool)
  share.value.assertCurrent()
  expect(f.opened.size).toBe(7)
  share.release()
  expect(f.opened.size).toBe(0)
})

it.each(['pool', 'nested', 'foreign', 'not-uuid', 'pool-inode'] as const)(
  'rejects Session-directory %s grants before opening data', async (changed) => {
    const f = fixture('shared-path', true)
    const environment = { ...f.grant.environment,
      ...changed === 'pool-inode' ? { rootInode: '2' }
        : { rootPath: changed === 'pool' ? f.environmentPool
          : changed === 'nested' ? `${f.environmentAlias}/home`
            : changed === 'foreign' ? f.environmentAlias.replace('environments/one', 'environments/other')
              : `${f.environmentPool}/untrusted` } }
    await expect(f.exports.share({ ...f.grant, environment }, f.current)).rejects.toMatchObject({ phase: 'selection' })
    expect(fs.open).not.toHaveBeenCalled()
    expect(f.exports.retainedShares).toBe(0)
  })

it.each(['inode', 'mount'] as const)('rejects a Session child whose %s changed under the original parent pool', async (changed) => {
  const f = fixture('shared-path', true), original = f.directories.get(f.environmentAlias)
  if (original === undefined) throw new Error('Expected the Session directory')
  f.directories.set(f.environmentAlias, { ...original, ...changed === 'inode' ? { inode: '999' } : { mountId: '999' } })
  await expect(f.exports.share(f.grant, f.current)).rejects.toMatchObject({ phase: 'verification' })
  expect(f.opened.size).toBe(0)
  expect(f.exports.retainedShares).toBe(0)
})
