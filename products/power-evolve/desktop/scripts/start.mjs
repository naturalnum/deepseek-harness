/** Launch the built Cloud carrier with a reviewed Electron executable and local deployment file. */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const executable = process.env.PE_DESKTOP_ELECTRON
if (!executable) throw new Error('Set PE_DESKTOP_ELECTRON to the prepared Electron executable')
await access(resolve(root, 'lib/main.js'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/iu.test(key)))
const child = spawn(executable, [root, ...process.argv.slice(2)], { env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
child.once('error', () => { process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = signal === null ? code ?? 1 : 1 })
