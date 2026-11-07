/** Run offline Python context checks in the ordinary test lane; no SDK or Docker is invoked. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

it('keeps candidate server generation COPY-only, source-pinned and separate from creation admission', () => {
  execFileSync('python3', ['-I', '-S', '-B', fileURLToPath(new URL('./test_supplier_server_recipe.py', import.meta.url))],
    { timeout: 10000, stdio: 'pipe' })
})
