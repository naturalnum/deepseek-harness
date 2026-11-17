/** Test-only credential provider reads the assigned database without exposing its values. */
import { readFile } from 'node:fs/promises'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
export default class extends CredentialProvider {
  async resolve() {
    const config = JSON.parse(await readFile(process.env.DSH_RUNTIME_ROOT_PG_PRIVATE_CONFIG, 'utf8'))
    return { value: config.password, source: 'isolated-lifecycle-test' }
  }
}
