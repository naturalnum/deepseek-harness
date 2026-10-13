/** Real PostgreSQL startup and bounded login counters across independent Platform instances. */
import { expect, test } from 'vitest'
import { LoginAdmission } from '../src/platform/login-admission.ts'
import { cloudFixture } from './cloud-fixture.ts'

const limits = { loginWindowMs: 60_000, loginAttemptsPerWindow: 2, loginTrackedAccounts: 2,
  loginGlobalAttemptsPerWindow: 2, sandboxConcurrency: 2 }

test('concurrent empty-database initialization creates one usable global counter', () => cloudFixture(async (f) => {
  const first = new LoginAdmission(f.pool, limits), second = new LoginAdmission(f.pool, limits)
  await Promise.all([first.initialize(), second.initialize()])
  expect((await f.pool.query('SELECT singleton,attempts,tracked_accounts FROM pe_login_global_window')).rows)
    .toEqual([{ singleton: true, attempts: 0, tracked_accounts: 0 }])
  await first.chargeGlobal()
  await second.chargeAccount('alice')
  expect((await f.pool.query('SELECT attempts,tracked_accounts FROM pe_login_global_window')).rows)
    .toEqual([{ attempts: 1, tracked_accounts: 1 }])
}))

test('reinitialization preserves charged global and per-account windows', () => cloudFixture(async (f) => {
  const first = new LoginAdmission(f.pool, limits)
  await first.initialize(); await first.chargeGlobal(); await first.chargeAccount('alice')
  const before = (await f.pool.query('SELECT * FROM pe_login_global_window')).rows
  const accounts = (await f.pool.query('SELECT * FROM pe_login_attempt_windows')).rows
  await new LoginAdmission(f.pool, limits).initialize()
  expect((await f.pool.query('SELECT * FROM pe_login_global_window')).rows).toEqual(before)
  expect((await f.pool.query('SELECT * FROM pe_login_attempt_windows')).rows).toEqual(accounts)
}))

test('replicas with different policies refuse startup without replacing counters', () => cloudFixture(async (f) => {
  const first = new LoginAdmission(f.pool, limits)
  await first.initialize(); await first.chargeGlobal()
  const before = (await f.pool.query('SELECT * FROM pe_login_global_window')).rows
  await expect(new LoginAdmission(f.pool, { ...limits, loginAttemptsPerWindow: 3 }).initialize())
    .rejects.toThrow('Platform replicas disagree')
  expect((await f.pool.query('SELECT * FROM pe_login_global_window')).rows).toEqual(before)
}))

test('a lost global counter with retained account windows refuses initialization', () => cloudFixture(async (f) => {
  const admission = new LoginAdmission(f.pool, limits)
  await admission.initialize(); await admission.chargeAccount('alice')
  await f.pool.query('DELETE FROM pe_login_global_window')
  await expect(admission.initialize()).rejects.toThrow('Missing global login counter')
  expect((await f.pool.query('SELECT count(*)::integer AS count FROM pe_login_global_window')).rows).toEqual([{ count: 0 }])
  expect((await f.pool.query('SELECT attempts FROM pe_login_attempt_windows')).rows).toEqual([{ attempts: 1 }])
}))

test('global charging retains the shared ceiling and resets only an expired window', () => cloudFixture(async (f) => {
  const admission = new LoginAdmission(f.pool, limits)
  await admission.initialize()
  await Promise.all([admission.chargeGlobal(), new LoginAdmission(f.pool, limits).chargeGlobal()])
  await expect(admission.chargeGlobal()).rejects.toMatchObject({ status: 429, code: 'login_rate_limit' })
  await f.pool.query("UPDATE pe_login_global_window SET window_since=clock_timestamp()-interval '2 minutes'")
  await admission.chargeGlobal()
  expect((await f.pool.query('SELECT attempts FROM pe_login_global_window')).rows).toEqual([{ attempts: 1 }])
}))

test('account charging serializes the bounded account census and preserves separate counters', () => cloudFixture(async (f) => {
  const admission = new LoginAdmission(f.pool, limits)
  await admission.initialize()
  const results = await Promise.allSettled(['alice', 'bob', 'carol'].map(name => admission.chargeAccount(name)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
  const denied = results.find(result => result.status === 'rejected')
  expect(denied).toMatchObject({ status: 'rejected', reason: { status: 429, code: 'login_rate_limit' } })
  expect((await f.pool.query('SELECT tracked_accounts FROM pe_login_global_window')).rows).toEqual([{ tracked_accounts: 2 }])
  expect((await f.pool.query('SELECT count(*)::integer AS count FROM pe_login_attempt_windows')).rows).toEqual([{ count: 2 }])
}))

test('an exact account ceiling expires without discarding a different live account', () => cloudFixture(async (f) => {
  const admission = new LoginAdmission(f.pool, limits)
  await admission.initialize(); await admission.chargeAccount('alice'); await admission.chargeAccount('alice')
  await expect(admission.chargeAccount('alice')).rejects.toMatchObject({ status: 429, code: 'login_rate_limit' })
  await f.pool.query("UPDATE pe_login_attempt_windows SET window_since=clock_timestamp()-interval '2 minutes'")
  await admission.chargeAccount('bob'); await admission.chargeAccount('alice')
  expect((await f.pool.query('SELECT attempts FROM pe_login_attempt_windows ORDER BY account_digest')).rows)
    .toEqual([{ attempts: 1 }, { attempts: 1 }])
  expect((await f.pool.query('SELECT tracked_accounts FROM pe_login_global_window')).rows).toEqual([{ tracked_accounts: 2 }])
}))

test('charging after counter loss reports unavailable rather than admitting a request', () => cloudFixture(async (f) => {
  const admission = new LoginAdmission(f.pool, limits)
  await admission.initialize(); await f.pool.query('DELETE FROM pe_login_global_window')
  await expect(admission.chargeGlobal()).rejects.toMatchObject({ status: 503, code: 'login_rate_limit_unavailable' })
  await expect(admission.chargeAccount('alice')).rejects.toMatchObject({ status: 503, code: 'login_rate_limit_unavailable' })
}))

test('account charging refuses a lost admission policy without changing retained counters', () => cloudFixture(async (f) => {
  const admission = new LoginAdmission(f.pool, limits)
  await admission.initialize(); await admission.chargeAccount('alice')
  await f.pool.query('DELETE FROM pe_platform_admission_policy')
  const global = (await f.pool.query('SELECT * FROM pe_login_global_window')).rows
  const accounts = (await f.pool.query('SELECT * FROM pe_login_attempt_windows')).rows
  await expect(admission.chargeAccount('alice')).rejects.toMatchObject({ status: 503, code: 'login_rate_limit_unavailable' })
  expect((await f.pool.query('SELECT * FROM pe_login_global_window')).rows).toEqual(global)
  expect((await f.pool.query('SELECT * FROM pe_login_attempt_windows')).rows).toEqual(accounts)
}))
