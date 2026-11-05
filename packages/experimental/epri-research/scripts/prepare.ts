/** Prepare review copies of an existing cloud recipe; never writes into its live profile. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { accountPresetConfigDigest } from '@deepseek-ai/dsh-pe-cloud-runtime/src/account-policy.ts'
import { Config as ResearchConfig } from '../src/index.ts'
import { Config as WebConfig } from '../src/web.ts'

type Row = Record<string, unknown>
const moduleName = '@deepseek-ai/dsh-experimental-epri-research'
const version = '0.2.1-rc.2'
function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a configuration object.')
  return value as Row
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new Error('Expected resolved Loader entry JSON.')
  return value.map(object)
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected a nonempty deployment string.')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Expected an explicit numerical deployment limit.')
  return value
}
function flatten(entries: Row[]): Row[] {
  return entries.flatMap(entry => [entry, ...entry.group ? flatten(rows(entry.config)) : []])
}
function unique(entries: Row[], field: string, value: unknown): Row {
  const matches = flatten(entries).filter(entry => entry[field] === value)
  if (matches.length !== 1 || matches[0] === undefined) throw new Error('Expected exactly one existing entry: ' + String(value))
  return matches[0]
}

/** Add research to the sole approved Preset while preserving existing cloud owners and capacities.
 * @param raw Resolved JSON containing root/account entries, installationDirectory, recipeVersion and explicit service/web limits.
 * @returns Detached review configuration and package dependencies; the original Root still validates and seals the complete recipe.
 */
export function prepareResearchConfiguration(raw: unknown): Row {
  const input = object(structuredClone(raw)), root = rows(input.root), account = rows(input.account)
  const runtime = object(unique(root, 'name', '@deepseek-ai/dsh-pe-cloud-runtime/root').config)
  const exposure = object(unique(root, 'name', '@deepseek-ai/dsh-pe-cloud-api/root').config)
  const policy = object(runtime.accountPolicy), native = object(runtime.native), catalog = object(exposure.approvedConfiguration)
  const previous = text(runtime.recipeVersion), recipeVersion = text(input.recipeVersion)
  if (previous === recipeVersion || exposure.recipeVersion !== previous || catalog.recipeVersion !== previous) {
    throw new Error('Use a new recipe version and a consistent existing Root/API/catalog version.')
  }
  const install = text(input.installationDirectory)
  if (!posix.isAbsolute(install) || install.includes('\\') || install.includes('..')) throw new Error('Use the absolute Linux installation directory.')
  const backend = posix.join(install, 'integrations/epri-research/dist/server/cloud-plugin.mjs')
  const assets = posix.join(install, 'integrations/epri-research/dist/ui')
  const limits = object(input.service), browser = object(input.web)
  const service = ResearchConfig({ backendModule: pathToFileURL(backend, { windows: false }).href, python: text(limits.python),
    maxJsonBytes: number(limits.maxJsonBytes), maxOutputBytes: number(limits.maxOutputBytes), graceMs: number(limits.graceMs) })
  const web = WebConfig({ assetsRoot: assets, requestTimeoutMs: number(browser.requestTimeoutMs),
    maxPendingRequests: number(browser.maxPendingRequests) })
  const preset = unique(account, 'id', policy.presetEntryId), declaration = object(preset.config)
  if (declaration.id !== policy.presetId || !Array.isArray(declaration.plugins)) throw new Error('The original approved Preset is unavailable.')
  if (object(catalog.skills).mode !== 'managed') throw new Error('Enable the platform managed-skill resource provider in the base recipe first.')
  const ids = ['epri-research', 'epri-research-workbench', 'epri-research-tools', 'epri-research-skills'] as const
  if ([...flatten(account), ...rows(declaration.plugins)].some(entry => ids.some(id => id === entry.id))) throw new Error('Research is already configured.')
  declaration.plugins.push({ id: ids[2], name: moduleName + '/tools' }, { id: ids[3], name: moduleName + '/skills' })
  if (typeof policy.maxPresetConfigBytes !== 'number') throw new Error('The original Preset byte limit is required.')
  policy.presetConfigSha256 = accountPresetConfigDigest(declaration, policy.maxPresetConfigBytes)
  account.push({ id: ids[0], name: moduleName, config: service }, { id: ids[1], name: moduleName + '/workbench' })
  const rpc = rows(exposure.rpcEndpoints)
  if (rpc.some(row => row.endpoint === 'epriResearch/execute')) throw new Error('Research RPC is already selected.')
  exposure.rpcEndpoints = [...rpc, { endpoint: 'epriResearch/execute', handlerId: 'native:epriResearch', guard: 'account-session' }]
  const plugins = rows(catalog.plugins)
  for (const [entryId, suffix] of [[ids[0], ''], [ids[1], '/workbench']] as const) {
    plugins.push({ id: entryId, entryId, moduleName: moduleName + suffix, packageName: moduleName,
      packageVersion: version, installable: false, toggleable: false })
  }
  catalog.plugins = plugins
  if (!Array.isArray(native.requiredEntryIds)) throw new Error('The original required-entry list is missing.')
  native.requiredEntryIds.push(ids[0], ids[1])
  if (typeof native.maxEntries !== 'number' || flatten(account).length > native.maxEntries
    || typeof catalog.maxEntries !== 'number' || flatten(account).length > catalog.maxEntries) {
    throw new Error('The research recipe exceeds existing entry capacities; review capacities explicitly.')
  }
  root.push({ id: 'epri-research-web', name: moduleName + '/web', config: web })
  const updateVersion = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'recipeVersion' && child === previous) Reflect.set(value, key, recipeVersion)
      else updateVersion(child)
    }
  }
  updateVersion(root); updateVersion(account)
  return { root, account, dependencies: {
    [moduleName]: pathToFileURL(posix.join(install, 'packages/experimental/epri-research'), { windows: false }).href,
    'deepscientist-harness-suite': pathToFileURL(posix.join(install, 'integrations/epri-research'), { windows: false }).href,
  },
  recipeVersion, presetConfigSha256: policy.presetConfigSha256 }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, destination] = process.argv.slice(2)
  if (input === undefined || destination === undefined) throw new Error('Usage: node --import tsx/esm prepare.ts input.json NEW_REVIEW_DIRECTORY')
  if (existsSync(destination)) throw new Error('The review output directory must not already exist.')
  const output = prepareResearchConfiguration(JSON.parse(readFileSync(input, 'utf8')))
  mkdirSync(destination, { recursive: true })
  for (const [name, value] of Object.entries(output)) writeFileSync(resolve(destination, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
