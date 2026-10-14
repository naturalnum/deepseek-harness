/** Build the CLI, cloud application and native Web graph inside the isolated Linux source stage. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'

const root = process.cwd()
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error || result.status !== 0) throw new Error('Cold Linux build failed: ' + command + ' ' + args.join(' '))
}
const roots = ['vendor', 'packages', 'native/system/packages', 'apps', 'products/power-evolve']
const manifests = []
for (const prefix of roots) {
  for (const entry of readdirSync(prefix, { withFileTypes: true }).filter(candidate => candidate.isDirectory())) {
    const path = join(prefix, entry.name)
    if (prefix === 'packages') {
      for (const child of readdirSync(path, { withFileTypes: true }).filter(candidate => candidate.isDirectory())) {
        if (existsSync(join(path, child.name, 'package.json'))) manifests.push(join(path, child.name))
      }
    } else if (existsSync(join(path, 'package.json'))) manifests.push(path)
  }
}
const packages = new Map(manifests.map((path) => {
  const value = JSON.parse(readFileSync(join(path, 'package.json')))
  return [value.name, { path, value }]
}))
const patchSchema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
const patch = load(readFileSync('packages/bundle/web-app/cordis.patch.yml', 'utf8'), { schema: patchSchema })
const profilePatches = ['host', 'platform', 'native-runtime'].map(role => 'products/power-evolve/' + role + '/cordis.patch.yml')
  .concat(['base', 'web-app'].map(role => 'packages/bundle/' + role + '/cordis.patch.yml'),
    ['standard', 'ptc', 'minimal', 'cordis'].map(preset => 'packages/bundle/web-app/presets/' + preset + '.patch.yml'))
function pluginPackages(value) {
  if (Array.isArray(value)) return value.flatMap(pluginPackages)
  if (value === null || typeof value !== 'object') return []
  const names = typeof value.name === 'string' && /^@(?:deepseek-ai|power-evolve)\//u.test(value.name) ? [value.name] : []
  return names.concat(Object.values(value).flatMap(pluginPackages))
}
const profilePackages = [...new Set(profilePatches.flatMap(path =>
  pluginPackages(load(readFileSync(path, 'utf8'), { schema: patchSchema })).map((name) => {
    const id = name.split('/').slice(0, 2).join('/')
    const record = packages.get(id)
    if (!record) throw new Error('Missing declared product Profile package: ' + id)
    return record.path
  })))]
function profilePrograms(face) {
  return profilePackages.flatMap((path) => {
    const leaf = join(path, 'tsconfig.' + face + '.json')
    if (existsSync(leaf)) return [leaf]
    const program = join(path, 'tsconfig.json'), parsed = ts.readConfigFile(program, ts.sys.readFile)
    if (parsed.error) throw new Error('Missing declared Profile type program: ' + program)
    if (parsed.config.files?.length === 0 && parsed.config.references?.length) return []
    const client = parsed.config.extends?.endsWith('tsconfig.base.client.json') === true
    return client === (face === 'client') ? [program] : []
  })
}
const profileHostPrograms = profilePrograms('host'), profileClientPrograms = profilePrograms('client')
const pending = [...patch.flatMap(row => row.insert ?? []).filter(row => row.disabled === undefined)
  .map(row => row.name.startsWith('@') ? row.name.split('/').slice(0, 2).join('/') : row.name.split('/')[0]),
'@deepseek-ai/dsh-client-ui-directory-picker-browse', '@power-evolve/client-account', '@power-evolve/client-extension-center']
const selected = new Set()
while (pending.length > 0) {
  const id = pending.shift(), record = packages.get(id)
  if (!record) throw new Error('Missing official Web roster package: ' + id)
  if (selected.has(record.path) || record.value.dsh?.client?.platform !== 'web') continue
  selected.add(record.path)
  for (const dependency of record.value.dsh.client.inject ?? []) {
    if (packages.get(dependency)?.value.dsh?.client?.platform === 'web') pending.push(dependency)
  }
}
const web = [...selected]
const initial = ['apps/cli/tsconfig.json', 'products/power-evolve/application/tsconfig.json',
  'products/power-evolve/client-account/tsconfig.json', 'products/power-evolve/client-extension-center/tsconfig.json',
  'packages/typert/generator/tsconfig.json',
  ...profileHostPrograms, ...profileClientPrograms,
  ...web.flatMap((path) => {
    const faces = ['tsconfig.host.json', 'tsconfig.client.json'].map(name => join(path, name)).filter(existsSync)
    return faces.length > 0 ? faces : [join(path, 'tsconfig.json')]
  })]
const projects = new Set()
function visit(path) {
  path = resolve(path)
  if (!path.endsWith('.json')) path = join(path, 'tsconfig.json')
  if (projects.has(path)) return
  const parsed = ts.readConfigFile(path, ts.sys.readFile)
  if (parsed.error) throw new Error('Missing required image type program: ' + path)
  projects.add(path)
  for (const ref of parsed.config.references ?? []) visit(resolve(dirname(path), ref.path))
}
for (const path of initial) visit(path)
const programPath = path => resolve(path.endsWith('.json') ? path : join(path, 'tsconfig.json'))
const faceRoots = face => ts.readConfigFile('tsconfig.' + face + '.json', ts.sys.readFile).config.references
  .map(ref => programPath(ref.path)).filter(path => [...projects].some(project => dirname(project) === dirname(path)))
const host = [...new Set([...faceRoots('host'), ...profileHostPrograms.map(programPath), ...['apps/cli/tsconfig.json', 'products/power-evolve/application/tsconfig.json',
  'packages/typert/generator/tsconfig.json'].map(programPath)])]
const client = [...new Set([...faceRoots('client'), ...profileClientPrograms.map(programPath), ...['products/power-evolve/client-account/tsconfig.json',
  'products/power-evolve/client-extension-center/tsconfig.json'].map(programPath)])]
writeFileSync('tsconfig.host.json', JSON.stringify({ extends: './tsconfig.base.json', files: [], references: host.map(path => ({ path: relative(root, path) })) }))
writeFileSync('tsconfig.client.json', JSON.stringify({ extends: './tsconfig.base.client.json', files: [], references: client.map(path => ({ path: relative(root, path) })) }))
projects.clear()
for (const path of host) visit(path)
const hostProjects = new Set(projects)
run('pnpm', ['exec', 'tsc', '-b', 'tsconfig.host.json', '--pretty', 'false'])
run('pnpm', ['run', 'build:native-system'])
const workspacePaths = paths => [...new Set([...paths].map(path => relative(root, dirname(path))))]
  .filter(path => !path.startsWith('native/system/packages/') && !path.startsWith('products/') && existsSync(join(path, 'package.json')))
const hostWorkspaces = workspacePaths(hostProjects)
writeFileSync('cloud-image.tsdown.config.ts', `import {defineConfig} from 'tsdown';import{typertPlugin}from'./packages/typert/generator/lib/types/tsdown-plugin.js';
export default defineConfig({workspace:${JSON.stringify(hostWorkspaces)},entry:['lib/types/{index,startup}.js'],outDir:'lib',format:['esm'],platform:'node',target:'es2024',fixedExtension:false,dts:false,clean:false,plugins:[typertPlugin({mode:'workspace',faces:['host']})]});\n`)
run('pnpm', ['exec', 'tsdown', '--config-loader', 'native', '--config', 'cloud-image.tsdown.config.ts', '--env.DSH_BUILD_FACE', 'host'])
for (const path of client) visit(path)
const workspaces = workspacePaths(projects)
run('pnpm', ['exec', 'tsc', '-b', 'tsconfig.client.json', '--pretty', 'false'])
writeFileSync('cloud-image.client.tsdown.config.ts', `import{defineConfig}from'tsdown';
export default defineConfig({workspace:${JSON.stringify(workspaces)},entry:'',outDir:'lib',format:['esm'],platform:'node',target:'es2024',fixedExtension:false,dts:false,clean:false});\n`)
run('pnpm', ['exec', 'tsdown', '--config-loader', 'native', '--config', 'cloud-image.client.tsdown.config.ts', '--env.DSH_BUILD_FACE', 'client'])
for (const path of ['contracts', 'connector-runner', 'application', 'client-account', 'client-extension-center']) {
  run('pnpm', ['--dir', 'products/power-evolve/' + path, 'exec', 'tsdown', '--config-loader', 'native'])
}
writeFileSync('cloud-image.sandbox.tsdown.config.ts', `import{defineConfig}from'tsdown';
export default defineConfig({entry:{'stdio-v2-runtime':'products/power-evolve/connector-runner/lib/stdio-v2-runtime.js'},outDir:'products/power-evolve/sandbox/lib',format:'esm',platform:'node',target:'es2024',fixedExtension:true,clean:true,dts:false,deps:{alwaysBundle:[/.*/u]},failOnWarn:true});\n`)
run('pnpm', ['exec', 'tsdown', '--config-loader', 'native', '--config', 'cloud-image.sandbox.tsdown.config.ts'])
run('pnpm', ['exec', 'tsdown', '--config-loader', 'native', '--config', 'products/power-evolve/deploy/tsdown.attachment.config.ts'])
run('pnpm', ['--dir', 'apps/web', 'exec', 'vite', 'build', '--config', '../../products/power-evolve/deploy/cloud-image.vite.config.ts'])
run('node', ['products/power-evolve/cloud-web/scripts/build.mjs'])
writeFileSync('image-build.json', JSON.stringify({ platform: process.platform, architecture: process.arch, node: process.version,
  projects: [...projects].map(path => relative(root, path)), workspaces, nativeFlockBuilt: true, desktopBuilt: false }) + '\n')
