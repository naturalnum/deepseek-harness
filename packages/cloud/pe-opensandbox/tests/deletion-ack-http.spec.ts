/** Run the private HTTP integration when the exact original SDK wheel is available. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const wheel = process.env['DSH_S08_ACK_SERVER_WHEEL']

it.runIf(wheel !== undefined)('replays a private ACK through original authentication after an actual service restart', () => {
  const script = fileURLToPath(new URL('./test_deletion_ack_http.py', import.meta.url))
  execFileSync('python3', ['-I', '-B', script, '--wheel', wheel ?? ''], { timeout: 20000, stdio: 'pipe' })
}, 25000)
