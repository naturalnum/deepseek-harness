/** Linux unit entry; the immutable image supplies dependencies, and all business imports use current readonly source. */
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { z } from 'zod'

const configuration = z.object({ adminUrl: z.string(), caseRole: z.string().regex(/^pe_sandbox_case_[a-f0-9]+$/u),
  job: z.enum(['ready', 'refusal', 'owned_conflict', 'foreign_conflict', 'interrupted_provision', 'missing_stop_proof',
    'listener_init_failure']), tlsDirectory: z.string(), receipt: z.string(), controlReceipt: z.string() })
const path = process.env.PE_SANDBOX_UNIT_INPUT_FILE
if (!path) throw new Error('Owned sandbox unit input file is required')
const config = configuration.parse(JSON.parse(await readFile(path, 'utf8')))
const admin = new Pool({ connectionString: config.adminUrl, max: 1 })
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`
const receipt = { nodeVersion: process.version, job: config.job, roleCreated: false, roleRemoved: false,
  caseDatabasesRemaining: -1, flowPassed: false, pgServerVersion: '' }
// Private directories are 0700; every credential write is explicitly 0600. The service creates 0755 skill directories.
process.umask(0o022)
try {
  for (let attempt = 0; ; attempt++) {
    try { await admin.query('SELECT 1'); break }
    catch (error) { if (attempt === 60) throw error; await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  receipt.pgServerVersion = (await admin.query<{ server_version: string }>('SHOW server_version')).rows[0]?.server_version ?? ''
  const password = randomBytes(32).toString('hex')
  await admin.query(`CREATE ROLE ${quote(config.caseRole)} LOGIN CREATEDB PASSWORD '${password}'`)
  receipt.roleCreated = true
  const url = new URL(config.adminUrl); url.username = config.caseRole; url.password = password; url.pathname = '/postgres'
  const file = '/case-data/owned-case-url-private'
  await writeFile(file, url.href, { mode: 0o600 })
  process.env.PE_TEST_DATABASE_URL_FILE = file
  process.env.PE_SANDBOX_TEST_TLS_DIRECTORY = config.tlsDirectory
  process.env.PE_SANDBOX_UNIT_CONTROL_RECEIPT_FILE = config.controlReceipt
  // cloud-fixture reads its protected URL at import time, so the typed flows are imported only after supply.
  const flows = await import('./sandbox-protocol-flows.ts')
  const flow = {
    ready: flows.readyFlow, refusal: flows.refusalFlow,
    owned_conflict: flows.ownedConflictFlow, foreign_conflict: flows.foreignConflictFlow,
    interrupted_provision: flows.interruptedProvisionFlow, missing_stop_proof: flows.missingStopProofFlow,
    listener_init_failure: flows.listenerInitializationFailureControl,
  }[config.job]
  await flow()
  receipt.flowPassed = true
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : 'UnknownError'
  console.error(message.replaceAll(config.adminUrl, '<private-url>').replace(/postgres(?:ql)?:\/\/[^\s)]+/giu, '<private-url>'))
  process.exitCode = 1
} finally {
  try {
    if (receipt.roleCreated) {
      const remaining = (await admin.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1)', [config.caseRole])).rows
      receipt.caseDatabasesRemaining = remaining.length
      for (const { datname } of remaining) {
        if (!/^pe_cloud_case_[a-f0-9]{32}$/u.test(datname)) throw new Error('Refuse unexpected role database cleanup')
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [datname])
        await admin.query(`DROP DATABASE ${quote(datname)}`)
      }
      await admin.query(`DROP ROLE ${quote(config.caseRole)}`)
      receipt.roleRemoved = true
    }
  } catch {
    console.error('Owned sandbox role cleanup failed')
    process.exitCode = 1
  } finally {
    await admin.end()
    await writeFile(config.receipt, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  }
}
