/** Test-only OS/native stand-ins; the real worker entry/configuration/proof implementation remains intact. */
import fs from 'node:fs'
import Module, { syncBuiltinESMExports } from 'node:module'
import { workerData, threadId } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const fixture = workerData.fixture
Object.defineProperty(process, 'platform', { value: 'linux' })
process.getuid = () => 1000
process.geteuid = () => 1000
const ancestors = new Set()
for (const file of [workerData.helperPath, workerData.storageProbe.probeHelperPath]) {
  for (let current = file;; current = dirname(current)) {
    ancestors.add(current)
    if (current === '/') break
  }
}
const lstat = fs.lstatSync, fstat = fs.fstatSync, open = fs.openSync
fs.lstatSync = (file, ...args) => {
  const info = lstat(file, ...args)
  if (ancestors.has(file)) { info.uid = 0; info.mode &= ~0o022 }
  return info
}
fs.fstatSync = (...args) => { const info = fstat(...args); info.uid = 0; return info }
const proc = join(fixture.root, `proc-${threadId}.txt`), fields = Array(20).fill('1')
fields[0] = 'S'; fields[19] = '12345'
fs.writeFileSync(proc, `${process.pid} (proof worker fixture) ${fields.join(' ')}\n`)
fs.openSync = (file, ...args) => open(file === '/proc/self/stat' ? proc : file, ...args)
syncBuiltinESMExports()
const native = Module._extensions['.node']
Module._extensions['.node'] = (module, file) => file === workerData.helperPath
  ? Module._extensions['.js'](module, file) : native(module, file)
await import(pathToFileURL(fixture.entry).href)
