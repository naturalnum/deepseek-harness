/** Cloud-only peer classifications retain official rejecting semantics and provider declarations. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { PACKAGE_DEPENDENCY_POLICY } from '../../../../scripts/package-dependency-policy.ts'
import { collectRuntimeSourceExportUses, collectHostDependencyExportPolicyViolations,
  readPackageDependencyState } from '../../../../scripts/verify-package-dependencies.ts'
import { inventory } from '../../scripts/cloud-policy.mjs'
import { CLOUD_PEER_REQUIRED_HOST_EXPORTS, createCloudPeerPolicy, cloudPeerPolicyErrors,
  cloudProtocolManifestErrors } from '../../scripts/cloud-peer-policy.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const corpus = inventory(root)
const manifests = Object.fromEntries(corpus.manifests.map((file) => {
  const manifest = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  return [manifest.name, manifest]
}))
const official = readPackageDependencyState(root, PACKAGE_DEPENDENCY_POLICY)
const names = new Set([...official.workspaceNames, ...Object.keys(manifests)])
const app = '@power-evolve/application'
const actualUses = corpus.runtime.filter(file => file.startsWith('products/power-evolve/application/src/'))
  .flatMap(file => collectRuntimeSourceExportUses(file, readFileSync(resolve(root, file), 'utf8'))
    .map(use => ({ ...use, sourcePath: file,
      packageName: use.specifier.startsWith('@') ? use.specifier.split('/').slice(0, 2).join('/') : use.specifier.split('/')[0] })))
const facts = [...official.facts, { manifest: manifests[app], hostRuntimeExportUses: actualUses }]
const policy = createCloudPeerPolicy(PACKAGE_DEPENDENCY_POLICY)
const errors = candidate => cloudPeerPolicyErrors(candidate, PACKAGE_DEPENDENCY_POLICY, actualUses, names)
const classifications = candidate => collectHostDependencyExportPolicyViolations(facts, names, candidate)
const contracts = uses => uses.filter(use => use.specifier.startsWith('@power-evolve/contracts/'))
const keys = table => Object.entries(table).flatMap(([specifier, entries]) => entries.map(name => specifier + '#' + name)).sort()

// This assertion uses the real scanner, rather than a copied expected count or historical proposal table.
test('all named cloud peers exactly match actual managed Host export uses', () => {
  const observed = [...new Set(actualUses.filter(use => CLOUD_PEER_REQUIRED_HOST_EXPORTS[use.specifier]?.includes(use.exportName))
    .map(use => use.specifier + '#' + use.exportName))].sort()
  assert(observed.length > 0)
  assert.deepEqual(keys(CLOUD_PEER_REQUIRED_HOST_EXPORTS), observed)
  assert.deepEqual(errors(policy), [])
  assert.deepEqual(classifications(policy), [])
  assert(classifications(PACKAGE_DEPENDENCY_POLICY).some(error => error.includes('@power-evolve/contracts/')))
  for (const file of ['stdio-v2-cloud-worker.ts', 'stdio-v2-cloud-capture.ts', 'stdio-v2-cloud-runtime.ts', 'stdio-v2-worker-store.ts']) {
    assert(contracts(actualUses).some(use => use.sourcePath.endsWith('/' + file)), 'Missing new worker source ' + file)
  }
})

test('the cloud overlay preserves every original policy field and official peer entry', () => {
  for (const field of Object.keys(PACKAGE_DEPENDENCY_POLICY)) {
    if (field !== 'peerRequiredHostExports') assert.equal(policy[field], PACKAGE_DEPENDENCY_POLICY[field])
  }
  for (const [specifier, entries] of Object.entries(PACKAGE_DEPENDENCY_POLICY.peerRequiredHostExports)) {
    const additions = CLOUD_PEER_REQUIRED_HOST_EXPORTS[specifier] ?? []
    if (additions.length > 0) assert.deepEqual(policy.peerRequiredHostExports[specifier], [...new Set([...entries, ...additions])])
    else assert.equal(policy.peerRequiredHostExports[specifier], entries)
  }
  const changedSafe = { ...policy, safeHostDependencyExports: { ...policy.safeHostDependencyExports,
    '@power-evolve/contracts/account': ['accountUserId'] } }
  assert(errors(changedSafe).some(error => error.includes('preserve official safeHostDependencyExports')))
  assert(errors({ ...policy, duplicateSafePackages: [...policy.duplicateSafePackages, '@power-evolve/contracts'] })
    .some(error => error.includes('preserve official duplicateSafePackages')))
  const changedPeer = structuredClone(policy)
  delete changedPeer.peerRequiredHostExports['@deepseek-ai/dsh-session']
  assert(errors(changedPeer).some(error => error.includes('preserve official peer entries')))
})

test('unused, unknown, duplicate and unbounded cloud additions reject', () => {
  const candidate = structuredClone(policy)
  candidate.peerRequiredHostExports['@power-evolve/contracts/account'].push('notAnActualExport', '*', '<side-effect>', 'accountUserId')
  candidate.peerRequiredHostExports['@power-evolve/missing/wire'] = ['value']
  const rejected = errors(candidate)
  for (const marker of ['unused product Host export', 'unknown private provider', 'repeats', 'unbounded']) {
    assert(rejected.some(error => error.includes(marker)), marker)
  }
  assert(classifications(candidate).some(error => error.includes('lists unused')))
  assert(classifications(candidate).some(error => error.includes('cannot classify unbounded')))
  const missingProvider = new Set(names)
  missingProvider.delete('@power-evolve/contracts')
  assert(cloudPeerPolicyErrors(policy, PACKAGE_DEPENDENCY_POLICY, actualUses, missingProvider)
    .some(error => error.includes('unknown private provider')))
  assert(cloudPeerPolicyErrors(policy, PACKAGE_DEPENDENCY_POLICY,
    actualUses.map(use => ({ ...use, sourcePath: 'private-fixture/not-product.ts' })), names)
    .some(error => error.includes('unused product Host export')))
})

test('namespace and side-effect runtime source imports remain unclassified', () => {
  for (const text of ["export * from '@power-evolve/contracts/account'", "import '@power-evolve/contracts/account'"]) {
    const unbounded = collectRuntimeSourceExportUses('negative.ts', text).map(use => ({ ...use,
      packageName: '@power-evolve/contracts', sourcePath: 'products/power-evolve/application/src/negative.ts' }))
    assert.equal(unbounded.length, 1)
    const rejected = collectHostDependencyExportPolicyViolations([...facts,
      { manifest: manifests[app], hostRuntimeExportUses: unbounded }], names, policy)
    assert(rejected.some(error => error.includes('negative.ts') && error.includes('is not classified')))
  }
})

test('missing matching peer declarations or root production providers reject independently', () => {
  assert.deepEqual(cloudProtocolManifestErrors(manifests), [])
  for (const [owner, section, name] of [
    ['@power-evolve/application', 'peerDependencies', '@power-evolve/contracts'],
    ['@power-evolve/application', 'devDependencies', '@power-evolve/contracts'],
    ['@power-evolve/connector-runner', 'peerDependencies', '@power-evolve/contracts'],
    ['@power-evolve/host', 'dependencies', '@power-evolve/contracts'],
    ['@power-evolve/platform', 'dependencies', '@power-evolve/connector-runner'],
    ['@power-evolve/host', 'dependencies', 'zod'],
  ]) {
    const missing = structuredClone(manifests)
    delete missing[owner][section][name]
    assert(cloudProtocolManifestErrors(missing).length > 0, owner + '#' + name)
  }
})
