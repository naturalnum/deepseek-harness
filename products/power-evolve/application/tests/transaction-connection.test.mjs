/** Built database transactions survive a leased PostgreSQL connection ending between queries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { transaction } from '../lib/platform/database.js'

async function worker() {
  const request = await new Promise(resolve => process.once('message', resolve))
  const pool = new Pool({ connectionString: request.databaseUrl, max: 1,
    application_name: request.applicationName })
  const idleErrors = []
  pool.on('error', error => idleErrors.push(error))
  const originalFailure = new Error('business failure after disconnect')
  let previousClient
  let previousPid
  const resume = new Promise(resolve => process.once('message', resolve))
  try {
    const pending = transaction(pool, async client => {
      previousClient = client
      previousPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await client.query('INSERT INTO transaction_probe(value) VALUES($1)', ['interrupted'])
      client.once('end', () => process.send({ kind: 'disconnected' }))
      process.send({ kind: 'paused', pid: previousPid })
      await resume
      if (request.scenario === 'business') throw originalFailure
      return 'must not commit'
    })
    await assert.rejects(pending, error => {
      if (request.scenario === 'business') assert.equal(error, originalFailure)
      else assert.equal(error.code, '57P01', 'the original leased-client error is returned')
      return true
    })
    assert.equal(pool.totalCount, 0, 'the broken leased connection is discarded')
    assert.equal(previousClient.listenerCount('error'), 1, 'only the pool listener remains after release')
    const recovered = await transaction(pool, async client => {
      assert.notEqual(client, previousClient)
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      assert.notEqual(pid, previousPid)
      await client.query('INSERT INTO transaction_probe(value) VALUES($1)', ['recovered'])
      return pid
    })
    assert.deepEqual((await pool.query('SELECT value FROM transaction_probe ORDER BY value')).rows,
      [{ value: 'recovered' }], 'the interrupted transaction never commits')
    const businessFailure = new Error('healthy business rollback')
    let healthyClient
    await assert.rejects(transaction(pool, async client => {
      healthyClient = client
      await client.query('INSERT INTO transaction_probe(value) VALUES($1)', ['rolled-back'])
      throw businessFailure
    }), error => error === businessFailure)
    await transaction(pool, async client => {
      assert.equal(client, healthyClient, 'a successful rollback retains the healthy connection')
      assert.equal(client.listenerCount('error'), 1, 'each lease has exactly one transaction listener')
    })
    assert.deepEqual((await pool.query('SELECT value FROM transaction_probe ORDER BY value')).rows,
      [{ value: 'recovered' }])
    const rollbackFailure = new Error('business failure before unavailable rollback')
    await assert.rejects(transaction(pool, async client => {
      await client.query('INSERT INTO transaction_probe(value) VALUES($1)', ['no-rollback-connection'])
      await client.end()
      throw rollbackFailure
    }), error => error === rollbackFailure)
    assert.equal(pool.totalCount, 0, 'a failed rollback also discards the client')
    await transaction(pool, async client => {
      assert.deepEqual((await client.query('SELECT value FROM transaction_probe ORDER BY value')).rows,
        [{ value: 'recovered' }])
    })
    assert.equal(idleErrors.length, 0, 'leased errors do not escape through the idle pool listener')
    process.send({ kind: 'done', recovered })
  } finally {
    await pool.end()
    process.disconnect()
  }
}

function childProcess(t) {
  const child = fork(fileURLToPath(import.meta.url), ['--transaction-recovery-child'],
    { silent: true, execArgv: [] })
  const messages = new Map()
  const waiting = new Map()
  let stderr = ''
  let exitError
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
  child.on('message', message => {
    const waiter = waiting.get(message.kind)
    if (waiter) { waiting.delete(message.kind); waiter.resolve(message) }
    else messages.set(message.kind, message)
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    exitError = new Error(`transaction child exited (${code ?? signal}): ${stderr}`)
    for (const waiter of waiting.values()) waiter.reject(exitError)
    waiting.clear()
    resolve({ code, signal })
  }))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  const waitFor = kind => {
    if (messages.has(kind)) return Promise.resolve(messages.get(kind))
    if (exitError) return Promise.reject(exitError)
    return new Promise((resolve, reject) => waiting.set(kind, { resolve, reject }))
  }
  return { child, waitFor, exited }
}

if (process.argv.includes('--transaction-recovery-child')) {
  await worker()
} else {
  for (const scenario of ['return', 'business']) {
    test(`a leased connection ending during a JavaScript wait preserves the process (${scenario})`,
      { timeout: 30000 }, async t => {
        const privateDir = process.env.PE_PRIVATE_DIR
          ?? join(homedir(), '.config/power-evolve/shared-host-slice2')
        const databaseUrl = process.env.PE_TEST_DATABASE_URL
          ?? (await readFile(join(privateDir, 'database-url'), 'utf8')).trim()
        const database = `pe_transaction_${randomBytes(10).toString('hex')}`
        const applicationName = database
        const admin = new Pool({ connectionString: databaseUrl, max: 1 })
        let control
        let created = false
        t.after(async () => {
          await control?.end()
          if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
          await admin.end()
        })
        await admin.query(`CREATE DATABASE "${database}"`)
        created = true
        const url = new URL(databaseUrl)
        url.pathname = `/${database}`
        control = new Pool({ connectionString: url.href, max: 1 })
        await control.query('CREATE TABLE transaction_probe(value text PRIMARY KEY)')
        const { child, waitFor, exited } = childProcess(t)
        child.send({ databaseUrl: url.href, applicationName, scenario })
        const { pid } = await waitFor('paused')
        const terminated = await control.query(`SELECT pg_terminate_backend(pid) AS terminated
          FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name=$2`,
        [pid, applicationName])
        assert.deepEqual(terminated.rows, [{ terminated: true }])
        await waitFor('disconnected')
        child.send({ kind: 'resume' })
        await waitFor('done')
        assert.deepEqual(await exited, { code: 0, signal: null })
        assert.deepEqual((await control.query('SELECT value FROM transaction_probe ORDER BY value')).rows,
          [{ value: 'recovered' }])
      })
  }
}
