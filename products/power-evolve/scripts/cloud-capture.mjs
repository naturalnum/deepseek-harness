/** Native-only preload: capture V8's actual script text without opening a network debugger. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Session } from 'node:inspector'
import { threadId } from 'node:worker_threads'
import { nativeSourcePath, sourceHash } from './cloud-coverage.mjs'

const inputPath = process.env.PE_CLOUD_COVERAGE_INPUT
if (!inputPath) throw new Error('Native coverage preload requires frozen inputs')
const inputText = readFileSync(inputPath, 'utf8'), input = JSON.parse(inputText)
const executionRoot = input.executionRoot ?? input.physicalRoot
if (input.scope && sourceHash(readFileSync(resolve(executionRoot, input.scope.manifest))) !== input.scope.hash) {
  throw new Error('Native coverage: named scope manifest changed before collection')
}
const result = { pid: process.pid, threadId, inputHash: sourceHash(inputText), errors: [], scripts: {} }
const path = resolve(input.executionDirectory ?? input.directory, 'code', process.pid + '-' + threadId + '.json')
const save = () => writeFileSync(path, JSON.stringify(result))
const session = new Session()
session.connect()
session.on('Debugger.scriptParsed', ({ params }) => {
  const rel = nativeSourcePath(executionRoot, params.url)
  if (!Object.hasOwn(input.hashes, rel)) return
  session.post('Debugger.getScriptSource', { scriptId: params.scriptId }, (error, value) => {
    if (error) result.errors.push(rel + ': ' + error.message)
    else result.scripts[params.scriptId] = { url: params.url, code: value.scriptSource,
      hash: sourceHash(value.scriptSource), sourceMapURL: params.sourceMapURL,
      originalHash: sourceHash(readFileSync(resolve(executionRoot, rel))) }
    save()
  })
})
process.once('exit', save)
session.post('Debugger.enable', {}, (error) => {
  if (error) { result.errors.push(error.message); save(); throw error }
})
save()
