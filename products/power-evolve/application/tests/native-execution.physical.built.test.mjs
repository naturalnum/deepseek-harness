/** Artifact-plane physical admission through an explicitly owned Linux controller and namespace. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)

test('Linux artifacts provide native Fs and generation-fenced physical execution', { timeout: 360000 }, async () => {
  const path = process.env.PE_NATIVE_EXECUTION_PHYSICAL_OWNER_FILE
  if (!path) throw new Error('PE_NATIVE_EXECUTION_PHYSICAL_OWNER_FILE must name actual owned Linux inputs')
  const owner = JSON.parse(await readFile(path, 'utf8'))
  assert.match(owner.controllerId, /^[a-f0-9]{64}$/u); assert.match(owner.id, /^[a-f0-9-]{36}$/u)
  const inspect = JSON.parse((await exec('docker', ['inspect', owner.controllerId], { maxBuffer: 1048576 })).stdout)[0]
  assert.equal(inspect.Id, owner.controllerId); assert.equal(inspect.Config.Labels['codex.owner'], owner.id)
  assert.equal(inspect.Name, '/' + owner.controller); assert.equal(inspect.State.Running, true)
  await exec('docker', ['cp', fileURLToPath(new URL('./native-execution-physical-case.mjs', import.meta.url)),
    owner.controllerId + ':/opt/power-evolve/products/power-evolve/application/tests/native-execution-physical-case.mjs'])
  const result = await exec('docker', ['exec', '-e', 'PE_NATIVE_EXECUTION_PHYSICAL_INPUT=/input/physical-input.private.json',
    owner.controllerId, 'node', '--test', '/opt/power-evolve/products/power-evolve/application/tests/native-execution-physical-case.mjs'],
  { timeout: 330000, maxBuffer: 4 * 1024 * 1024 })
  assert.match(result.stdout, /# pass 1\n/u); assert.match(result.stdout, /# fail 0\n/u)
})
