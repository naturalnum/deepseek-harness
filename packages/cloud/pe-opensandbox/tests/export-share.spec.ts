/** Mock-only Node descriptor/proc composition; actual Linux exports and keeper adoption remain Root qualification. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExecutionMountGrant } from '@deepseek-ai/dsh-pe-cloud-files'
import type { SkillProjectGrant } from '../src/skill-files-types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { createRetainedExecutionExports, ExecutionExportFailure } from '../src/export-share.ts'

interface Directory { readonly path: string; readonly device: string; readonly inode: string; readonly mountId: string }
type Opened = { readonly kind: 'directory'; readonly value: Directory } | { readonly kind: 'proc'; readonly bytes: Buffer; offset: number }

const fs = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), read: vi.fn(), stat: vi.fn(), geometry: vi.fn(), parent: vi.fn() }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  openSync: fs.open, closeSync: fs.close, readSync: fs.read, fstatSync: fs.stat, statfsSync: fs.geometry, lstatSync: fs.parent }))
afterEach(() => { vi.resetAllMocks() })

function fixture() {
  const base = `/var/lib/docker/dsh-root-exports/${'a'.repeat(32)}/${'b'.repeat(32)}`
  const storage = [`v1-${'1'.repeat(64)}`, `v1-${'2'.repeat(64)}`]
  const directories = new Map<string, Directory>(), opened = new Map<number, Opened>()
  const events: string[] = []
  let next = 50, writableAlias = false, failedClose: number | undefined
  const add = (path: string, device: string, inode: string, mountId: string): void => {
    directories.set(path, { path, device, inode, mountId })
  }
  const facts = (device: string, mountId: string) => ({ device, inode: '2', mountId, mode: String(0o40700), uid: '2000', gid: '2000',
    filesystem: '61267', blockBytes: '4096', blocks: '256', inodes: '128' })
  const entries = storage.flatMap((key, index) => (['projects', 'environment'] as const).map((role, roleIndex) => {
    const device = String(11 + index * 2 + roleIndex), alias = `${base}/a${index}/${role === 'projects' ? 'projects' : 'env-one'}`
    const source = `/srv/accounts/${key}/${role === 'projects' ? 'projects' : 'environments/one'}`
    const sourceFacts = facts(device, String(101 + index * 2 + roleIndex))
    add(alias, device, '2', String(9001 + index * 2 + roleIndex))
    return { accountId: `account-${index}`, storageKey: key, role, bankId: role === 'environment' ? `bank-${index}` : null,
      slotId: role === 'environment' ? 'one' : null, sourceDomainPath: source, sourceFacts,
      daemon: { namespace: 'daemon', path: alias, mountId: String(201 + index * 2 + roleIndex),
        facts: facts(device, String(201 + index * 2 + roleIndex)), readonly: false },
      control: { namespace: 'r8Init', path: alias, mountId: String(301 + index * 2 + roleIndex),
        facts: facts(device, String(301 + index * 2 + roleIndex)), readonly: true } }
  }))
  const projectAlias = `${base}/a1/projects`, environmentAlias = `${base}/a1/env-one`, leaf = 'default-workspace'
  add(`${projectAlias}/${leaf}`, '13', '1011', '9003'); add(`${projectAlias}/${leaf}/.pe`, '13', '1012', '9003')
  for (const [index, name] of ['home', 'venv', 'tmp'].entries()) add(`${environmentAlias}/${name}`, '14', String(1021 + index), '9004')
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
    const project = value.path.endsWith('/projects'), flags = value.path === projectAlias && writableAlias ? 'rw' : 'ro'
    return `${value.mountId} 1 7:1 / ${value.path} ${flags},nosuid,nodev${project ? ',noexec' : ''} - ext4 /dev/loop1 rw\n`
  }).join('')
  fs.open.mockImplementation((name: string, flags: number): number => {
    events.push(`open:${name}`)
    let value: Opened
    if (name === '/proc/self/mountinfo') value = { kind: 'proc', bytes: Buffer.from(mountInfo()), offset: 0 }
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
  const controller = new AbortController(), current = vi.fn(() => { events.push('grant') }), keeper = vi.fn(() => { events.push('keeper') })
  const layout = (inode: string) => ({ device: '14', inode, mountId: '502', uid: 2000, gid: 2000, mode: 0o40700 })
  const sourceRoot = `/srv/accounts/${storage[1]}`
  const grant = Object.freeze<ExecutionMountGrant>({ binding: Object.freeze({
    accountId: brandString<ExecutionMountGrant['binding']['accountId']>('account-1'),
    epoch: brandString<ExecutionMountGrant['binding']['epoch']>('1'), recipeVersion: 'v1', lifetime: new AbortController().signal }),
  sessionId: brandString<ExecutionMountGrant['sessionId']>('session'),
  workspaceId: brandString<ExecutionMountGrant['workspaceId']>('workspace'),
  project: { rootPath: `${sourceRoot}/projects/${leaf}`, rootDevice: '13', rootInode: '1011', rootMountId: '501',
    mountVersion: '13:1011:501',
    quota: { device: '13', mountId: '501', maximumBytes: '1048576', maximumInodes: '128' }, readOnlyPaths: ['.pe'],
    metadataDirectory: { device: '13', inode: '1012', mountId: '501', uid: 2000, gid: 2000, mode: 0o40700, relativePath: '.pe' } },
  environment: { rootPath: `${sourceRoot}/environments/one`, rootDevice: '14', rootInode: '2', rootMountId: '502',
    bankId: 'bank-1', slotId: 'one', slotGeneration: 1, environmentVersion: 'env-v1', targetPath: '/opt/session-env',
    rootReadOnly: true, writablePaths: ['home', 'venv', 'tmp'],
    quota: { device: '14', mountId: '502', maximumBytes: '1048576', maximumInodes: '128' },
    layout: { home: layout('1021'), venv: layout('1022'), tmp: layout('1023') } } })
  const exports = createRetainedExecutionExports(manifest, createHash('sha256').update(manifest).digest('hex'),
    { signal: controller.signal, assertAvailable: keeper },
    { maxManifestBytes: 32768, maxMountInfoBytes: 32768, maxPathBytes: 512, maxShares: 1, maxResidentBytes: 4000000 })
  return { exports, grant, current, keeper, opened, events, projectAlias, environmentAlias, controller,
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
