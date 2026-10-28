import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  bytes: Buffer.from('{"schema":"unit-only","apiKey":"synthetic-private"}'),
  mode: 0o100440n, inode: 2n, readonly: true, next: 10, uid: 0n, gid: 2000n,
  fds: new Map<number, string>(), closes: [] as number[],
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const stat = (directory = false, current = false) => ({ uid: directory ? 0n : io.uid, gid: directory ? 0n : io.gid, nlink: 1n,
    mode: directory ? 0o40755n : io.mode, size: BigInt(io.bytes.length), dev: 1n,
    ino: current ? io.inode : 2n, mtimeNs: 3n, ctimeNs: 4n, isFile: () => !directory, isDirectory: () => directory })
  return { ...actual,
    openSync: (path: string) => { const fd = io.next++; io.fds.set(fd, path); return fd },
    fstatSync: () => stat(),
    lstatSync: (path: string) => stat(path !== '/root-private/execution.json', true),
    readSync: (fd: number, target: Buffer, offset: number, length: number, position: number) => {
      const path = io.fds.get(fd)
      const bytes = path === '/root-private/execution.json' ? io.bytes : path === '/proc/self/mountinfo'
        ? Buffer.from(`77 1 8:1 / /root-private ${io.readonly ? 'ro' : 'rw'} - ext4 /dev/sda ro\n`)
        : Buffer.from('mnt_id:\t77\n')
      const chunk = bytes.subarray(position, position + length); target.set(chunk, offset); return chunk.length
    },
    closeSync: (fd: number) => { io.closes.push(fd); io.fds.delete(fd) },
  }
})
import { readRootDeploymentReference, RootDeploymentLease } from '../src/bootstrap/deployment-reference.ts'

const reference = () => ({ path: '/root-private/execution.json', sha256: createHash('sha256').update(io.bytes).digest('hex') })
describe('Root readonly selection lease', () => {
  beforeEach(() => {
    io.fds.clear(); io.closes.length = 0; io.mode = 0o100440n; io.inode = 2n; io.readonly = true; io.uid = 0n; io.gid = 2000n
    io.bytes = Buffer.from('{"schema":"unit-only","apiKey":"synthetic-private"}')
  })
  it('retains original readable Root configuration through policy checks until explicit close', () => {
    const lease = readRootDeploymentReference(reference())
    expect(lease.value()).toEqual({ schema: 'unit-only', apiKey: 'synthetic-private' })
    expect([...io.fds.values()]).toEqual(['/root-private/execution.json'])
    lease.assertCurrent(); lease.close(); lease.close()
    expect(io.fds.size).toBe(0)
    expect(() => { lease.assertCurrent() }).toThrow()
  })
  it('rejects a writable mount or swapped selection instead of attesting server liveness', () => {
    io.readonly = false
    expect(() => readRootDeploymentReference(reference())).toThrow()
    expect(io.fds.size).toBe(0)
    io.readonly = true
    const lease = readRootDeploymentReference(reference())
    io.inode = 3n
    expect(() => { lease.assertCurrent() }).toThrow()
    lease.close()
    io.mode = 0o100660n
    expect(() => readRootDeploymentReference(reference())).toThrow()
    expect(io.fds.size).toBe(0)
  })
  it.each([0o100440n, 0o100444n, 0o100640n, 0o100644n])('retains a Root-protected files plan mode %s on a readonly mount', (mode) => {
    io.mode = mode; io.gid = 0n
    const lease = new RootDeploymentLease(reference(), 262144, 'storage-plan')
    expect(lease.bytes()).toEqual(io.bytes)
    lease.close(); expect(io.fds.size).toBe(0)
  })
  it('rejects writable, non-Root or swapped files plans without relaxing legacy file kinds', () => {
    io.mode = 0o100664n
    expect(() => new RootDeploymentLease(reference(), 262144, 'storage-plan')).toThrow()
    io.mode = 0o100644n; io.uid = 2000n
    expect(() => new RootDeploymentLease(reference(), 262144, 'storage-plan')).toThrow()
    io.uid = 0n; io.readonly = false
    expect(() => new RootDeploymentLease(reference(), 262144, 'storage-plan')).toThrow()
    io.readonly = true
    expect(() => new RootDeploymentLease(reference(), 262144, 'export-manifest')).toThrow()
    expect(() => new RootDeploymentLease(reference(), 262144, 'configuration')).toThrow()
    const lease = new RootDeploymentLease(reference(), 262144, 'storage-plan')
    io.inode = 3n; expect(() => { lease.assertCurrent() }).toThrow(); lease.close()
    expect(io.fds.size).toBe(0)
  })
})
