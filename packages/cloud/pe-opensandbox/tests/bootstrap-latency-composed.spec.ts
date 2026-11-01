/** Real RootDeploymentLease and shared-path adapter; synthetic filesystem and SDK, no Target. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { managedDeploymentFixture, sharedPathDeploymentFixture } from './fixtures/root-deployment.ts'

const io = vi.hoisted(() => ({
  files: new Map<string, Buffer>(), fds: new Map<number, string>(), next: 10,
  reads: new Map<string, number>(), inode: new Map<string, bigint>(), mode: new Map<string, bigint>(),
  readonly: true, mountId: '77', symlink: new Set<string>(),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const fileStat = (path: string, fromPath: boolean) => ({
    dev: 1n, ino: fromPath ? io.inode.get(path) ?? 2n : 2n,
    mode: io.mode.get(path) ?? (path.endsWith('/config.json') ? 0o100440n : 0o100644n),
    uid: 0n, gid: path.endsWith('/config.json') ? 2000n : 0n, nlink: 1n,
    size: BigInt(io.files.get(path)?.length ?? 0), mtimeNs: 3n, ctimeNs: 4n,
    isFile: () => !io.symlink.has(path), isDirectory: () => false,
  })
  const directory = { dev: 1n, ino: 1n, mode: 0o40755n, uid: 0n, gid: 0n, nlink: 1n,
    size: 0n, mtimeNs: 3n, ctimeNs: 4n, isFile: () => false, isDirectory: () => true }
  return { ...actual,
    openSync: (path: string) => { const fd = io.next++; io.fds.set(fd, path); return fd },
    fstatSync: (fd: number) => fileStat(io.fds.get(fd)!, false),
    lstatSync: (path: string) => io.files.has(path) ? fileStat(path, true)
      : { ...directory, isDirectory: () => !io.symlink.has(path) },
    readSync: (fd: number, target: Buffer, offset: number, length: number, position: number) => {
      const path = io.fds.get(fd)!
      const bytes = io.files.get(path) ?? (path.startsWith('/proc/self/fdinfo/')
        ? Buffer.from(`mnt_id:\t${io.mountId}\n`)
        : Buffer.from(`77 1 8:1 / /root-private ${io.readonly ? 'ro' : 'rw'} - ext4 /dev/sda ro\n`))
      if (io.files.has(path) && position === 0) io.reads.set(path, (io.reads.get(path) ?? 0) + 1)
      const chunk = bytes.subarray(position, position + length)
      target.set(chunk, offset)
      return chunk.length
    },
    closeSync: (fd: number) => { io.fds.delete(fd) },
  }
})
vi.mock('../src/bootstrap/bootstrap.ts', () => ({
  BootstrapFailure: class BootstrapFailure extends Error {
    constructor(public code: string, cause?: unknown) { super(code, { cause }) }
  },
}))
vi.mock('../src/bootstrap/factory.ts', () => ({
  createRootSdkExecutionOwner: async () => ({ backend: { closeRootActual: async () => {} }, runtimes: {} }),
}))
import { assembleRootExecutionDeployment } from '../src/bootstrap/assembly.ts'

const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const domain = (path: string, device: string, mountId: string) => ({
  rootPath: path, rootDevice: device, rootInode: '2', rootMountId: mountId,
  minimumBytes: '1048576', maximumBytes: '1048576', minimumInodes: '128', maximumInodes: '128',
  backing: { path: `/backing/${device}`, device: '7', inode: device, bytes: '1048576' },
})
function plan() {
  return {
    version: 2, recipeVersion: 'v1', appUid: 2000, appGid: 2000, arenaReserveBytes: '1048576',
    arena: domain('/arena', '1', '101'), control: domain('/control', '2', '102'),
    baseConfigPath: '/app/base.yml', installAnchor: '/app/package.json', auxiliary: [],
    accounts: ['1', '2'].map((value, index) => {
      const storageKey = `v1-${value.repeat(64)}`, accountRoot = `/srv/accounts/${storageKey}`
      return {
        accountId: `account-${index}`, storageKey, accountRoot,
        private: domain(`${accountRoot}/private`, String(3 + index), String(103 + index)),
        projects: domain(`${accountRoot}/projects`, String(11 + index * 2), String(499 + index * 2)),
        environmentBank: { bankId: `bank-${index}`, slots: [{ slotId: 'one',
          domain: domain(`${accountRoot}/environments/one`, String(12 + index * 2), String(500 + index * 2)) }] },
      }
    }),
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  io.files.clear(); io.fds.clear(); io.reads.clear(); io.inode.clear(); io.mode.clear(); io.symlink.clear()
  io.readonly = true; io.mountId = '77'
})
it('real V2 shared adapter performs one current check per Root lease and rejects changed identity', async () => {
  const original = process
  vi.stubGlobal('process', new Proxy(original, { get(target, key, receiver) {
    if (key === 'platform') return 'linux'
    if (key === 'getuid' || key === 'getgid') return () => 2000
    const value: unknown = Reflect.get(target, key, receiver)
    return value
  } }))
  const content = Buffer.from(JSON.stringify(plan())), input = sharedPathDeploymentFixture()
  input.storage.plan.sha256 = sha(content)
  const config = Buffer.from(JSON.stringify(input))
  io.files.set('/root-private/config.json', config)
  io.files.set('/root-private/storage-plan.json', content)
  const assembly = await assembleRootExecutionDeployment({ path: '/root-private/config.json', sha256: sha(config) }, managedDeploymentFixture())
  io.reads.clear()
  assembly.deployment.assertCurrent()
  expect(io.reads.get('/root-private/config.json')).toBe(1)
  expect(io.reads.get('/root-private/storage-plan.json')).toBe(1)
  io.inode.set('/root-private/storage-plan.json', 3n)
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.inode.clear()
  io.symlink.add('/root-private/config.json')
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.symlink.clear()
  io.symlink.add('/root-private')
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.symlink.clear()
  io.readonly = false
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.readonly = true
  io.mountId = '78'
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.mountId = '77'
  io.mode.set('/root-private/storage-plan.json', 0o100666n)
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.mode.clear()
  const before = io.files.get('/root-private/storage-plan.json')!
  io.files.set('/root-private/storage-plan.json', Buffer.from('x'.repeat(before.length)))
  expect(() => { assembly.deployment.assertCurrent() }).toThrow()
  io.files.set('/root-private/storage-plan.json', before)
  expect(() => { assembly.deployment.assertCurrent() }).not.toThrow()
  await assembly.closeActual()
  expect(io.fds.size).toBe(0)
})
