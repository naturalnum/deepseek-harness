/** Gate the original SDK owner and local acknowledgement persistence without Docker. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

it('retains exact provider completion through ACK loss, restart and final original reference release', () => {
  const script = fileURLToPath(new URL('./test_deletion_acknowledgement.py', import.meta.url))
  execFileSync('python3', ['-I', '-S', '-B', script], { timeout: 15000, stdio: 'pipe' })
}, 20000)
