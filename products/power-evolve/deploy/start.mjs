/** Render and launch a named cloud Profile from an operator-owned deployment document. */
import { spawn } from 'node:child_process'
import { lstat, readFile, readlink, readdir, rm, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load, JSON_SCHEMA, Type } from 'js-yaml'
import { durableJson, durableText, privateDirectory, privateJson, processIdentity, reserveProfile, superviseChild } from './lifecycle.mjs'

const repository = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const roles = ['host', 'platform', 'native-runtime']
const entrySchema = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: value => ({ __jsExpr: value }),
  predicate: value => object(value) && typeof value.__jsExpr === 'string',
  represent: value => value.__jsExpr,
}))
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function absolute(value) { return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value !== '/' && !/\p{Cc}/u.test(value) }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value)) return Object.fromEntries(Object.keys(value).toSorted().map(key => [key, canonical(value[key])]))
  return value
}
function profileIdentity(role, config) {
  if (role === 'native-runtime') {
    if (!config.runtimeIdentity) throw new Error('Native runtime requires an account process identity')
    return { format: 3, repository, role, userId: config.runtimeIdentity.userId, profileSchema: 1 }
  }
  return { format: 2, repository, role, deployment: createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex') }
}
function incarnation(role, config, directory) {
  if (role !== 'native-runtime') return { directory, owner: profileIdentity(role, config) }
  return { directory: join(config.dshHome, 'runtime-incarnations', config.runtimeIdentity.runtimeId),
    owner: { ...profileIdentity(role, config), ...config.runtimeIdentity } }
}
function origin(value, local) {
  const url = new URL(value)
  if (url.origin !== value || url.username || url.password || (local
    ? url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    : url.protocol !== 'https:')) throw new Error('Invalid public origin')
  return url
}

/** Validate operator paths, origins and override rows before writing a Profile.
 * @param value Parsed deployment JSON; contains file references, never credential values.
 * @returns Validated deployment document; plugin Config validation remains Loader-owned.
 */
export function deployment(value) {
  if (!object(value) || Object.keys(value).some(key => !['mode', 'privateDir', 'dshHome', 'hostOrigin',
    'platformOrigin', 'platformInternalUrl', 'rows', 'runtimeIdentity'].includes(key)) || !['https', 'local-http'].includes(value.mode)
    || !absolute(value.privateDir) || !absolute(value.dshHome) || !object(value.rows)) throw new Error('Invalid cloud deployment')
  if (value.runtimeIdentity !== undefined && (!object(value.runtimeIdentity)
    || Object.keys(value.runtimeIdentity).some(key => !['userId', 'runtimeId', 'generation'].includes(key))
    || ![value.runtimeIdentity.userId, value.runtimeIdentity.runtimeId].every(id => typeof id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id))
    || !Number.isSafeInteger(value.runtimeIdentity.generation) || value.runtimeIdentity.generation < 1)) {
    throw new Error('Invalid native runtime process identity')
  }
  const local = value.mode === 'local-http'
  const host = origin(value.hostOrigin, local), platform = origin(value.platformOrigin, local)
  if (host.origin === platform.origin || (local && host.hostname !== platform.hostname)) throw new Error('Invalid distinct origins')
  const internal = new URL(value.platformInternalUrl)
  if (!['http:', 'https:'].includes(internal.protocol) || internal.origin !== value.platformInternalUrl
    || internal.username || internal.password) throw new Error('Invalid internal Platform origin')
  for (const [role, rows] of Object.entries(value.rows)) {
    if (!roles.includes(role) || !object(rows)) throw new Error('Invalid deployment role')
    for (const [id, config] of Object.entries(rows)) {
      if (!/^[a-z][a-z0-9-]*$/u.test(id) || !object(config)) throw new Error('Invalid override row')
    }
  }
  return value
}

/** Create an owned Profile using the product bundle, leaving unrelated Profiles untouched.
 * @param role Host or Platform role.
 * @param raw Operator-owned deployment JSON.
 * @returns Exact Profile name and ready-file path for the named DSH launcher.
 */
export async function renderProfile(role, raw) {
  if (!roles.includes(role)) throw new Error('Choose a supported cloud Profile role')
  const config = deployment(raw)
  const name = `power-evolve-cloud-${role}`
  const directory = join(config.dshHome, 'profiles', name)
  await privateDirectory(config.dshHome)
  const owner = profileIdentity(role, config)
  const launch = incarnation(role, config, directory)
  const lock = await reserveProfile(launch.directory, launch.owner)
  try { return await renderReservedProfile(role, config, { name, directory, lifecycleDirectory: launch.directory }, owner) }
  finally { await lock.release() }
}

async function renderReservedProfile(role, config, profile, owner) {
  const { name, directory, lifecycleDirectory = directory } = profile
  const bundle = join(repository, 'products/power-evolve', role)
  const manifest = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'))
  const marker = join(directory, 'power-evolve-owner.json')
  const previous = await privateJson(marker)
  if (previous === null) {
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).length) throw new Error('Refusing an unowned Profile')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (previous !== null && JSON.stringify(previous) !== JSON.stringify(owner)) throw new Error('Refusing another deployment Profile')
  await privateDirectory(directory)
  if (lifecycleDirectory !== directory) await privateDirectory(lifecycleDirectory)
  const lifecycle = await privateJson(join(lifecycleDirectory, 'lifecycle.json'))
  if (lifecycle !== null) {
    if (lifecycle.phase !== 'stopped' || JSON.stringify(lifecycle.owner) !== JSON.stringify(incarnation(role, config, directory).owner)
      || !lifecycle.exit || lifecycle.exit.code === null && typeof lifecycle.exit.signal !== 'string') throw new Error('Profile lifecycle is uncertain')
    for (const identity of [lifecycle.parent, lifecycle.child]) {
      if (identity && await processIdentity(identity.pid)) throw new Error('Prior Profile process or reused PID remains active')
    }
  }
  const readyFile = join(lifecycleDirectory, 'ready.json')
  try {
    await lstat(readyFile)
    if (lifecycle === null) throw new Error('Prior ready file has no exact stop evidence')
    await rm(readyFile)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const rows = new Map(Object.entries(config.rows[role] ?? {}))
  const source = await readFile(join(bundle, 'cordis.patch.yml'), 'utf8')
  const entries = load(source, { schema: entrySchema }).flatMap(patch => patch.insert ?? (patch.id ? [patch] : []))
  const ids = new Set(entries.map(entry => entry.id))
  for (const id of rows.keys()) if (!ids.has(id)) throw new Error(`Unknown bundle row ${id}`)
  const add = (id, fields) => rows.set(id, { ...rows.get(id), ...fields })
  if (role === 'host' || role === 'native-runtime') {
    add('power-evolve-runtime', { platformUrl: config.platformInternalUrl })
    add('power-evolve-host', { origin: config.hostOrigin, platformOrigin: config.platformOrigin, readyFile })
  } else add('power-evolve-platform', { hostOrigin: config.hostOrigin, platformOrigin: config.platformOrigin, readyFile })
  for (const [id, fields] of rows) rows.set(id, { ...entries.find(entry => entry.id === id).config, ...fields })
  const modules = join(directory, 'node_modules/@power-evolve')
  await privateDirectory(join(directory, 'node_modules'))
  await privateDirectory(modules)
  const link = join(modules, role)
  try { await symlink(bundle, link, 'dir') }
  catch (error) { if (error.code !== 'EEXIST' || await readlink(link) !== bundle) throw error }
  const bundles = [manifest.name], dependencies = { [manifest.name]: manifest.version }
  if (role === 'native-runtime') {
    const nativeModules = join(directory, 'node_modules/@deepseek-ai')
    await privateDirectory(nativeModules)
    for (const nativeBundle of ['base', 'web-app']) {
      const target = join(repository, 'packages/bundle', nativeBundle)
      const nativeManifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
      const alias = join(nativeModules, nativeManifest.name.split('/')[1])
      try { await symlink(target, alias, 'dir') }
      catch (error) { if (error.code !== 'EEXIST' || await readlink(alias) !== target) throw error }
      bundles.unshift(nativeManifest.name); dependencies[nativeManifest.name] = nativeManifest.version
    }
    // The web-app patch consumes the maintained base composition.
    bundles.splice(0, bundles.length, '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name)
  }
  await durableJson(marker, owner)
  if (role === 'native-runtime' && previous !== null) {
    // User-owned native patches and installed package dependencies persist across pool generations.
    const profilePatch = join(directory, 'cordis.patch.yml')
    const retained = load(await readFile(profilePatch, 'utf8'), { schema: entrySchema })
    if (!Array.isArray(retained)) throw new Error('Native Profile patch is invalid')
    const controlled = ['power-evolve-runtime', 'power-evolve-host', 'webserver']
    const preserved = retained.filter(patch => !controlled.includes(patch?.id))
    await durableText(profilePatch, dump([...preserved, ...controlled.map(id => ({ id, config: rows.get(id), disabled: false }))],
      { schema: entrySchema }))
  } else {
    await durableJson(join(directory, 'package.json'), { name, private: true, type: 'module',
      dependencies, dsh: { profile: { bundles } } })
    await durableText(join(directory, 'cordis.patch.yml'), dump([...rows].map(([id, fields]) => ({ id, config: fields })), { schema: entrySchema }))
  }
  return { name, directory, readyFile, lifecycleDirectory }
}

/** Launch only the rendered named DSH Profile and forward shutdown to its exact child.
 * @param role Host or Platform role.
 * @param config Validated private deployment document.
 * @returns Completion when the owned DSH child exits.
 */
export async function launch(role, config) {
  if (!roles.includes(role)) throw new Error('Choose a supported cloud Profile role')
  config = deployment(config)
  await privateDirectory(config.dshHome)
  const name = `power-evolve-cloud-${role}`, directory = join(config.dshHome, 'profiles', name)
  const owner = profileIdentity(role, config), launchIdentity = incarnation(role, config, directory)
  const lock = await reserveProfile(launchIdentity.directory, launchIdentity.owner)
  let profile
  try { profile = await renderReservedProfile(role, config, { name, directory, lifecycleDirectory: launchIdentity.directory }, owner) }
  catch (error) { await lock.release(); throw error }
  const child = spawn(process.execPath, [join(repository, 'apps/cli/lib/bin.js'), '--profile', profile.name], {
    cwd: repository, stdio: 'inherit', env: { ...process.env, DSH_HOME: config.dshHome, PE_PRIVATE_DIR: config.privateDir,
      PE_HOST_PUBLIC_ORIGIN: config.hostOrigin, PE_PLATFORM_PUBLIC_ORIGIN: config.platformOrigin },
  })
  await superviseChild(child, lock, join(profile.lifecycleDirectory, 'lifecycle.json'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = deployment(await privateJson(resolve(process.argv[3])))
  if (process.argv[4] === '--render') console.log(JSON.stringify(await renderProfile(process.argv[2], config)))
  else await launch(process.argv[2], config)
}
