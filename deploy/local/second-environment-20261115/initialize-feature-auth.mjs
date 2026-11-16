/** One-time trusted initialization of the independent combined-feature database. Never exposed as a request handler. */
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

let phase = 'validate-private-input'
const need = (value, message) => { if (!value) throw new Error(message) }
const fields = (value, names) => need(value !== null && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort()), 'Exact private input required')
const text = (value, maximum = 4096) => { need(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum
  && !/[\u0000-\u001f\u007f]/u.test(value), 'Bounded input required'); return value }
const timer = value => { need(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'Finite timer required'); return value }
function protect(name, privateFile = false) {
  need(path.posix.isAbsolute(name) && path.posix.normalize(name) === name, 'Canonical protected input required')
  for (let current = name; current !== '/'; current = path.posix.dirname(current)) {
    const stat = fs.lstatSync(current)
    need(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'Root-protected parent chain required')
    if (current === name) need(stat.isFile() && stat.nlink === 1 && (!privateFile || (stat.mode & 0o777) === 0o600), 'Private regular input required')
  }
}
/**
 * Accept canonical HTTPS origins or HTTP origins on the local development loopback site.
 * @param {string} value Public origin supplied by the independent trusted initializer input.
 * @returns {URL} The validated origin; credentials and database state are never accessed.
 */
export function protectedAuthInitializationOrigin(value) {
  const origin = new URL(text(value, 2048))
  need(origin.origin === value && (origin.protocol === 'https:' || origin.protocol === 'http:'
    && (origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost')
      || origin.hostname === '[::1]' || isIP(origin.hostname) === 4 && /^127\./.test(origin.hostname))), 'Canonical protected development origin required')
  return origin
}

async function main() {
  need(process.platform === 'linux' && process.getuid() === 0, 'Trusted Linux Root initialization required')
  const args = process.argv.slice(2)
  need(args.length === 2 && args[0] === '--input', 'Use --input with the new private JSON')
  const inputPath = text(args[1]); protect(inputPath, true)
  const fd = fs.openSync(inputPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let bytes
  try {
    const stat = fs.fstatSync(fd)
    need(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= 65536,
      'Bounded 0600 Root input required')
    bytes = fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
  const input = JSON.parse(bytes.toString('utf8'))
  fields(input, ['schema', 'authenticationPackageJson', 'database', 'publicOrigin', 'authSecret', 'administrator', 'limits'])
  need(input.schema === 'dsh-feature-auth-init/v1', 'Independent auth initializer schema required')
  const anchor = text(input.authenticationPackageJson); protect(anchor)
  fields(input.database, ['host', 'port', 'user', 'database', 'password', 'ssl'])
  const database = input.database
  text(database.host, 255); text(database.user, 255); text(database.password, 8192)
  need(database.database === 'dsh_combined_features_20261107_sdk_arm_20261116', 'Only the independent combined-feature database is authorized')
  need(Number.isInteger(database.port) && database.port > 0 && database.port <= 65535 && typeof database.ssl === 'boolean', 'Explicit database transport required')
  const origin = protectedAuthInitializationOrigin(input.publicOrigin)
  text(input.authSecret, 8192); need(Buffer.byteLength(input.authSecret) >= 32, 'New authentication secret required')
  fields(input.administrator, ['email', 'name', 'password'])
  const administrator = input.administrator
  text(administrator.email, 254); text(administrator.name, 200); text(administrator.password, 512)
  need(administrator.password.length >= 12 && administrator.password.length <= 128, 'Explicit administrator password bounds required')
  fields(input.limits, ['connectionTimeoutMs', 'statementTimeoutMs', 'lockTimeoutMs', 'idleTransactionTimeoutMs', 'operationTimeoutMs', 'maxMigrationSqlBytes'])
  for (const key of ['connectionTimeoutMs', 'statementTimeoutMs', 'lockTimeoutMs', 'idleTransactionTimeoutMs', 'operationTimeoutMs']) timer(input.limits[key])
  need(input.limits.lockTimeoutMs <= input.limits.statementTimeoutMs && input.limits.idleTransactionTimeoutMs >= input.limits.operationTimeoutMs
    && Number.isSafeInteger(input.limits.maxMigrationSqlBytes) && input.limits.maxMigrationSqlBytes > 0
    && input.limits.maxMigrationSqlBytes <= 4194304, 'Explicit bounded initialization limits required')

  phase = 'load-pinned-provider'
  const require = createRequire(pathToFileURL(anchor))
  const { Pool } = require('pg')
  const { betterAuth } = await import(pathToFileURL(require.resolve('better-auth')).href)
  const { admin } = await import(pathToFileURL(require.resolve('better-auth/plugins')).href)
  const { getMigrations } = await import(pathToFileURL(require.resolve('better-auth/db/migration')).href)
  const limits = input.limits
  const pool = new Pool({ ...database, ssl: database.ssl ? { rejectUnauthorized: true } : false, max: 2, min: 0,
    connectionTimeoutMillis: limits.connectionTimeoutMs, idleTimeoutMillis: 1000,
    statement_timeout: limits.statementTimeoutMs, lock_timeout: limits.lockTimeoutMs,
    idle_in_transaction_session_timeout: limits.idleTransactionTimeoutMs, query_timeout: 0,
    application_name: 'dsh-combined-features-trusted-auth-init', options: '-c search_path=public' })
  let poolFailure = false, expired = false, lockClient, locked = false
  pool.on('error', () => { poolFailure = true })
  const deadline = setTimeout(() => { expired = true }, limits.operationTimeoutMs)
  const current = () => need(!poolFailure && !expired, 'Initialization budget ended; retain actual state for Root inspection')
  const options = { database: pool, secret: input.authSecret, baseURL: input.publicOrigin, basePath: '/cloud/auth',
    trustedOrigins: [input.publicOrigin], emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: false } }, plugins: [admin()],
    // These fields exactly match pe-cloud-access/src/auth.ts. They are private and never client input.
    user: { additionalFields: {
      cloudCreationId: { type: 'string', required: false, input: false, returned: false, unique: true },
      cloudCreationHash: { type: 'string', required: false, input: false, returned: false },
    } },
    advanced: { useSecureCookies: origin.protocol === 'https:', trustedProxyHeaders: false,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' }, ipAddress: { ipAddressHeaders: ['x-pe-auth-remote-ip'] } },
    telemetry: { enabled: false }, logger: { level: 'error', log() {} } }
  try {
    const auth = betterAuth(options)
    need((await auth.$context).version === '1.7.10', 'Exactly Better Auth 1.7.10 is required')
    lockClient = await pool.connect()
    const actual = await lockClient.query('SELECT current_database() AS database')
    need(actual.rows[0]?.database === 'dsh_combined_features_20261107_sdk_arm_20261116', 'Independent database identity mismatch')
    // Session lock is held only by this trusted initializer. No idle transaction spans library work.
    await lockClient.query('SELECT pg_advisory_lock(1346715981, 3)'); locked = true
    current()
    phase = 'verify-empty-independent-database'
    const tables = await lockClient.query("SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
    need(tables.rows[0]?.count === '0', 'Existing database requires explicit reconciliation; never replay initialization')
    phase = 'migrate-original-auth-schema'
    const migration = await getMigrations(options)
    need(Array.isArray(migration.unsafeChanges) && migration.unsafeChanges.length === 0
      && Array.isArray(migration.schemaProblems) && migration.schemaProblems.length === 0
      && Array.isArray(migration.toBeCreated) && migration.toBeCreated.length > 0, 'Only a fresh library-generated migration is authorized')
    const sql = await migration.compileMigrations()
    need(typeof sql === 'string' && Buffer.byteLength(sql) > 0 && Buffer.byteLength(sql) <= limits.maxMigrationSqlBytes, 'Bounded original migration required')
    current(); await migration.runMigrations(); current()
    const checkMigrations = async () => {
      const plan = await getMigrations(options)
      for (const key of ['toBeCreated', 'toBeAdded', 'toBeAddedIndexes', 'unsafeChanges', 'schemaProblems']) {
        need(Array.isArray(plan[key]) && plan[key].length === 0, 'Original authentication schema remains incomplete')
      }
    }
    await checkMigrations(); current()
    phase = 'create-sole-real-administrator'
    // Official trusted server initialization: deliberately no Request and no Headers; this script never listens.
    const created = await auth.api.createUser({ body: { email: administrator.email, name: administrator.name,
      password: administrator.password, role: 'admin', data: { banned: false } } })
    current()
    const userId = created?.user?.id
    need(typeof userId === 'string' && userId.length > 0, 'Original provider did not return an authentic user ID')
    phase = 'verify-role-and-registration-policy'
    const users = await lockClient.query('SELECT id, role, coalesce(banned,false) AS banned FROM "user"')
    need(users.rows.length === 1 && users.rows[0].id === userId && users.rows[0].role === 'admin' && users.rows[0].banned === false,
      'Exactly one enabled administrator must exist; B/C are created only through Settings')
    const signup = await auth.handler(new Request(new URL('/cloud/auth/sign-up/email', input.publicOrigin), {
      method: 'POST', headers: { origin: input.publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'closed-' + randomUUID() + '@disabled.example.test', name: 'Closed signup probe', password: administrator.password }),
    }))
    const signupBody = await signup.json()
    need(signup.status === 400 && signupBody?.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED', 'Public registration is not verifiably closed')
    current()
    phase = 'verify-real-password-and-close-bootstrap-login'
    const signedIn = await auth.api.signInEmail({ body: { email: administrator.email, password: administrator.password },
      headers: new Headers({ origin: input.publicOrigin }), asResponse: true })
    need(signedIn.ok, 'Original administrator credential verification failed')
    const cookies = signedIn.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    await signedIn.arrayBuffer(); need(cookies.length > 0, 'Original verification login cookie absent')
    const signedOut = await auth.api.signOut({ headers: new Headers({ origin: input.publicOrigin, cookie: cookies }), asResponse: true })
    need(signedOut.ok, 'Original verification login revocation is unconfirmed'); await signedOut.arrayBuffer()
    current()
    const remaining = await lockClient.query('SELECT (SELECT count(*)::text FROM "user") AS users, (SELECT count(*)::text FROM "session") AS sessions')
    need(remaining.rows[0]?.users === '1' && remaining.rows[0]?.sessions === '0', 'Only the administrator and no bootstrap sessions may remain')
    await checkMigrations(); current()
    phase = 'initialized-and-verified'
    return { status: phase, database: database.database, userId, verified: { betterAuthVersion: '1.7.10',
      soleEnabledAdministrator: true, publicSignupDisabled: true, realPasswordVerified: true, bootstrapSessionsRemaining: 0,
      pendingMigration: false, ordinaryAccountsPrecreated: false, credentialsPrinted: false } }
  } finally {
    clearTimeout(deadline)
    if (lockClient !== undefined) {
      let discard = false
      try {
        if (locked) {
          const result = await lockClient.query('SELECT pg_advisory_unlock(1346715981, 3) AS unlocked')
          need(result.rows[0]?.unlocked === true, 'Trusted initialization lock release is unconfirmed')
        }
      } catch (_unlockUnknown) { discard = true }
      finally { lockClient.release(discard) }
      await pool.end()
      need(!discard, 'Trusted initialization cleanup is unconfirmed')
    } else await pool.end()
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())) }
  catch (error) { console.error(JSON.stringify({ status: 'refused-or-retained-unknown', phase, errorName: error?.name ?? 'unknown', credentialsPrinted: false })); process.exitCode = 1 }
}
