/** Configure the disposable OpenSSH target from root-only runtime files; never print credential data. */
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const inputRoot = '/run/ssh-target-input'
const accounts = [{ name: 'qa-alice', uid: 11001 }, { name: 'qa-bob', uid: 11002 }]
const environment = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }

class SetupError extends Error {}

async function privateFile(name, maximumBytes) {
  // Kubernetes Secret projections use symlinks inside their read-only volume.
  const path = await realpath(`${inputRoot}/${name}`)
  if (!path.startsWith(`${inputRoot}/`)) throw new SetupError('input_path_invalid')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o077) !== 0
      || metadata.size === 0 || metadata.size > maximumBytes) throw new SetupError('input_file_invalid')
    return await file.readFile()
  } finally { await file.close() }
}

function run(binary, args, input) {
  const result = spawnSync(binary, args, { input, env: environment, timeout: 10_000, maxBuffer: 65_536 })
  // chpasswd and sshd diagnostics can include private input; expose only a fixed error.
  if (result.error || result.signal || result.status !== 0) throw new SetupError('system_configuration_failed')
}

async function directory(path, mode, uid = 0) {
  try { await mkdir(path, { mode }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new SetupError('directory_invalid')
  await chown(path, uid, uid)
  await chmod(path, mode)
}

async function configure() {
  if (process.getuid() !== 0) throw new SetupError('root_setup_required')
  process.umask(0o077)
  await directory('/run/sshd', 0o755)
  await directory('/run/sshd/authorized_keys', 0o755)
  const hostKey = await privateFile('ssh_host_ed25519_key', 16_384)
  hostKey.fill(0)
  const passwords = []
  for (const account of accounts) {
    const bytes = await privateFile(`${account.name}.password`, 1024)
    const password = bytes.toString('utf8')
    const valid = Buffer.from(password, 'utf8').equals(bytes) && !/[\u0000-\u001f\u007f-\u009f]/u.test(password)
    bytes.fill(0)
    if (!valid) throw new SetupError('password_file_invalid')
    passwords.push(`${account.name}:${password}\n`)
    const publicKeys = await privateFile(`${account.name}.authorized_keys`, 65_536)
    const lines = publicKeys.toString('utf8').trim().split('\n')
    if (!lines.every(line => /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\x00-\x1f\x7f]*)?$/u.test(line))) {
      throw new SetupError('public_key_file_invalid')
    }
    const keysPath = `/run/sshd/authorized_keys/${account.name}`
    await writeFile(keysPath, `${lines.map(line => `restrict ${line}`).join('\n')}\n`, { mode: 0o644 })
    await chmod(keysPath, 0o644)
    run('/usr/bin/ssh-keygen', ['-l', '-f', keysPath])
    const home = `/home/${account.name}`
    await directory(home, 0o700, account.uid)
    await directory(`${home}/work space`, 0o700, account.uid)
    await directory(`${home}/quote's space`, 0o700, account.uid)
  }
  const passwordInput = Buffer.from(passwords.join(''))
  try { run('/usr/sbin/chpasswd', [], passwordInput) }
  finally { passwordInput.fill(0) }
  run('/usr/sbin/sshd', ['-t', '-f', '/opt/power-evolve/ssh-target-fixture/sshd_config'])
}

configure().catch(error => {
  console.error(`SSH target fixture setup failed: ${error instanceof SetupError ? error.message : 'setup_failed'}`)
  process.exitCode = 1
})
