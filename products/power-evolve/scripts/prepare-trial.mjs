/** Prepare a separate local trial without printing or committing secrets. */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, symlink, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const privateDir = process.env.PE_PRIVATE_DIR ?? join(homedir(), '.config/power-evolve/shared-host-slice-1')
await mkdir(privateDir, { recursive: true, mode: 0o700 }); await chmod(privateDir, 0o700)
async function provision(name, value) {
  const path = join(privateDir, name)
  try { await writeFile(path, value, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await chmod(path, 0o600)
  return (await readFile(path, 'utf8')).trim()
}
const password = await provision('database-password', randomBytes(24).toString('base64url'))
await provision('database-url', `postgresql://powerevolve:${password}@127.0.0.1:18432/powerevolve`)
await provision('worker-token', randomBytes(32).toString('base64url'))
let modelKey = process.env.DEEPSEEK_API_KEY
if (!modelKey) {
  const env = await readFile(join(privateDir, 'model.env'), 'utf8')
  modelKey = env.split('\n').find(line => line.startsWith('DEEPSEEK_API_KEY='))?.slice('DEEPSEEK_API_KEY='.length).trim()
}
if (!modelKey) throw new Error('Provide a model.env or DEEPSEEK_API_KEY before preparing the real-model trial')
await provision('model-key', modelKey)
await provision('users.json', JSON.stringify(['alice', 'bob'].map((username, index) => ({
  username, password: randomBytes(20).toString('base64url'), settings: { model: 'deepseek-flash', maxTokens: index === 0 ? 2048 : 1536, revision: 1 },
})), null, 2) + '\n')
for (const name of ['host', 'platform']) {
  const home = join(root, '.artifacts/power-evolve/trial', name)
  const profile = join(home, 'profiles', `power-evolve-${name}`)
  const modules = join(profile, 'node_modules/@power-evolve')
  await mkdir(modules, { recursive: true, mode: 0o700 })
  const manifest = { name: `power-evolve-trial-${name}`, private: true, type: 'module', dependencies: { [`@power-evolve/${name}`]: '0.1.0' }, dsh: { profile: { bundles: [`@power-evolve/${name}`] } } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  try { await symlink(join(root, 'products/power-evolve', name), join(modules, name), 'dir') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
}
console.log('Prepared isolated PowerEvolve trial configuration; credentials were not printed.')
