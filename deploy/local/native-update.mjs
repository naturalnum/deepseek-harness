/** Fixed native single-line delivery and matching JS continuation through the normal update lifecycle. */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifyBundle } from '../bundle.mjs'
import { nativeUpdateEffects, prepareNativeProductUpdate, requireProductOnlyRollback } from './update.mjs'
import { createNativeAuthority } from './native-authority.mjs'
import { runNativeDelivery, runNativePublishContinuation, saveNativeInput, withNativeOperationLock,
  withRetainedNativePublishLock, runNativeVerifyContinuation, requireNativeReleaseComplete } from './native-delivery.mjs'
import { assertCandidateLock } from './candidate-lock.mjs'
import { inspectCandidate, inspectExec } from './inspect.mjs'
import { preflight } from './dependencies.mjs'
import { readOptions } from '../smoke/options.mjs'
import stateModule from './native-delivery-state.cjs'
import profileModule from './native-profile.cjs'
import { ORIGINAL_VERIFY_OPERATION, ORIGINAL_SMOKE_SHA256, readOriginalVerifyEvidence, claimOriginalVerifyAttempt } from './native-verify-evidence.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const STATE = join(dirname(ROOT), 'local-state')
const { NativeDeliveryUnconfirmed, PROJECTION } = stateModule
const { tupleSha256 } = profileModule
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function exactFields(value, fields) {
  if (!value || typeof value !== 'object' || !isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) {
    throw new NativeDeliveryUnconfirmed('native-input-fields')
  }
}

function requireAssetPlan(plan) {
  exactFields(plan, ['format', 'assetFile', 'asset', 'assetParent', 'profile', 'originalAsset', 'compatibleBundle'])
  exactFields(plan.asset, ['sha256', 'sourceSha256', 'bytes', 'maxAssetBytes', 'maxPathBytes', 'parentDevice', 'parentInode'])
  exactFields(plan.assetParent, ['path', 'device', 'inode'])
  exactFields(plan.profile, ['target', 'maxProfileBytes', 'original', 'originalHelperPath'])
  exactFields(plan.profile.original, ['source', 'sha256', 'identity'])
  exactFields(plan.profile.original.identity, ['device', 'inode', 'uid', 'gid', 'mode', 'nlink'])
  exactFields(plan.originalAsset, ['path', 'sha256', 'bytes', 'mode', 'maxAssetBytes', 'maxPathBytes'])
  if (plan.format !== 'pe-cloud-local-native-asset/v1' || typeof plan.assetFile !== 'string'
    || typeof plan.compatibleBundle !== 'string' || !plan.assetFile.startsWith('/') || !plan.compatibleBundle.startsWith('/')
    || plan.originalAsset.path !== plan.profile.originalHelperPath
    || plan.asset.maxAssetBytes !== plan.originalAsset.maxAssetBytes
    || plan.asset.maxPathBytes !== plan.originalAsset.maxPathBytes) throw new NativeDeliveryUnconfirmed('native-asset-input')
}

const DIRECTORY_INPUT = 'pe-cloud-local-native-directory-asset/v1'
const DIRECTORY_PLAN = 'pe-cloud-local-native-directory-plan/v1'
const ARM_SHA = 'ab72d61fa50e2c91b34bac7a2b53ee42c4f1a184754592acdc19fc89ff39da3c'
const ARM_PROVENANCE_SHA = '05d74360aa303e04b2e013a621acdacab305e0bc37370c2bb02256e7e38655ed'
const ARM_SOURCE_SHA = '52d1081e425a1dc6b44c21c1d4eecb39de50e2e30dff4b07315934600687468f'
const NATIVE_PATHS = ['fd.c', 'skill-project.h', 'skill-versions.h', 'skill-bundles.h']
const READER_PATHS = ['packages/cloud/pe-cloud-files/src/file-worker.ts', 'packages/cloud/pe-cloud-files/src/worker-client.ts',
  'packages/cloud/pe-cloud-files/src/worker-pool.ts', 'packages/api/workspace-files/src/index.ts',
  'packages/cloud/pe-cloud-access/src/bootstrap-producer.ts', 'packages/cloud/pe-cloud-runtime/src/account-native-integration.ts',
  'packages/client/ui-sidebar-files/src/client/directory-pages.ts']

/**
 * Accept only explicit artifact paths, predecessor identity and the original three budgets.
 * @param {object} input Private new-asset request; protocol and selectors are code-owned.
 * @returns {void} Rejects extra fields and invalid budgets before environment discovery.
 */
export function requireDirectoryAssetInput(input) {
  exactFields(input, ['format', 'predecessor', 'assetFile', 'provenanceFile', 'sourceManifestFile', 'compatibleBundle', 'directoryPaging'])
  exactFields(input.predecessor, ['operation', 'descriptorSha256', 'targetTupleSha256'])
  if (input.format !== DIRECTORY_INPUT || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.predecessor.operation)
    || !['descriptorSha256', 'targetTupleSha256'].every(key => /^[a-f0-9]{64}$/.test(input.predecessor[key]))
    || !['assetFile', 'provenanceFile', 'sourceManifestFile', 'compatibleBundle'].every(key =>
      typeof input[key] === 'string' && input[key] === resolve(input[key]) && !input[key].includes('\0'))) {
    throw new NativeDeliveryUnconfirmed('directory-asset-input')
  }
  profileModule.directoryPaging(input.directoryPaging)
}

function publicArtifact(filename, maximum) {
  let fd, bytes, failure
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) {
      throw new NativeDeliveryUnconfirmed('directory-artifact-file')
    }
    bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd), view = fs.lstatSync(filename)
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || view.isSymbolicLink() || view.dev !== after.dev || view.ino !== after.ino) {
      throw new NativeDeliveryUnconfirmed('directory-artifact-changed')
    }
  } catch (error) { failure = error }
  if (fd !== undefined) try { fs.closeSync(fd) } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'artifact read and close failed') }
  if (failure !== undefined) throw new NativeDeliveryUnconfirmed('directory-artifact-read', failure)
  return bytes
}

function directoryArtifacts(input) {
  const asset = publicArtifact(input.assetFile, 143776), raw = publicArtifact(input.provenanceFile, 32768)
  const source = publicArtifact(input.sourceManifestFile, 4096)
  if (asset.length !== 143776 || digest(asset) !== ARM_SHA || digest(raw) !== ARM_PROVENANCE_SHA || digest(source) !== ARM_SOURCE_SHA) {
    throw new NativeDeliveryUnconfirmed('directory-arm-origin')
  }
  const provenance = JSON.parse(raw), rows = source.toString('utf8').trimEnd().split('\n').map(row => row.match(/^([a-f0-9]{64})  ([a-z.-]+)$/))
  if (rows.length !== 4 || rows.some((row, index) => !row || row[2] !== NATIVE_PATHS[index])
    || provenance.sha256 !== ARM_SHA || provenance.bytes !== 143776
    || provenance.target !== 'linux-arm64-glibc' || provenance.simulation_macros.length !== 0
    || !isDeepStrictEqual(provenance.production_macros, ['DSH_FD_TEXT_ABI', 'DSH_FD_CONTENT_ABI', 'DSH_FD_SKILL_ABI'])) {
    throw new NativeDeliveryUnconfirmed('directory-arm-provenance')
  }
  return { asset, arm: { assetSha256: ARM_SHA, bytes: asset.length, provenanceSha256: digest(raw),
    sourceManifestSha256: digest(source), sourceCommit: provenance.source_commit, sourceTree: provenance.source_tree,
    builderImage: provenance.builder_image_id, baseImage: provenance.base_image_id,
    recipeManifestSha256: provenance.recipe_manifest_sha256, productionMacros: provenance.production_macros },
  nativeSources: rows.map(row => ({ path: 'packages/cloud/pe-cloud-files/native/' + row[2], sha256: row[1] })) }
}

function readerConfigDeclarationSha(bytes) {
  const text = bytes.toString('utf8'), start = text.indexOf('  static Config: z<Config> = z.object({')
  const end = start < 0 ? -1 : text.indexOf('\n  })', start)
  if (start < 0 || end < 0) throw new NativeDeliveryUnconfirmed('directory-reader-config-source')
  return digest(Buffer.from(text.slice(start, end + 5)))
}

function installedReaderConfigSha(manifest) {
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) throw new NativeDeliveryUnconfirmed('directory-installed-reader-source')
  try { return readerConfigDeclarationSha(execFileSync('git', ['--no-replace-objects', '-C', ROOT, 'show',
    manifest.sourceCommit + ':packages/api/workspace-files/src/index.ts'], { maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'] })) }
  catch (error) { throw new NativeDeliveryUnconfirmed('directory-installed-reader-config', error) }
}

/**
 * Read each product bundle's actual source commit and unchanged four C inputs.
 * @param {object[]} manifests Manifests returned by the normal archive verifier.
 * @param {object[]} nativeSources Exact original four sources admitted from the frozen ARM manifest.
 * @param {string} sourceRoot Omitted uses the normal controller repository; supplied uses another source object store only.
 * @returns {object[]} Real commit/tree/blob/SHA observations; this function issues no Root authority.
 */
export function directoryReaderSources(manifests, nativeSources, sourceRoot = ROOT) {
  const git = args => {
    try { return execFileSync('git', ['--no-replace-objects', '-C', sourceRoot, ...args], { maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0' } }) }
    catch (error) { throw new NativeDeliveryUnconfirmed('directory-reader-source-unavailable', error) }
  }
  return manifests.map(manifest => {
    if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.nodeVersion !== '24.19.0') {
      throw new NativeDeliveryUnconfirmed('directory-reader-source')
    }
    const commit = git(['rev-parse', '--verify', manifest.sourceCommit + '^{commit}']).toString().trim()
    const tree = git(['rev-parse', manifest.sourceCommit + '^{tree}']).toString().trim()
    if (commit !== manifest.sourceCommit || !/^[a-f0-9]{40}$/.test(tree)) throw new NativeDeliveryUnconfirmed('directory-reader-commit')
    let readerConfigSourceSha256
    const files = [...nativeSources.map(row => row.path), ...READER_PATHS].map(path => {
      const bytes = git(['show', manifest.sourceCommit + ':' + path])
      if (path === 'packages/api/workspace-files/src/index.ts') readerConfigSourceSha256 = readerConfigDeclarationSha(bytes)
      const expected = nativeSources.find(row => row.path === path)
      if (expected && digest(bytes) !== expected.sha256) throw new NativeDeliveryUnconfirmed('directory-reader-four-c')
      return { path, blob: createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex'), sha256: digest(bytes) }
    })
    return { sourceCommit: commit, sourceTree: tree, readerConfigSourceSha256, files }
  })
}

/**
 * Read the two distinct saved plan formats without widening legacy exact fields.
 * @param {object} plan Previously derived private asset plan.
 * @returns {void} Rejects inconsistent origin, profile protocol and budget commitments.
 */
export function requireSavedAssetPlan(plan) {
  if (plan?.format !== DIRECTORY_PLAN) return requireAssetPlan(plan)
  exactFields(plan, ['format', 'assetFile', 'asset', 'assetParent', 'profile', 'originalAsset', 'compatibleBundle', 'origin'])
  exactFields(plan.profile, ['target', 'maxProfileBytes', 'original', 'originalHelperPath', 'nativeProtocol', 'directoryPaging', 'directoryFacts'])
  const { nativeProtocol, directoryPaging, directoryFacts, ...legacyProfile } = plan.profile
  const { origin, ...legacy } = plan
  requireAssetPlan({ ...legacy, format: 'pe-cloud-local-native-asset/v1', profile: legacyProfile })
  profileModule.directoryPaging(directoryPaging)
  if (nativeProtocol !== profileModule.DIRECTORY_PROTOCOL || origin?.format !== 'pe-cloud-directory-reader-origin/v1'
    || origin.arm?.assetSha256 !== ARM_SHA || origin.arm?.provenanceSha256 !== ARM_PROVENANCE_SHA
    || origin.arm?.sourceManifestSha256 !== ARM_SOURCE_SHA || !/^[a-f0-9]{64}$/.test(origin.readerConfigSourceSha256) || plan.asset.sha256 !== ARM_SHA || plan.asset.bytes !== 143776
    || plan.asset.sourceSha256 !== ARM_SOURCE_SHA
    || digest(JSON.stringify(directoryFacts)) !== origin.directoryFactsSha256
    || directoryFacts?.format !== 'pe-cloud-directory-profile-facts/v1' || directoryFacts.nativeProtocol !== nativeProtocol
    || !isDeepStrictEqual(directoryPaging, directoryFacts.directoryPaging)
    || !isDeepStrictEqual(directoryFacts.stream, profileModule.DIRECTORY_STREAM)) {
    throw new NativeDeliveryUnconfirmed('saved-directory-asset-plan')
  }
}

/**
 * Derive immutable source/asset data and actual bounded profile facts before a new stage.
 * @param {object} request Verified predecessor, saved controller, explicit input and real normal bundle.
 * @returns {Promise<object>} New strict plan, verified manifests and unchanged formal ARM bytes; no publication.
 */
export async function deriveDirectoryAsset({ input, previousInput, previous, normalBundle, controller, current }) {
  requireDirectoryAssetInput(input)
  if (!isDeepStrictEqual({ namespaceId: current.namespaceId, nodePath: current.nodePath, seccompPath: current.seccompPath,
    holder: current.holder }, previousInput.context)) throw new NativeDeliveryUnconfirmed('directory-facts-generation-changed')
  if (!isDeepStrictEqual(input.predecessor, { operation: previous.record.operation,
    descriptorSha256: previous.record.descriptorSha256, targetTupleSha256: previous.record.targetTupleSha256 })) {
    throw new NativeDeliveryUnconfirmed('directory-predecessor-mismatch')
  }
  const normalManifest = await verifyBundle(resolve(normalBundle)), compatibleManifest = await verifyBundle(input.compatibleBundle)
  for (const manifest of [normalManifest, compatibleManifest]) {
    if (manifest.externalDependencyHash !== previous.installed.manifest.externalDependencyHash
      || manifest.researchLockHash !== previous.installed.manifest.researchLockHash) throw new NativeDeliveryUnconfirmed('native-reader-dependencies')
  }
  const products = [normalManifest, compatibleManifest].map(m => JSON.stringify(m.files.map(row =>
    ({ path: row.path, mode: row.mode, size: row.size, sha256: row.sha256 })).sort((a, b) => a.path.localeCompare(b.path))))
  if (products[0] === products[1]) throw new NativeDeliveryUnconfirmed('directory-ambiguous-readers')
  const artifacts = directoryArtifacts(input), readers = directoryReaderSources([normalManifest, compatibleManifest], artifacts.nativeSources)
  const readerConfigSourceSha256 = installedReaderConfigSha(previous.installed.manifest)
  if (readers.some(row => row.readerConfigSourceSha256 !== readerConfigSourceSha256)) throw new NativeDeliveryUnconfirmed('directory-reader-config-changed')
  const prior = previousInput.plan, installed = previous.installed
  if (installed.asset.sha256 === ARM_SHA || installed.asset.maxAssetBytes < artifacts.asset.length) {
    throw new NativeDeliveryUnconfirmed('directory-new-asset-required')
  }
  const asset = { ...prior.asset, sha256: ARM_SHA, bytes: artifacts.asset.length, sourceSha256: ARM_SOURCE_SHA }
  const profile = { target: prior.profile.target, maxProfileBytes: prior.profile.maxProfileBytes,
    original: { source: installed.profile.source, sha256: installed.profile.sha256, identity: structuredClone(installed.profile.identity) },
    originalHelperPath: installed.asset.path,
    nativeProtocol: profileModule.DIRECTORY_PROTOCOL, directoryPaging: profileModule.directoryPaging(input.directoryPaging) }
  const approved = { ...structuredClone(previousInput.approved), asset,
    profile: { ...profile, nextHelperPath: '/opt/dsh-feature-assets/fd-skill-store-v1-' + ARM_SHA + '.node' } }
  const authority = await createNativeAuthority(current, approved)
  await authority.readProtectedInputs()
  const facts = await authority.readDirectoryFacts()
  profile.directoryFacts = facts
  const origin = { format: 'pe-cloud-directory-reader-origin/v1', arm: artifacts.arm, nativeSources: artifacts.nativeSources,
    readers, readerConfigSourceSha256, directoryFactsSha256: digest(JSON.stringify(facts)) }
  const plan = { format: DIRECTORY_PLAN, assetFile: input.assetFile, asset, assetParent: structuredClone(prior.assetParent),
    profile, originalAsset: structuredClone(installed.asset), compatibleBundle: input.compatibleBundle, origin }
  requireSavedAssetPlan(plan)
  return { plan, assetBytes: artifacts.asset, normalManifest, compatibleManifest, controller,
    protectedInputs: authority.snapshotApproved().profile.protectedInputs }
}

function privateInput(filename, withMetadata = false) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let value, failure
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
      || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new NativeDeliveryUnconfirmed('private-input-file')
    const bytes = fs.readFileSync(fd)
    if (bytes.length !== stat.size) throw new NativeDeliveryUnconfirmed('private-input-read')
    value = JSON.parse(bytes)
    if (withMetadata) {
      const after = fs.fstatSync(fd), pathStat = fs.lstatSync(filename)
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
        || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
        || pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        throw new NativeDeliveryUnconfirmed('private-input-changed')
      }
      value = { value, sha256: digest(bytes), device: String(stat.dev), inode: String(stat.ino) }
    }
  } catch (error) { failure = error }
  try { fs.closeSync(fd) } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'native input and close failed')
  }
  if (failure !== undefined) throw new NativeDeliveryUnconfirmed('private-input', failure)
  return value
}

function controllerSource() {
  const git = args => execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8', maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
  const commit = git(['rev-parse', '--verify', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}'])
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)
    || git(['status', '--porcelain=v1', '--untracked-files=no']) !== '') {
    throw new NativeDeliveryUnconfirmed('continuation-unsaved-controller')
  }
  const paths = git(['ls-files', '--', 'deploy/local', 'deploy/smoke', 'deploy/bundle.mjs']).split('\n')
  const files = paths.map(path => {
    const bytes = fs.readFileSync(join(ROOT, path))
    const saved = execFileSync('git', ['-C', ROOT, 'show', commit + ':' + path], { maxBuffer: 1048576 })
    if (!bytes.equals(saved)) throw new NativeDeliveryUnconfirmed('continuation-controller-source')
    return { path, sha256: digest(bytes) }
  })
  const sources = ['native-delivery-state.cjs', 'native-profile.cjs', 'product-files.cjs']
    .map(path => fs.readFileSync(join(ROOT, 'deploy/local', path), 'utf8'))
  return { commit, tree, files, programSha256: digest(sources.join('\0')) }
}

function retainedCandidateLine(line) {
  const directory = join(dirname(ROOT), 'locks', 'candidate'), filename = join(directory, 'owner')
  const parent = fs.lstatSync(directory), before = fs.lstatSync(filename)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
    || (parent.mode & 0o022) !== 0 || before.isSymbolicLink()) {
    throw new NativeDeliveryUnconfirmed('continuation-candidate-lock')
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let failure, value
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0
      || stat.size < 1 || stat.size > 32768 || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new NativeDeliveryUnconfirmed('continuation-candidate-owner')
    }
    const bytes = fs.readFileSync(fd), owner = bytes.toString('utf8').split('\n')[0]
    const after = fs.lstatSync(filename), afterParent = fs.lstatSync(directory)
    if (bytes.length !== stat.size || !owner.includes(' | ') || owner.split(' | ')[0] !== line
      || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || afterParent.dev !== parent.dev || afterParent.ino !== parent.ino) {
      throw new NativeDeliveryUnconfirmed('continuation-candidate-changed')
    }
    value = { directory: { device: String(parent.dev), inode: String(parent.ino) },
      owner: { device: String(stat.dev), inode: String(stat.ino), sha256: digest(bytes) } }
  } catch (error) { failure = error }
  try { fs.closeSync(fd) } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'candidate lock read and close failed')
  }
  if (failure !== undefined) throw new NativeDeliveryUnconfirmed('continuation-candidate-lock', failure)
  return value
}

function requireNoOtherUpdateCaller() {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const rows = output.trim().split('\n').map(row => row.trim().match(/^([0-9]+)\s+([0-9]+)\s+(.*)$/))
    .filter(Boolean).map(row => ({ pid: Number(row[1]), parent: Number(row[2]), command: row[3] }))
  const ancestors = new Set([process.pid])
  for (let pid = process.ppid; pid > 0 && !ancestors.has(pid); pid = rows.find(row => row.pid === pid)?.parent ?? 0) {
    ancestors.add(pid)
  }
  if (rows.some(row => !ancestors.has(row.pid) && /(?:^|[\s/])deploy\/local\/update(?:\.mjs)?(?:\s|$)/.test(row.command))) {
    throw new NativeDeliveryUnconfirmed('continuation-another-update-caller')
  }
}

/**
 * Reuse only the original prepared operation and candidate line, never a new bundle or another durable phase.
 * @param {object} request Original operation/line and unchanged blocking projection from the normal command.
 * @returns {Promise<object>} Same-operation verified record; failures retain actual Root state and the original responsibility.
 */
export async function continueNativePublish({ operation, line, latest }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)
    || !line || latest?.operation !== operation || latest.format !== PROJECTION
    || latest.nativePhase !== 'publish-intent') throw new NativeDeliveryUnconfirmed('continuation-entry')
  await assertCandidateLock(dirname(ROOT), line)
  const candidateLock = retainedCandidateLine(line)
  const source = controllerSource()
  return withRetainedNativePublishLock(STATE, operation, async () => {
    if (!isDeepStrictEqual(privateInput(join(STATE, 'latest.json')), latest)) {
      throw new NativeDeliveryUnconfirmed('continuation-latest-changed')
    }
    const filename = join(STATE, operation + '.native.json')
    const saved = privateInput(filename, true), input = saved.value, state = input.state
    if (input.format !== 'pe-cloud-local-native-input/v1' || input.operation !== operation
      || input.descriptorSha256 !== latest.nativeAuthority?.descriptorSha256
      || state?.operation !== operation || state.phase !== 'native-prepared'
      || state.launch !== undefined || state.stopAttempted || input.publication !== undefined
      || state.stageGlobal !== '/opt/dsh-features/pe-cloud-delivery/' + operation
      || state.stageView !== '/proc/1/root' + state.stageGlobal
      || state.backupDirectory !== join(STATE, operation)
      || !isDeepStrictEqual(state.nativeJournal, input.approved?.journal)) {
      throw new NativeDeliveryUnconfirmed('continuation-private-state')
    }
    requireAssetPlan(input.plan)
    const groups = input.groups
    if (!Array.isArray(groups) || groups.length !== 3) throw new NativeDeliveryUnconfirmed('continuation-groups')
    const original = groups.find(group => group.role === 'original'), normal = groups.find(group => group.role === 'normal')
    const compatible = groups.find(group => group.role === 'compatible')
    if (!original || !normal || !compatible || !isDeepStrictEqual(normal.manifest, state.manifest)
      || state.nativeOriginalTupleSha256 !== tupleSha256(original)
      || !isDeepStrictEqual(input.context.holder, { pid: state.holder.pid, startTicks: state.holder.startTicks,
        namespaceId: state.holder.namespaceId }) || input.context.namespaceId !== state.snapshot.namespaceId) {
      throw new NativeDeliveryUnconfirmed('continuation-prepared-group')
    }
    const pins = { kind: 'fd-profile', operation, descriptorSha256: input.descriptorSha256,
      originalTupleSha256: tupleSha256(original), targetTupleSha256: tupleSha256(normal),
      compatibleTupleSha256: tupleSha256(compatible) }
    if (digest(JSON.stringify({ groups: groups.map(tupleSha256), assetSource: input.plan.asset.sourceSha256,
      namespaceId: input.context.namespaceId, holder: input.context.holder })) !== pins.descriptorSha256) {
      throw new NativeDeliveryUnconfirmed('continuation-descriptor')
    }
    const fresh = async () => {
      requireNoOtherUpdateCaller()
      await assertCandidateLock(dirname(ROOT), line)
      if (!isDeepStrictEqual(retainedCandidateLine(line), candidateLock)) {
        throw new NativeDeliveryUnconfirmed('continuation-candidate-changed')
      }
      const observed = await inspectCandidate()
      const fields = ['container', 'appPid', 'appStartTicks', 'appUid', 'appGid', 'appExecId', 'shutdownTimeoutMs',
        'namespaceId', 'namespaceKeeperPid', 'namespaceKeeperStartTicks', 'productRoot', 'productDevice',
        'productFilesystem', 'nodePath', 'appCheckPath', 'seccompPath', 'profileHome', 'appCwd']
      if (!observed.canStopSafely || observed.productReadOnly !== true || observed.productBlockReadOnly !== true
        || fields.some(key => observed[key] !== state.snapshot[key])
        || observed.namespaceKeeperPid !== state.holder.pid || observed.namespaceKeeperStartTicks !== state.holder.startTicks) {
        throw new NativeDeliveryUnconfirmed('continuation-original-application')
      }
      const execution = await inspectExec(state.snapshot.appExecId)
      if (!execution.running || execution.missing || execution.execId !== state.snapshot.appExecId) {
        throw new NativeDeliveryUnconfirmed('continuation-original-exec')
      }
      await preflight(observed, normal.manifest)
      return observed
    }
    const observed = await fresh()
    const authority = await createNativeAuthority({ ...observed, holder: input.context.holder }, input.approved)
    const record = await authority.read()
    stateModule.requireNativePublishIntent(pins, record)
    if (!isDeepStrictEqual(latest, stateModule.legacyBarrier(record))) {
      throw new NativeDeliveryUnconfirmed('continuation-original-authority')
    }
    const persist = () => saveNativeInput(STATE, operation, input)
    const effects = nativeUpdateEffects(state, { observeTuple: () => authority.observeTuple(groups),
      unbind: () => authority.unbind(pins), bind: () => authority.bind(pins), seal: () => authority.seal(pins) })
    const stop = effects.stop
    effects.stop = async () => { await fresh(); return stop() }
    const start = effects.start
    effects.start = async () => {
      let failure, value
      try { value = await start() } catch (error) { failure = error }
      try { await persist() } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'native launch and receipt failed')
      }
      if (failure !== undefined) throw failure
      return value
    }
    const unchangedInput = privateInput(filename, true)
    if (!isDeepStrictEqual(unchangedInput, saved) || !isDeepStrictEqual(controllerSource(), source)) {
      throw new NativeDeliveryUnconfirmed('continuation-input-changed')
    }
    return runNativePublishContinuation({ directory: STATE, pins, authority, effects,
      binding: { groups, controller: { ...source, line, candidateLock, inputSha256: saved.sha256,
        inputIdentity: { device: saved.device, inode: saved.inode }, originalApp: {
          pid: state.snapshot.appPid, startTicks: state.snapshot.appStartTicks, execId: state.snapshot.appExecId },
        originalProduct: { device: state.snapshot.productDevice, filesystem: state.snapshot.productFilesystem } } },
      holdOperation: action => action(), persistPublication: async publication => {
        for (const group of groups) if (group.role !== 'original') group.profile = structuredClone(publication.profile)
        input.publication = publication
        input.approved = authority.snapshotApproved()
        await persist()
      } })
  })
}

function requireSuccessorInput(input) {
  exactFields(input, ['format', 'predecessor', 'compatibleBundle'])
  exactFields(input.predecessor, ['operation', 'descriptorSha256', 'targetTupleSha256'])
  if (input.format !== 'pe-cloud-local-native-successor/v1'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.predecessor.operation)
    || ![input.predecessor.descriptorSha256, input.predecessor.targetTupleSha256]
      .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    || typeof input.compatibleBundle !== 'string' || !input.compatibleBundle.startsWith('/')) {
    throw new NativeDeliveryUnconfirmed('successor-input')
  }
}

/** Require the unchanged original app exec, start ticks and retained keeper before read-only verification. */
export function requireOriginalVerifyApplication(current, holder) {
  if (current.appPid !== 78672 || current.appStartTicks !== '158001449'
    || current.appExecId !== 'a0de3a16ee6ee8497f31aa1290f254f8314b1fd147c4544bd8b83114389e744e'
    || !isDeepStrictEqual(current.holder, holder)) throw new NativeDeliveryUnconfirmed('verify-original-application')
}

/** Verify only this original operation; deployment release never retires account or SDK resource ownership. */
export async function continueNativeVerify(request) {
  return runNativeVerifyContinuation(await prepareOriginalVerification(request))
}

/** Inspect only this original verification context; no attempt, smoke, CAS or release is submitted. */
export async function inspectOriginalVerification(request) {
  const { directory, pins } = await prepareOriginalVerification(request, true)
  return { directory, pins }
}

async function prepareOriginalVerification({ operation, line, latest }, inspectOnly = false) {
  if (operation !== ORIGINAL_VERIFY_OPERATION || line !== '主线' || latest?.operation !== operation
    || latest.format !== PROJECTION || latest.nativePhase !== 'verify-intent') {
    throw new NativeDeliveryUnconfirmed('verify-original-entry')
  }
  await assertCandidateLock(dirname(ROOT), line)
  const candidate = retainedCandidateLine(line), source = controllerSource()
  const filename = join(STATE, operation + '.native.json'), saved = privateInput(filename, true)
  const input = saved.value, state = input.state, groups = input.groups
  const recordPins = { kind: 'successor-js', operation,
    descriptorSha256: '55c85dff1792c36a30a1804ceee9679dd87503f9c5e5c101bd46a298ee74c18d',
    originalTupleSha256: '0fb9ef7b4679de52b7f5dd98dfb634752715893b379b6f5e47078554bd34e881',
    targetTupleSha256: 'dedc9d07598ff18a777d5326bb97d62dc7c2e7cb93bd698711cda86e38dd67cd',
    compatibleTupleSha256: '279ef8454b4ddd704ace4898f5b103fbd197898f45ae874450e1f24c886e35ab' }
  if (input.operation !== operation || input.descriptorSha256 !== recordPins.descriptorSha256
    || state?.operation !== operation || state.manifest?.sourceCommit !== '56b76d0bc878c656d81b91cbfeef76aaa288fcb1'
    || !isDeepStrictEqual(state.smokeArgs, ['--credentials',
      '/Users/jingchao/agent_work/main_agent/dsh-cloud-delivery/features-20261107/test-runtime/linux/.private/web-login-final.json', '--account', 'ordinaryUserB'])
    || digest(fs.readFileSync(join(ROOT, 'deploy/smoke/check.mjs'))) !== ORIGINAL_SMOKE_SHA256) {
    throw new NativeDeliveryUnconfirmed('verify-original-private-input')
  }
  const checkRecord = (record, observed) => {
    stateModule.requireNativeVerifyIntent(recordPins, record)
    if (observed !== recordPins.targetTupleSha256) throw new NativeDeliveryUnconfirmed('verify-original-target')
  }
  const fresh = async () => {
    requireNoOtherUpdateCaller()
    await assertCandidateLock(dirname(ROOT), line)
    if (!isDeepStrictEqual(privateInput(join(STATE, 'latest.json')), latest)
      || !isDeepStrictEqual(privateInput(filename, true), saved)
      || !isDeepStrictEqual(retainedCandidateLine(line), candidate)
      || !isDeepStrictEqual(controllerSource(), source)) throw new NativeDeliveryUnconfirmed('verify-input-changed')
    const current = currentNativeContext(await inspectCandidate())
    requireOriginalVerifyApplication(current, input.context.holder)
    const execution = await inspectExec(current.appExecId)
    if (!execution.running || execution.missing) throw new NativeDeliveryUnconfirmed('verify-original-exec')
    const authority = await createNativeAuthority(current, input.approved)
    await confirmNativeInstallation({ latest, input, current, authority }, checkRecord)
    return { current, authority }
  }
  const { current, authority } = await fresh()
  const prerequisites = async () => {
    const evidence = await readOriginalVerifyEvidence()
    await preflight(current, state.manifest)
    try {
      await readOptions(state.smokeArgs)
      const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))('playwright')
      fs.accessSync(chromium.executablePath(), fs.constants.X_OK)
    } catch (_error) { throw new NativeDeliveryUnconfirmed('verify-local-smoke-prerequisites') }
    return evidence
  }
  if (inspectOnly) {
    await prerequisites()
    return { directory: STATE, pins: recordPins }
  }
  const effects = nativeUpdateEffects(state, { observeTuple: () => authority.observeTuple(groups) })
  return { directory: STATE, pins: recordPins, authority,
    observe: async () => { await fresh(); return authority.observeTuple(groups) },
    verify: async () => {
      const evidence = await prerequisites()
      claimOriginalVerifyAttempt(STATE, { ...evidence, controller: { commit: source.commit, tree: source.tree } })
      await effects.verify()
    } }
}

function currentNativeContext(snapshot) {
  return { ...snapshot, holder: { pid: snapshot.namespaceKeeperPid,
    startTicks: snapshot.namespaceKeeperStartTicks, namespaceId: snapshot.namespaceId } }
}

/**
 * Confirm a saved pair against a fresh Root record and the actual sealed installation, without preparing a stage.
 * @param {object} request Exact host projection/private input, current namespace facts and original Root authority.
 * sourceRoot omission uses the saved controller repository; an explicit repository supplies source data only.
 * @returns {Promise<object>} Complete verified predecessor and its installed group; mismatch performs no mutation.
 */
export async function confirmNativePredecessor(request) {
  return confirmNativeInstallation(request, (record, observed) =>
    stateModule.requireNativeContinuation(record, observed, record.targetTupleSha256))
}

async function confirmNativeInstallation({ latest, input, current, authority, sourceRoot = ROOT }, requireSelection) {
  requireSavedAssetPlan(input.plan)
  const groups = input.groups
  if (!isDeepStrictEqual(input.approved?.asset, input.plan.asset)
    || !isDeepStrictEqual(input.approved?.assetParent, input.plan.assetParent)) {
    throw new NativeDeliveryUnconfirmed('native-approved-asset')
  }
  if (input.format !== 'pe-cloud-local-native-input/v1' || input.operation !== latest.operation
    || input.state?.operation !== input.operation || !isDeepStrictEqual(input.approved?.journal, input.state.nativeJournal)
    || input.approved.journal.path !== '/opt/dsh-features/pe-cloud-delivery/' + input.operation + '/native-record'
    || !Array.isArray(groups) || groups.length !== 3
    || !isDeepStrictEqual(groups.map(group => group.role), ['original', 'normal', 'compatible'])) {
    throw new NativeDeliveryUnconfirmed('native-private-state-mismatch')
  }
  const context = { namespaceId: current.namespaceId, nodePath: current.nodePath,
    seccompPath: current.seccompPath, holder: current.holder }
  if (!isDeepStrictEqual(context, input.context) || !current.canStopSafely
    || current.productReadOnly !== true || current.productBlockReadOnly !== true) {
    throw new NativeDeliveryUnconfirmed('native-generation-changed')
  }
  const record = await authority.read()
  if (!isDeepStrictEqual(latest, stateModule.legacyBarrier(record))
    || input.descriptorSha256 !== record.descriptorSha256) throw new NativeDeliveryUnconfirmed('previous-authority-mismatch')
  let descriptorSha256
  if (input.assetBinding !== undefined) {
    if (input.pairBinding !== undefined || input.plan.format !== DIRECTORY_PLAN) throw new NativeDeliveryUnconfirmed('saved-asset-binding-format')
    descriptorSha256 = stateModule.nativeAssetDescriptor(input.assetBinding)
    const b = input.assetBinding
    if (!isDeepStrictEqual(b.groups, groups.map(tupleSha256)) || !isDeepStrictEqual(b.context, context)
      || b.originSha256 !== digest(JSON.stringify(input.plan.origin))
      || b.directoryFactsSha256 !== digest(JSON.stringify(input.plan.profile.directoryFacts))
      || !isDeepStrictEqual(b.asset, groups[1].asset) || !isDeepStrictEqual(groups[1].asset, groups[2].asset)
      || !isDeepStrictEqual(b.profile, { source: groups[1].profile.source, sha256: groups[1].profile.sha256, bytes: groups[1].profile.bytes })) {
      throw new NativeDeliveryUnconfirmed('saved-asset-binding')
    }
  } else if (input.pairBinding === undefined) {
    descriptorSha256 = digest(JSON.stringify({ groups: groups.map(tupleSha256), assetSource: input.plan.asset.sourceSha256,
      namespaceId: context.namespaceId, holder: context.holder }))
  } else {
    descriptorSha256 = stateModule.nativeSuccessorDescriptor(input.pairBinding)
    if (input.plan.format === DIRECTORY_PLAN && (input.pairBinding.format !== 'pe-cloud-native-directory-successor-pair/v1'
      || input.pairBinding.originSha256 !== digest(JSON.stringify(input.plan.origin))
      || input.pairBinding.directoryFactsSha256 !== digest(JSON.stringify(input.plan.profile.directoryFacts)))) {
      throw new NativeDeliveryUnconfirmed('saved-directory-successor-origin')
    }
    if (!isDeepStrictEqual(input.pairBinding.groups, groups.map(tupleSha256))
      || !isDeepStrictEqual(input.pairBinding.context, context)
      || input.pairBinding.assetSource !== input.plan.asset.sourceSha256
      || groups.some(group => !isDeepStrictEqual(group.asset, input.pairBinding.asset)
        || !isDeepStrictEqual(group.profile, input.pairBinding.profile))) {
      throw new NativeDeliveryUnconfirmed('saved-successor-pair')
    }
  }
  if (descriptorSha256 !== record.descriptorSha256
    || !isDeepStrictEqual([tupleSha256(groups[1]), tupleSha256(groups[2])].sort(),
      [record.targetTupleSha256, record.compatibleTupleSha256].sort())) {
    throw new NativeDeliveryUnconfirmed('saved-native-descriptor')
  }
  const observed = await authority.observeTuple(groups)
  requireSelection(record, observed)
  const installed = groups.find(group => tupleSha256(group) === record.targetTupleSha256)
  const expectedAsset = { path: '/opt/dsh-feature-assets/fd-skill-store-v1-' + input.approved.asset.sha256 + '.node',
    sha256: input.approved.asset.sha256, bytes: input.approved.asset.bytes, mode: 0o444,
    maxAssetBytes: input.approved.asset.maxAssetBytes, maxPathBytes: input.approved.asset.maxPathBytes }
  const selection = value => ({ source: value.source, sha256: value.sha256, identity: value.identity })
  if (!isDeepStrictEqual(groups[1].asset, groups[2].asset)
    || !isDeepStrictEqual(groups[1].profile, groups[2].profile)
    || !isDeepStrictEqual(installed.asset, expectedAsset)
    || !isDeepStrictEqual(selection(installed.profile), selection(input.approved.profile.candidate))) {
    throw new NativeDeliveryUnconfirmed('native-installed-fd-profile')
  }
  if (input.plan.format === DIRECTORY_PLAN) {
    for (const key of ['target', 'maxProfileBytes', 'original', 'originalHelperPath', 'nativeProtocol', 'directoryPaging', 'directoryFacts']) {
      if (!isDeepStrictEqual(input.plan.profile[key], input.approved.profile[key])) throw new NativeDeliveryUnconfirmed('saved-directory-profile-authority')
    }
    const readers = directoryReaderSources(groups.slice(1).map(group => group.manifest), input.plan.origin.nativeSources, sourceRoot)
    if (readers.some(row => row.readerConfigSourceSha256 !== input.plan.origin.readerConfigSourceSha256)) throw new NativeDeliveryUnconfirmed('saved-directory-reader-config')
  }
  return { record, installed }
}

/**
 * Derive three observable groups exclusively from two verified product archives and the confirmed predecessor.
 * Source objects use the saved controller repository unless an explicit read-only source repository is supplied.
 * @param {object} request Confirmed predecessor/private inputs, explicit successor identity and real normal bundle path.
 * @returns {Promise<object>} New immutable pair binding and manifests; no Root or host record is changed.
 */
export async function deriveNativeSuccessorPair({ previousInput, previous, successor, normalBundle, controller, sourceRoot = ROOT }) {
  requireSuccessorInput(successor)
  if (!isDeepStrictEqual(successor.predecessor, { operation: previous.record.operation,
    descriptorSha256: previous.record.descriptorSha256, targetTupleSha256: previous.record.targetTupleSha256 })) {
    throw new NativeDeliveryUnconfirmed('successor-predecessor-mismatch')
  }
  const normal = await verifyBundle(resolve(normalBundle))
  const compatible = await verifyBundle(resolve(successor.compatibleBundle))
  for (const manifest of [normal, compatible]) {
    if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.nodeVersion !== '24.19.0'
      || ![manifest.pnpmLockHash, manifest.externalDependencyHash, manifest.researchLockHash, manifest.dependencyHash]
        .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      || manifest.externalDependencyHash !== previous.installed.manifest.externalDependencyHash
      || manifest.researchLockHash !== previous.installed.manifest.researchLockHash) {
      throw new NativeDeliveryUnconfirmed('native-reader-dependencies')
    }
  }
  if (previousInput.plan.format === DIRECTORY_PLAN) {
    const readers = directoryReaderSources([normal, compatible], previousInput.plan.origin.nativeSources, sourceRoot)
    if (readers.some(row => row.readerConfigSourceSha256 !== previousInput.plan.origin.readerConfigSourceSha256)) throw new NativeDeliveryUnconfirmed('successor-directory-reader-config')
  }
  const groups = [
    { ...structuredClone(previous.installed), role: 'original' },
    { ...structuredClone(previous.installed), role: 'normal', manifest: normal },
    { ...structuredClone(previous.installed), role: 'compatible', manifest: compatible },
  ]
  const products = groups.map(group => JSON.stringify(group.manifest.files.map(row =>
    ({ path: row.path, mode: row.mode, size: row.size, sha256: row.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path))))
  if (new Set(products).size !== 3) throw new NativeDeliveryUnconfirmed('ambiguous-successor-readers')
  const pairBinding = { format: 'pe-cloud-native-successor-pair/v1', predecessor: structuredClone(previous.record),
    release: { format: 'pe-cloud-native-release/v1', operation: previous.record.operation },
    controller: { commit: controller.commit, tree: controller.tree, programSha256: controller.programSha256 },
    context: structuredClone(previousInput.context), assetSource: previousInput.plan.asset.sourceSha256,
    asset: structuredClone(previous.installed.asset), profile: structuredClone(previous.installed.profile),
    groups: groups.map(tupleSha256) }
  if (previousInput.plan.format === DIRECTORY_PLAN) Object.assign(pairBinding, { format: 'pe-cloud-native-directory-successor-pair/v1',
    originSha256: digest(JSON.stringify(previousInput.plan.origin)),
    directoryFactsSha256: digest(JSON.stringify(previousInput.plan.profile.directoryFacts)) })
  return { groups, pairBinding, descriptorSha256: stateModule.nativeSuccessorDescriptor(pairBinding),
    normalManifest: normal, compatibleManifest: compatible }
}

/**
 * Install the fixed FD/profile, switch an approved pair, or derive an explicit same-FD pair or new-asset successor.
 * @param {object} request Normal command with mutually exclusive first-delivery/same-FD/new-asset input; absent uses the saved pair.
 * @returns {Promise<object>} Verified new responsibility; any unknown action retains the operation lock without recovery.
 */
export async function nativeUpdate({ mode, bundle, args, inputFile, successorFile, assetSuccessorFile, latest }) {
  if (!['update', 'rollback'].includes(mode)) throw new NativeDeliveryUnconfirmed('native-start-requires-owner')
  const initial = inputFile !== undefined, successorRequested = successorFile !== undefined, assetRequested = assetSuccessorFile !== undefined
  if (assetRequested && (initial || successorRequested || mode !== 'update' || !bundle || latest?.format !== PROJECTION)) {
    throw new NativeDeliveryUnconfirmed('asset-successor-entry')
  }
  if (successorRequested && (initial || mode !== 'update' || !bundle || latest?.format !== PROJECTION)) {
    throw new NativeDeliveryUnconfirmed('successor-entry')
  }
  if (initial && latest?.format === PROJECTION) throw new NativeDeliveryUnconfirmed('native-group-already-owned')
  if (!initial && latest?.format !== PROJECTION) throw new NativeDeliveryUnconfirmed('native-state-missing')
  let plan, previousInput, savedPrevious, previous, successor, successorSaved, derived, previousAuthority, controller, assetInput, assetSaved, directoryDerived
  const readPrevious = async () => {
    requireNativeReleaseComplete(STATE, undefined, latest.operation)
    if (!isDeepStrictEqual(privateInput(join(STATE, 'latest.json')), latest)
      || !isDeepStrictEqual(privateInput(join(STATE, latest.operation + '.native.json'), true), savedPrevious)
      || successorRequested && !isDeepStrictEqual(privateInput(resolve(successorFile), true), successorSaved)
      || assetRequested && !isDeepStrictEqual(privateInput(resolve(assetSuccessorFile), true), assetSaved)) {
      throw new NativeDeliveryUnconfirmed('latest-or-input-changed-before-operation')
    }
    if ((successorRequested || assetRequested) && !isDeepStrictEqual(controllerSource(), controller)) {
      throw new NativeDeliveryUnconfirmed('successor-controller-changed')
    }
    const current = currentNativeContext(await inspectCandidate())
    const authority = await createNativeAuthority(current, previousInput.approved)
    const fresh = await confirmNativePredecessor({ latest, input: previousInput, current, authority })
    if (previous !== undefined && !isDeepStrictEqual(fresh.record, previous.record)) {
      throw new NativeDeliveryUnconfirmed('previous-authority-changed')
    }
    previousAuthority = authority
    return fresh
  }
  if (initial) {
    stateModule.requireOrdinaryUpdateState(latest)
    if (!latest?.manifest || latest.phase !== 'verified' || mode !== 'update') {
      throw new NativeDeliveryUnconfirmed('original-installation-unconfirmed')
    }
    plan = privateInput(resolve(inputFile))
    requireAssetPlan(plan)
  } else {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(latest.operation)) {
      throw new NativeDeliveryUnconfirmed('native-state-operation')
    }
    savedPrevious = privateInput(join(STATE, latest.operation + '.native.json'), true)
    previousInput = savedPrevious.value
    if (successorRequested) {
      successorSaved = privateInput(resolve(successorFile), true)
      successor = successorSaved.value
      requireSuccessorInput(successor)
      controller = controllerSource()
    }
    if (assetRequested) {
      assetSaved = privateInput(resolve(assetSuccessorFile), true); assetInput = assetSaved.value
      requireDirectoryAssetInput(assetInput); controller = controllerSource()
    }
    // No new operation, private save or Root stage before this read-only confirmation.
    previous = await readPrevious()
    plan = structuredClone(previousInput.plan)
    if (assetRequested) {
      directoryDerived = await deriveDirectoryAsset({ input: assetInput, previousInput, previous, normalBundle: bundle,
        controller, current: currentNativeContext(await inspectCandidate()) })
      plan = directoryDerived.plan
    }
    if (successorRequested) {
      derived = await deriveNativeSuccessorPair({ previousInput, previous, successor, normalBundle: bundle, controller })
      plan.compatibleBundle = successor.compatibleBundle
    }
  }
  const selectedBundle = mode === 'rollback' ? resolve(plan.compatibleBundle) : resolve(bundle)
  const manifest = directoryDerived?.normalManifest ?? derived?.normalManifest ?? await verifyBundle(selectedBundle)
  const normalManifest = directoryDerived?.normalManifest ?? derived?.normalManifest ?? (initial ? manifest : previousInput.groups[1].manifest)
  const compatibleManifest = directoryDerived?.compatibleManifest ?? derived?.compatibleManifest ?? (initial ? await verifyBundle(resolve(plan.compatibleBundle))
    : previousInput.groups[2].manifest)
  if (normalManifest.externalDependencyHash !== compatibleManifest.externalDependencyHash
    || normalManifest.researchLockHash !== compatibleManifest.researchLockHash) {
    throw new NativeDeliveryUnconfirmed('native-reader-dependencies')
  }
  if (!initial && !successorRequested && !assetRequested && ![normalManifest, compatibleManifest].some(value => isDeepStrictEqual(value, manifest))) {
    throw new NativeDeliveryUnconfirmed('unapproved-js-group')
  }
  let assetBytes = directoryDerived?.assetBytes
  if (initial) {
    assetBytes = fs.readFileSync(resolve(plan.assetFile))
    if (assetBytes.length !== plan.asset.bytes || digest(assetBytes) !== plan.asset.sha256) {
      throw new NativeDeliveryUnconfirmed('local-asset-mismatch')
    }
  }
  const operation = randomUUID()
  return withNativeOperationLock(STATE, operation, async () => {
    if (!isDeepStrictEqual(privateInput(join(STATE, 'latest.json')), latest)) {
      throw new NativeDeliveryUnconfirmed('latest-changed-before-operation')
    }
    if (!initial) await readPrevious()
    if (assetRequested) {
      const fresh = await deriveDirectoryAsset({ input: assetInput, previousInput, previous, normalBundle: bundle,
        controller, current: currentNativeContext(await inspectCandidate()) })
      if (!isDeepStrictEqual(fresh.plan, directoryDerived.plan) || !fresh.assetBytes.equals(assetBytes)
        || !isDeepStrictEqual(fresh.normalManifest, normalManifest) || !isDeepStrictEqual(fresh.compatibleManifest, compatibleManifest)) {
        throw new NativeDeliveryUnconfirmed('directory-input-changed-before-prepare')
      }
    }
    const privateState = { format: 'pe-cloud-local-native-input/v1', operation, plan }
    const save = state => saveNativeInput(STATE, operation, { ...privateState, state })
    const smokeArgs = args.length ? args : previousInput?.state.smokeArgs ?? args
    const state = await prepareNativeProductUpdate(selectedBundle, manifest, smokeArgs, operation, save)
    const current = { ...state.snapshot, holder: { pid: state.holder.pid,
      startTicks: state.holder.startTicks, namespaceId: state.holder.namespaceId } }
    if (!initial && !isDeepStrictEqual({ namespaceId: current.namespaceId, nodePath: current.nodePath,
      seccompPath: current.seccompPath, holder: current.holder }, previousInput.context)) {
      throw new NativeDeliveryUnconfirmed('native-generation-changed')
    }
    if (!initial) requireProductOnlyRollback(state)
    const approved = initial || assetRequested ? { journal: state.nativeJournal, assetParent: plan.assetParent,
      asset: plan.asset, profile: plan.profile } : { ...previousInput.approved, journal: state.nativeJournal }
    const authority = await createNativeAuthority(current, approved)
    let groups, descriptorSha256, pairBinding, assetBinding
    if (initial || assetRequested) {
      await authority.readProtectedInputs()
      if (assetRequested) {
        const facts = await authority.readDirectoryFacts()
        if (!isDeepStrictEqual(facts, plan.profile.directoryFacts)) throw new NativeDeliveryUnconfirmed('directory-facts-changed-before-reserve')
      }
      const candidate = await authority.previewProfile({ operation })
      Object.assign(approved, authority.snapshotApproved())
      const targetAsset = { path: '/opt/dsh-feature-assets/fd-skill-store-v1-' + plan.asset.sha256 + '.node',
        sha256: plan.asset.sha256, bytes: plan.asset.bytes, mode: 0o444,
        maxAssetBytes: plan.asset.maxAssetBytes, maxPathBytes: plan.asset.maxPathBytes }
      groups = [{ role: 'original', productRoot: '/opt/dsh-installed-products', manifest: assetRequested ? previous.installed.manifest : latest.manifest,
        asset: plan.originalAsset, profile: plan.profile.original },
      { role: 'normal', productRoot: '/opt/dsh-installed-products', manifest: normalManifest,
        asset: targetAsset, profile: candidate },
      { role: 'compatible', productRoot: '/opt/dsh-installed-products', manifest: compatibleManifest,
        asset: targetAsset, profile: candidate }]
      if (assetRequested) {
        assetBinding = { format: 'pe-cloud-native-directory-asset-binding/v1', predecessor: structuredClone(previous.record),
          release: { format: 'pe-cloud-native-release/v1', operation: previous.record.operation },
          controller: { commit: controller.commit, tree: controller.tree, programSha256: controller.programSha256 },
          context: structuredClone(previousInput.context), originSha256: digest(JSON.stringify(plan.origin)),
          nativeProtocol: plan.profile.nativeProtocol, directoryFactsSha256: digest(JSON.stringify(plan.profile.directoryFacts)),
          asset: structuredClone(targetAsset), profile: { source: candidate.source, sha256: candidate.sha256, bytes: candidate.bytes },
          groups: groups.map(tupleSha256) }
        descriptorSha256 = stateModule.nativeAssetDescriptor(assetBinding)
      } else descriptorSha256 = digest(JSON.stringify({ groups: groups.map(tupleSha256), assetSource: plan.asset.sourceSha256,
        namespaceId: current.namespaceId, holder: current.holder }))
    } else {
      groups = structuredClone(derived?.groups ?? previousInput.groups)
      descriptorSha256 = derived?.descriptorSha256 ?? previousInput.descriptorSha256
      pairBinding = derived?.pairBinding ?? previousInput.pairBinding
      assetBinding = successorRequested ? undefined : previousInput.assetBinding
    }
    const normal = groups[1], compatible = groups[2]
    const target = isDeepStrictEqual(manifest, normal.manifest) ? normal : compatible
    const originalTupleSha256 = initial ? tupleSha256(groups[0]) : previous.record.targetTupleSha256
    const pins = { kind: initial || assetRequested ? 'fd-profile' : successorRequested ? 'successor-js' : 'matching-js',
      operation, descriptorSha256, originalTupleSha256, targetTupleSha256: tupleSha256(target),
      compatibleTupleSha256: tupleSha256(target === normal ? compatible : normal) }
    state.nativeOriginalTupleSha256 = pins.originalTupleSha256
    Object.assign(privateState, { context: { namespaceId: current.namespaceId, nodePath: current.nodePath,
      seccompPath: current.seccompPath, holder: current.holder }, approved, groups, descriptorSha256 })
    if (pairBinding !== undefined) privateState.pairBinding = pairBinding
    if (assetBinding !== undefined) privateState.assetBinding = assetBinding
    if (successorRequested || assetRequested) privateState.controller = controller
    const persist = () => save(state)
    const effects = nativeUpdateEffects(state, {
      observeTuple: () => authority.observeTuple(groups),
      publish: async () => {
        const result = await authority.publish(pins, assetBytes)
        for (const group of groups) if (group.role !== 'original') group.profile = structuredClone(result.profile)
        Object.assign(approved, authority.snapshotApproved())
        privateState.publication = result
        await persist()
      },
      unbind: () => authority.unbind(pins), bind: () => authority.bind(pins), seal: () => authority.seal(pins),
    })
    const checkPair = effects.checkPair
    effects.checkPair = async () => { await checkPair(); await persist() }
    const start = effects.start
    effects.start = async () => {
      let failure, value
      try { value = await start() } catch (error) { failure = error }
      try { await persist() } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'native launch and receipt failed')
      }
      if (failure !== undefined) throw failure
      return value
    }
    await persist()
    return runNativeDelivery({ directory: STATE, pins, authority, previousAuthority, effects,
      successor: successorRequested ? pairBinding : undefined,
      assetSuccessor: assetRequested ? assetBinding : undefined,
      confirmPredecessor: async () => (await readPrevious()).record,
      holdOperation: action => action() })
  })
}
