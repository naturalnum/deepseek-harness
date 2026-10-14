/** Compiled native dependency resolution shared by production utilities and explicit artifact tests. */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const applicationRoot = dirname(fileURLToPath(import.meta.url))


const root = resolve(applicationRoot, '../../..')
const compiledPackages = new Map<string, { directory: string; manifest: { main?: string; exports?: Record<string, unknown> } }>()
for (const family of readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  for (const pkg of readdirSync(resolve(root, 'packages', family.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const directory = resolve(root, 'packages', family.name, pkg.name), path = resolve(directory, 'package.json')
    if (existsSync(path)) { const manifest = JSON.parse(readFileSync(path, 'utf8')); compiledPackages.set(manifest.name, { directory, manifest }) }
  }
}
for (const name of readdirSync(resolve(root, 'vendor'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(resolve(root, 'vendor', entry.name, 'package.json'))).map(entry => entry.name)) {
  const directory = resolve(root, 'vendor', name), manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  compiledPackages.set(manifest.name, { directory, manifest })
}
/** Utility bundles consume emitted Host JavaScript; source aliases/decorators never enter a payload artifact. */
export const compiledNativePackages = { name: 'compiled-native-worker-artifacts', resolveId(source: string) {
  if (!source.startsWith('@deepseek-ai/')) return
  const name = source.split('/').slice(0, 2).join('/'), pkg = compiledPackages.get(name)
  if (!pkg) return
  const key = source === name ? '.' : './' + source.slice(name.length + 1)
  const selected = pkg.manifest.exports?.[key]
  const target = typeof selected === 'string' ? selected : selected && typeof selected === 'object' && ('import' in selected && typeof selected.import === 'string' || 'default' in selected && typeof selected.default === 'string') ? ('import' in selected && typeof selected.import === 'string' ? selected.import : selected.default as string) : key === '.' ? pkg.manifest.main : undefined
  if (!target) throw new Error('Native worker requires an explicit compiled export: ' + source)
  const emitted = resolve(pkg.directory, target.replace(/^\.?\/lib\//u, 'lib/types/').replace(/\.[cm]js$/u, '.js'))
  const runtime = resolve(pkg.directory, target)
  if (existsSync(emitted)) return emitted
  if (existsSync(runtime)) return runtime
  throw new Error('Native worker compiled dependency is missing: ' + source)
} }

export const packageMetadata = { name: 'native-fs-worker-package-metadata', transform(code, id) {
    if (!/\/packages\/llm\/llm\/lib\/(?:types\/)?(?:index|attribution).js$/u.test(id)) return
    const metadata = JSON.parse(readFileSync(resolve(dirname(id), id.includes('/lib/types/') ? '../../package.json' : '../package.json'), 'utf8'))
    return code.replace(/createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/gu,
      JSON.stringify({ version: metadata.version }))
  } }
