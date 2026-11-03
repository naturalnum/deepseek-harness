/** Guest source regressions. No listener/container/Target; Python documents its scripted kernel and local FD scope. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('checks original guest wire/Manager, local pipes/fd7 and selected protected WS inputs', () => {
  const script = fileURLToPath(new URL('./test_execution_stream.py', import.meta.url))
  const output = execFileSync('python3', ['-I', '-S', '-B', script], {
    timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(output).toBe('')
})
