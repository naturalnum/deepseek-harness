import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { readRecoveryFixture } from './owner-recovery-pg-fixture.ts'

function withFixture(run: (home: string, config: string, database: string, role: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'dsh-recovery-fixture-'))
  const database = 's4_recovery_worker1_' + 'a'.repeat(32)
  const role = database.replace('s4_recovery_worker1_', 's4_recovery_worker1_role_')
  const config = join(home, 'fixture.json')
  try { run(home, config, database, role) } finally { rmSync(home, { recursive: true, force: true }) }
}

it('preserves the original passwordless fixture without reading an ambient password', () => {
  withFixture((_home, config, database, role) => {
    writeFileSync(config, JSON.stringify({ port: 5432, database, role }), { mode: 0o600 })
    expect(readRecoveryFixture(config)).toEqual({ port: 5432, database, role, password: '' })
  })
})

it('loads a bounded private test secret without including it in fixture metadata', () => {
  withFixture((home, config, database, role) => {
    const path = join(home, 'secret'), secret = randomUUID()
    writeFileSync(path, secret, { mode: 0o600 })
    writeFileSync(config, JSON.stringify({ port: 5432, database, role, passwordFile: path }), { mode: 0o600 })
    expect(readRecoveryFixture(config).password === secret).toBe(true)
    chmodSync(path, 0o644)
    expect(() => readRecoveryFixture(config)).toThrow('Invalid protected recovery fixture input')
  })
})

it('rejects symlinks, multiple links, empty or oversized secrets and noncanonical paths', () => {
  withFixture((home, config, database, role) => {
    const secret = join(home, 'secret'), alias = join(home, 'alias')
    const assign = (passwordFile: string) => writeFileSync(config, JSON.stringify({ port: 5432, database, role, passwordFile }))
    writeFileSync(secret, randomUUID(), { mode: 0o600 })
    symlinkSync(secret, alias); assign(alias)
    expect(() => readRecoveryFixture(config)).toThrow()
    rmSync(alias); linkSync(secret, alias); assign(secret)
    expect(() => readRecoveryFixture(config)).toThrow('Invalid protected recovery fixture input')
    rmSync(alias); writeFileSync(secret, '')
    expect(() => readRecoveryFixture(config)).toThrow('Invalid protected recovery fixture input')
    writeFileSync(secret, 'a'.repeat(1025))
    expect(() => readRecoveryFixture(config)).toThrow('Invalid protected recovery fixture input')
    assign(`${home}/folder/../secret`)
    expect(() => readRecoveryFixture(config)).toThrow('Only the exact owned loopback recovery fixture may run these cases')
  })
})
