/** Run the native guest fixture with parent-owned temporary data and a process deadline. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const executable = process.argv[2], modulePath = process.argv[3]
assert(executable && modulePath, 'usage: node browser-guests-electron.mjs <electron executable> <compiled guest module>')
const root = await mkdtemp(join(tmpdir(), 'dsh-browser-guests-run-'))
let child, deadline, timedOut = false
try {
  child = spawn(resolve(executable), [fileURLToPath(new URL('./fixtures/browser-guests-electron.mjs', import.meta.url)),
    resolve(modulePath), root], { stdio: 'inherit', env: Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(key))) })
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { resolveExit({ code, signal }) })
  })
  deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45000)
  const result = await exited
  assert.equal(timedOut, false, 'native guest fixture exceeded its parent process deadline')
  assert.equal(result.signal, null, 'native guest fixture exited on a signal')
  assert.equal(result.code, 0, 'native guest fixture failed')
} finally {
  clearTimeout(deadline)
  await rm(root, { recursive: true, force: true })
}
