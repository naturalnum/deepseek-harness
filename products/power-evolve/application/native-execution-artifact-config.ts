/** Compiled native dependency resolution shared by production utilities and explicit artifact tests. */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Rolldown } from 'tsdown'
import { z } from 'zod'

const applicationRoot = dirname(fileURLToPath(import.meta.url))

/** Credential-free utility bundles may leave only Node builtins as external imports. */
export const nativeWorkerImports: Rolldown.Plugin = {
  name: 'native-worker-imports',
  moduleParsed(info) {
    const unavailable = [...info.importedIds, ...info.dynamicallyImportedIds].filter(id =>
      !id.startsWith('.') && !id.startsWith('\0') && !isAbsolute(id) && !isBuiltin(id))
    if (unavailable.length) this.error('Native execution utility has unavailable external imports: ' + unavailable.join(', '))
  },
}

const root = resolve(applicationRoot, '../../..')
const manifestSchema = z.object({ name: z.string(), version: z.string(), main: z.string().optional(),
  exports: z.record(z.string(), z.unknown()).optional() }).loose()
const compiledPackages = new Map<string, { directory: string; manifest: z.infer<typeof manifestSchema> }>()
for (const family of readdirSync(resolve(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  for (const pkg of readdirSync(resolve(root, 'packages', family.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const directory = resolve(root, 'packages', family.name, pkg.name), path = resolve(directory, 'package.json')
    if (existsSync(path)) { const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); compiledPackages.set(manifest.name, { directory, manifest }) }
  }
}
for (const name of readdirSync(resolve(root, 'vendor'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(resolve(root, 'vendor', entry.name, 'package.json'))).map(entry => entry.name)) {
  const directory = resolve(root, 'vendor', name), manifest = manifestSchema.parse(JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')))
  compiledPackages.set(manifest.name, { directory, manifest })
}
/** Utility bundles consume emitted Host JavaScript; source aliases/decorators never enter a payload artifact. */
export const compiledNativePackages = { name: 'compiled-native-worker-artifacts', resolveId(source: string) {
  if (!source.startsWith('@deepseek-ai/')) return
  const name = source.split('/').slice(0, 2).join('/'), pkg = compiledPackages.get(name)
  if (!pkg) return
  const key = source === name ? '.' : './' + source.slice(name.length + 1)
  const selected = pkg.manifest.exports?.[key]
  const conditional = z.object({ import: z.string().optional(), default: z.string().optional() }).loose().safeParse(selected)
  const target = typeof selected === 'string' ? selected
    : (conditional.success ? conditional.data.import ?? conditional.data.default : undefined) ?? (key === '.' ? pkg.manifest.main : undefined)
  if (!target) throw new Error('Native worker requires an explicit compiled export: ' + source)
  const emitted = resolve(pkg.directory, target.replace(/^\.?\/lib\//u, 'lib/types/').replace(/\.[cm]js$/u, '.js'))
  const runtime = resolve(pkg.directory, target)
  if (existsSync(emitted)) return emitted
  if (existsSync(runtime)) return runtime
  throw new Error('Native worker compiled dependency is missing: ' + source)
} }

export const packageMetadata = { name: 'native-fs-worker-package-metadata', transform(code: string, id: string) {
  if (!/\/packages\/llm\/llm\/lib\/(?:types\/)?(?:index|attribution).js$/u.test(id)) return
  const metadata = manifestSchema.parse(JSON.parse(readFileSync(resolve(dirname(id),
    id.includes('/lib/types/') ? '../../package.json' : '../package.json'), 'utf8')))
  return code.replace(/createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/gu,
    JSON.stringify({ version: metadata.version }))
} }
