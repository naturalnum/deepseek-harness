/** Run the fixed source37 Runner only inside the owned compatibility fixture cluster. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRunner } from '/opt/pe-ci-original/products/power-evolve/sandbox/runner.mjs'
import { StdioCloudRuntimeV2 } from '/opt/pe-ci-original/products/power-evolve/connector-runner/src/stdio-v2-runtime.ts'

export const name = 'ci-schema37-runner'

/** Mount the original Runner factory through a named current dsh launcher; no archived lib is imported.
 * @param ctx Current launcher readiness and owned disposal lifecycle.
 */
export async function apply(ctx) {
  const path = process.env.PE_RUNNER_STDIO_V2_CONFIG_FILE
  const stdio = path ? JSON.parse(await readFile(path, 'utf8')) : undefined
  const runner = createRunner({ token: (await readFile('/run/power-evolve/runner-token', 'utf8')).trim(), stdio },
    stdio ? { createStdioRuntime: options => new StdioCloudRuntimeV2(options) } : {})
  ctx.effect(() => async () => { assert.equal((await runner.shutdown()).writerStopConfirmed, true) })
  await new Promise((resolve, reject) => { runner.server.once('error', reject); runner.server.listen(8080, '0.0.0.0', resolve) })
}
