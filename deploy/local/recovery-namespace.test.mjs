import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { buildRecoveryLaunchCommand } from './recovery-namespace.mjs'

test('the direct shell entry preserves its actual process id and original three administrator descriptors until close', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'recovery-launch-'))
  t.after(() => fs.rm(directory, { recursive: true }))
  const paths = Object.fromEntries(['launcher', 'input', 'log', 'measurement', 'ready', 'journal'].map(name => [name, join(directory, name)]))
  for (const path of Object.values(paths)) await fs.writeFile(path, '', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(paths.launcher, `set -eu
test "$#" = 5 && test "$1" = launch && test "$2" = --input && test "$4" = --sha256
printf '%s\\n' "$$"
printf 'measured-fixture' >&3
printf 'ready-fixture' >&4
printf 'journal-fixture' >&5
exec /bin/sleep 0.01
`)
  const argv = buildRecoveryLaunchCommand({ ...paths, inputSha256: 'a'.repeat(64) })
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' })
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  assert.deepEqual(outcome, { code: 0, signal: null })
  assert.equal(Number((await fs.readFile(paths.log, 'utf8')).trim()), child.pid)
  for (const [name, value] of [['measurement', 'measured-fixture'], ['ready', 'ready-fixture'], ['journal', 'journal-fixture']]) {
    assert.equal(await fs.readFile(paths[name], 'utf8'), value)
    assert.equal((await fs.lstat(paths[name])).mode & 0o777, 0o600)
  }
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH')
})
