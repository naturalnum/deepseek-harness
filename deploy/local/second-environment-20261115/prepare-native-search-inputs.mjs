/** Prepare new Root/account search inputs; never install profiles, read keys, or start an application. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const need = (value, message) => { if (!value) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  need(value === null || ['string', 'boolean', 'number'].includes(typeof value)
    && (typeof value !== 'number' || Number.isFinite(value)), 'Finite JSON declaration required')
  return JSON.stringify(value)
}
const read = file => {
  const st = fs.lstatSync(file)
  need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= 1048576,
    'Bounded ordinary input required')
  return fs.readFileSync(file)
}
const absolute = value => {
  need(typeof value === 'string' && value.startsWith('/') && path.posix.normalize(value) === value
    && !/[\0\r\n]/.test(value), 'Canonical absolute input path required')
  return value
}
const pinned = ref => {
  const bytes = read(absolute(ref.path))
  need(hash(bytes) === ref.sha256, 'Pinned source changed')
  return bytes
}
const options = {}, args = process.argv.slice(2)
while (args.length) {
  const key = args.shift(), value = args.shift()
  need(['--input', '--sha256', '--output-dir', '--check-only'].includes(key) && value !== undefined
    && options[key] === undefined, 'Exact input, digest and output arguments required')
  options[key] = value
}
need(options['--check-only'] === undefined || options['--check-only'] === 'true', 'Only explicit check-only true is permitted')
const checkOnly = options['--check-only'] === 'true'
need(checkOnly || process.platform === 'linux' && process.getuid() === 0, 'Only Root writes deployment inputs')
const raw = read(absolute(options['--input']))
need(hash(raw) === options['--sha256'], 'Exact original input digest required')
const input = JSON.parse(raw), output = absolute(options['--output-dir'])
need(input.schema === 'dsh-combined-root-profile/v3' && !fs.existsSync(output),
  'Original profile input and a new output directory required')
const skeleton = JSON.parse(pinned(input.accountSkeleton))
const baseBytes = read(absolute(input.paths.nativeConfigPath))
need(hash(baseBytes) === input.nativeBaseSha256, 'Original measured shared base changed')
const req = createRequire(input.installAnchor)
const { composeEntries } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
const effective = composeEntries([[{ insert: JSON.parse(baseBytes) }], skeleton], message => {
  throw new Error('Native account composition warning: ' + message)
})
function bounded(value) {
  if (value === null || typeof value !== 'object') return 0
  let count = 0
  if (value.name === '@deepseek-ai/dsh-tool-fs-search' || value.name === 'cordis:tool-fs-search') {
    value.config = { ...value.config, rawOutputMaxBytes: 4096, stderrMaxBytes: 4096 }
    count++
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const item of child) count += bounded(item)
    else if (child !== null && typeof child === 'object') count += bounded(child)
  }
  return count
}
let searchEntries = 0
for (const preset of input.runtime.accountPolicy.presets) {
  const original = effective.find(item => item.id === preset.entryId)
  need(original && hash(canonical(original.config)) === preset.configSha256,
    'Original approved preset differs: ' + preset.id)
  const config = structuredClone(original.config), count = bounded(config)
  if (count === 0) continue
  searchEntries += count
  const overrides = skeleton.flatMap(item => item.insert ?? [item]).filter(item => item.id === preset.entryId)
  need(overrides.length <= 1, 'Duplicate public preset override')
  if (overrides.length) overrides[0].config = config
  else skeleton.push({ id: preset.entryId, config })
  preset.configSha256 = hash(canonical(config))
}
need(searchEntries > 0, 'Native search entries required')
const commands = input.execution.managed.commands
const additional = commands.additionalTools ?? []
need(Array.isArray(additional) && additional.length <= 30
  && !commands.allowedTools.includes('glob') && !commands.allowedTools.includes('grep'),
  'Original additional consumers and capacity required')
commands.additionalTools = [...additional, 'glob', 'grep']
commands.allowedTools = [...commands.allowedTools, 'glob', 'grep']
input.runtime.singleInstance = true
const skeletonBytes = JSON.stringify(skeleton, null, 2) + '\n'
const skeletonPath = output + '/account-profile.native-search.json'
input.accountSkeleton = { path: skeletonPath, sha256: hash(skeletonBytes) }
const parameterBytes = JSON.stringify(input, null, 2) + '\n'
if (checkOnly) {
  console.log(JSON.stringify({ status: 'native-search-inputs-checked-no-write', parameterSha256: hash(parameterBytes),
    skeletonSha256: hash(skeletonBytes), searchEntries, additionalConsumersPreserved: additional.length,
    searchOutputMaxBytes: 4096, existingProfilesWritten: 0, credentialsRead: false, applicationStarted: false }))
  process.exit(0)
}
fs.mkdirSync(output, { mode: 0o700 })
function write(name, bytes, mode) {
  const fd = fs.openSync(path.join(output, name), 'wx', mode)
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
}
write('account-profile.native-search.json', skeletonBytes, 0o444)
write('root-parameters.native-search.json', parameterBytes, 0o600)
console.log(JSON.stringify({ prepared: true, parameterPath: output + '/root-parameters.native-search.json',
  parameterSha256: hash(parameterBytes), searchEntries, additionalConsumersPreserved: additional.length,
  searchOutputMaxBytes: 4096, existingProfilesWritten: 0, credentialsRead: false, applicationStarted: false }))
