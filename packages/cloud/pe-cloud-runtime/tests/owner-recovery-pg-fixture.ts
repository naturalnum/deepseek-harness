/** Explicit recovery test fixture: no network access or ambient credentials. */
import { constants, openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'

export interface RecoveryFixture { readonly port: number; readonly database: string; readonly role: string; readonly password: string }

function readBounded(path: string, maximum: number, privateSecret: boolean): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (privateSecret && (!stat.isFile() || stat.nlink !== 1 || stat.size < 0 || stat.size > maximum
      || (stat.mode & 0o077) !== 0 || process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error('Invalid protected recovery fixture input')
    }
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size)
      if (count === 0) break
      size += count
    }
    const after = fstatSync(fd)
    if (size > maximum || privateSecret && (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size
      || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)) throw new Error('Invalid protected recovery fixture input')
    return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, size))
  } finally { closeSync(fd) }
}

/** Parse a coordinator-assigned fixture; omitted passwordFile preserves original empty-password fixtures. */
export function readRecoveryFixture(path: string): RecoveryFixture {
  const value: unknown = JSON.parse(readBounded(path, 16384, false))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Explicit recovery fixture required')
  const row = value as Record<string, unknown>
  if (typeof row.port !== 'number' || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535
    || typeof row.database !== 'string' || !/^s4_recovery_worker1_[a-f0-9]{32}$/.test(row.database)
    || typeof row.role !== 'string' || row.role !== row.database.replace('s4_recovery_worker1_', 's4_recovery_worker1_role_')
    || row.passwordFile !== undefined && (typeof row.passwordFile !== 'string' || !isAbsolute(row.passwordFile)
      || normalize(row.passwordFile) !== row.passwordFile)) {
    throw new Error('Only the exact owned loopback recovery fixture may run these cases')
  }
  const password = typeof row.passwordFile === 'string' ? readBounded(row.passwordFile, 1024, true) : ''
  if (typeof row.passwordFile === 'string' && (password.length === 0 || /[\u0000\r\n]/u.test(password))) {
    throw new Error('Invalid protected recovery fixture input')
  }
  return { port: row.port, database: row.database, role: row.role, password }
}
