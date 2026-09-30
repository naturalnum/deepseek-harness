/** Generate fixture-only credentials in a new private directory outside the repository. No infrastructure changes. */
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

class PreparationError extends Error {}

async function prepare() {
  const requested = process.argv[2]
  if (process.argv.length !== 3 || !requested || !isAbsolute(requested)) {
    throw new PreparationError('supply_one_new_absolute_private_directory')
  }
  const repository = await realpath(fileURLToPath(new URL('../../../../', import.meta.url)))
  const destination = join(await realpath(dirname(resolve(requested))), basename(resolve(requested)))
  if (destination === repository || destination.startsWith(`${repository}${sep}`)) {
    throw new PreparationError('private_directory_must_be_outside_repository')
  }
  process.umask(0o077)
  // An existing directory is never reused or removed, including after a partial failure.
  await mkdir(destination, { mode: 0o700 })
  const server = join(destination, 'server'), client = join(destination, 'client')
  await mkdir(server, { mode: 0o700 })
  await mkdir(client, { mode: 0o700 })
  const sshKeygen = process.env.SSH_FIXTURE_KEYGEN ?? '/usr/bin/ssh-keygen'
  if (!isAbsolute(sshKeygen)) throw new PreparationError('keygen_path_must_be_absolute')
  const askpass = fileURLToPath(new URL('./askpass.sh', import.meta.url))
  const environment = { PATH: '/usr/bin:/bin', LANG: 'C' }
  function generate(path, label, passphraseFile) {
    const args = ['-q', '-t', 'ed25519', '-C', label, '-f', path]
    if (!passphraseFile) args.push('-N', '')
    const result = spawnSync(sshKeygen, args, { input: '', timeout: 30_000, maxBuffer: 65_536,
      env: passphraseFile ? { ...environment, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force',
        SSH_FIXTURE_PASSPHRASE_FILE: passphraseFile } : environment })
    if (result.error || result.signal || result.status !== 0) throw new PreparationError('key_generation_failed')
  }
  const hostKey = join(server, 'ssh_host_ed25519_key')
  generate(hostKey, 'power-evolve-qa-host')
  await chmod(`${hostKey}.pub`, 0o600)
  const users = []
  for (const username of ['qa-alice', 'qa-bob']) {
    const passwordFile = join(server, `${username}.password`)
    const passphraseFile = join(client, `${username}.passphrase`)
    await writeFile(passwordFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
    await writeFile(passphraseFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
    const plain = join(client, `${username}.key`), encrypted = join(client, `${username}.encrypted.key`)
    generate(plain, `${username}-plain`)
    generate(encrypted, `${username}-encrypted`, passphraseFile)
    await chmod(`${plain}.pub`, 0o600)
    await chmod(`${encrypted}.pub`, 0o600)
    const keys = await Promise.all([readFile(`${plain}.pub`), readFile(`${encrypted}.pub`)])
    await writeFile(join(server, `${username}.authorized_keys`), Buffer.concat(keys), { mode: 0o600, flag: 'wx' })
    users.push({ username, home: `/home/${username}`, passwordFile: `server/${username}.password`,
      privateKeyFile: `client/${username}.key`, encryptedPrivateKeyFile: `client/${username}.encrypted.key`,
      passphraseFile: `client/${username}.passphrase` })
  }
  const result = spawnSync(sshKeygen, ['-l', '-E', 'sha256', '-f', `${hostKey}.pub`],
    { env: environment, timeout: 10_000, maxBuffer: 4096, encoding: 'utf8' })
  const hostKeySha256 = result.stdout?.match(/\bSHA256:[A-Za-z0-9+/]{43}\b/u)?.[0]
  if (result.error || result.signal || result.status !== 0 || !hostKeySha256) {
    throw new PreparationError('host_fingerprint_failed')
  }
  await writeFile(join(destination, 'materials.json'), `${JSON.stringify({ port: 2222, hostKeySha256, users }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' })
  console.log('Private SSH fixture material prepared; inspect materials.json privately for file references and host fingerprint.')
}

prepare().catch(error => {
  console.error(`SSH fixture preparation failed: ${error instanceof PreparationError ? error.message : 'preparation_failed'}`)
  process.exitCode = 1
})
