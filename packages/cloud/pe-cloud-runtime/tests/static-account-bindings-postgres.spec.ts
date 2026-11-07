import { readFileSync } from 'node:fs'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { AccountId, RootMetadataDatabase } from '../src/types.ts'
import { StaticAccountBindings } from '../src/static-account-bindings.ts'

const path = process.env.PE_ACCOUNT_ADMIN_POSTGRES_CONFIG
const inventory = { sha256: 'a'.repeat(64), maxAccounts: 2,
  slots: [{ slotId: 'slot-a', templateId: 'standard' }, { slotId: 'slot-b', templateId: 'standard' }] }

describe.skipIf(path === undefined)('durable static account assignments', () => {
  it('assigns each real slot once, preserves mapping identity across workflow transitions and reloads after restart', async () => {
    if (path === undefined) throw new Error('Isolated PostgreSQL configuration required')
    const config: pg.PoolConfig = JSON.parse(readFileSync(path, 'utf8'))
    const pool = new pg.Pool({ ...config, database: 'dsh_account_management', max: 4, connectionTimeoutMillis: 1000, statement_timeout: 5000 })
    const database: RootMetadataDatabase = { wasNotSubmitted: () => false,
      query: async (sql, values) => { const result = await pool.query(sql, [...values]); return { rows: result.rows } } }
    let a = new StaticAccountBindings(database, inventory, () => {})
    const b = new StaticAccountBindings(database, inventory, () => {})
    let reloaded: StaticAccountBindings | undefined
    try {
      await a.initialize()
      await pool.query('TRUNCATE pe_account_static_bindings')
      await a.close(); a = new StaticAccountBindings(database, inventory, () => {}); await a.initialize()
      await b.initialize()
      const [first, second] = await Promise.all([
        a.reserve('binding-a' as AccountId, 'standard', 'create-a'),
        b.reserve('binding-b' as AccountId, 'standard', 'create-b'),
      ])
      expect(first.assignment.slotId).not.toBe(second.assignment.slotId)
      expect((await a.reserve('binding-a' as AccountId, 'standard', 'retry-a')).assignment).toBe(first.assignment)
      const preparing = await a.transition(first, 'preparing', 'create-a')
      const ready = await a.transition(preparing, 'ready', 'create-a')
      expect(ready.assignment).toBe(first.assignment)
      expect(ready.assignment.revision).toBe('1')
      expect(ready.revision).toBe('3')
      await expect(a.transition(first, 'failed', 'stale-operation')).rejects.toMatchObject({ code: 'cloud/stale-generation' })
      await expect(a.reserve('binding-c' as AccountId, 'standard', 'create-c')).rejects.toMatchObject({ code: 'cloud/capacity' })
      await expect(a.seed('binding-a' as AccountId, second.assignment.slotId)).rejects.toMatchObject({ code: 'cloud/account-unavailable' })
      await a.close(); await b.close()
      reloaded = new StaticAccountBindings(database, inventory, () => {})
      await reloaded.initialize()
      expect((await reloaded.refresh('binding-a' as AccountId))?.phase).toBe('ready')
      expect(reloaded.list()).toHaveLength(2)
      const original = reloaded.lookup('binding-a' as AccountId)
      expect(original).toEqual(first.assignment)
      if (original === undefined) throw new Error('Reloaded mapping absent')
      reloaded.assertCurrent(original)
      expect(() => reloaded?.assertCurrent({ ...original })).toThrow()
    } finally {
      await Promise.all([a.close(), b.close(), reloaded?.close()])
      await pool.end()
    }
  }, 15000)
})
