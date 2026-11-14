/** Fixed native single-line delivery and matching JS continuation through the normal update lifecycle. */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifyBundle } from '../bundle.mjs'
import { nativeUpdateEffects, prepareNativeProductUpdate, requireProductOnlyRollback } from './update.mjs'
import { createNativeAuthority } from './native-authority.mjs'
import { runNativeDelivery, runNativePublishContinuation, saveNativeInput, withNativeOperationLock,
  withRetainedNativePublishLock, requireNativeReleaseComplete } from './native-delivery.mjs'
import { assertCandidateLock } from './candidate-lock.mjs'
import { inspectCandidate, inspectExec } from './inspect.mjs'
import { preflight } from './dependencies.mjs'
import stateModule from './native-delivery-state.cjs'
import profileModule from './native-profile.cjs'

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

function currentNativeContext(snapshot) {
  return { ...snapshot, holder: { pid: snapshot.namespaceKeeperPid,
    startTicks: snapshot.namespaceKeeperStartTicks, namespaceId: snapshot.namespaceId } }
}

/**
 * Confirm a saved pair against a fresh Root record and the actual sealed installation, without preparing a stage.
 * @param {object} request Exact host projection/private input, current namespace facts and original Root authority.
 * @returns {Promise<object>} Complete verified predecessor and its installed group; mismatch performs no mutation.
 */
export async function confirmNativePredecessor({ latest, input, current, authority }) {
  requireAssetPlan(input.plan)
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
  if (input.pairBinding === undefined) {
    descriptorSha256 = digest(JSON.stringify({ groups: groups.map(tupleSha256), assetSource: input.plan.asset.sourceSha256,
      namespaceId: context.namespaceId, holder: context.holder }))
  } else {
    descriptorSha256 = stateModule.nativeSuccessorDescriptor(input.pairBinding)
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
  stateModule.requireNativeContinuation(record, observed, record.targetTupleSha256)
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
  return { record, installed }
}

/**
 * Derive three observable groups exclusively from two verified product archives and the confirmed predecessor.
 * @param {object} request Confirmed predecessor/private inputs, explicit successor identity and real normal bundle path.
 * @returns {Promise<object>} New immutable pair binding and manifests; no Root or host record is changed.
 */
export async function deriveNativeSuccessorPair({ previousInput, previous, successor, normalBundle, controller }) {
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
  return { groups, pairBinding, descriptorSha256: stateModule.nativeSuccessorDescriptor(pairBinding),
    normalManifest: normal, compatibleManifest: compatible }
}

/**
 * Install the fixed FD/profile, switch an approved pair, or explicitly derive a same-FD/profile successor pair.
 * @param {object} request Normal command with mutually exclusive first-delivery/successor input; absent uses the saved pair.
 * @returns {Promise<object>} Verified new responsibility; any unknown action retains the operation lock without recovery.
 */
export async function nativeUpdate({ mode, bundle, args, inputFile, successorFile, latest }) {
  if (!['update', 'rollback'].includes(mode)) throw new NativeDeliveryUnconfirmed('native-start-requires-owner')
  const initial = inputFile !== undefined, successorRequested = successorFile !== undefined
  if (successorRequested && (initial || mode !== 'update' || !bundle || latest?.format !== PROJECTION)) {
    throw new NativeDeliveryUnconfirmed('successor-entry')
  }
  if (initial && latest?.format === PROJECTION) throw new NativeDeliveryUnconfirmed('native-group-already-owned')
  if (!initial && latest?.format !== PROJECTION) throw new NativeDeliveryUnconfirmed('native-state-missing')
  let plan, previousInput, savedPrevious, previous, successor, successorSaved, derived, previousAuthority, controller
  const readPrevious = async () => {
    requireNativeReleaseComplete(STATE, undefined, latest.operation)
    if (!isDeepStrictEqual(privateInput(join(STATE, 'latest.json')), latest)
      || !isDeepStrictEqual(privateInput(join(STATE, latest.operation + '.native.json'), true), savedPrevious)
      || successorRequested && !isDeepStrictEqual(privateInput(resolve(successorFile), true), successorSaved)) {
      throw new NativeDeliveryUnconfirmed('latest-or-input-changed-before-operation')
    }
    if (successorRequested && !isDeepStrictEqual(controllerSource(), controller)) {
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
    // No new operation, private save or Root stage before this read-only confirmation.
    previous = await readPrevious()
    plan = structuredClone(previousInput.plan)
    if (successorRequested) {
      derived = await deriveNativeSuccessorPair({ previousInput, previous, successor, normalBundle: bundle, controller })
      plan.compatibleBundle = successor.compatibleBundle
    }
  }
  const selectedBundle = mode === 'rollback' ? resolve(plan.compatibleBundle) : resolve(bundle)
  const manifest = derived?.normalManifest ?? await verifyBundle(selectedBundle)
  const normalManifest = derived?.normalManifest ?? (initial ? manifest : previousInput.groups[1].manifest)
  const compatibleManifest = derived?.compatibleManifest ?? (initial ? await verifyBundle(resolve(plan.compatibleBundle))
    : previousInput.groups[2].manifest)
  if (normalManifest.externalDependencyHash !== compatibleManifest.externalDependencyHash
    || normalManifest.researchLockHash !== compatibleManifest.researchLockHash) {
    throw new NativeDeliveryUnconfirmed('native-reader-dependencies')
  }
  if (!initial && !successorRequested && ![normalManifest, compatibleManifest].some(value => isDeepStrictEqual(value, manifest))) {
    throw new NativeDeliveryUnconfirmed('unapproved-js-group')
  }
  let assetBytes
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
    const approved = initial ? { journal: state.nativeJournal, assetParent: plan.assetParent,
      asset: plan.asset, profile: plan.profile } : { ...previousInput.approved, journal: state.nativeJournal }
    const authority = await createNativeAuthority(current, approved)
    let groups, descriptorSha256, pairBinding
    if (initial) {
      await authority.readProtectedInputs()
      const candidate = await authority.previewProfile({ operation })
      Object.assign(approved, authority.snapshotApproved())
      const targetAsset = { path: '/opt/dsh-feature-assets/fd-skill-store-v1-' + plan.asset.sha256 + '.node',
        sha256: plan.asset.sha256, bytes: plan.asset.bytes, mode: 0o444,
        maxAssetBytes: plan.asset.maxAssetBytes, maxPathBytes: plan.asset.maxPathBytes }
      groups = [{ role: 'original', productRoot: '/opt/dsh-installed-products', manifest: latest.manifest,
        asset: plan.originalAsset, profile: plan.profile.original },
      { role: 'normal', productRoot: '/opt/dsh-installed-products', manifest: normalManifest,
        asset: targetAsset, profile: candidate },
      { role: 'compatible', productRoot: '/opt/dsh-installed-products', manifest: compatibleManifest,
        asset: targetAsset, profile: candidate }]
      descriptorSha256 = digest(JSON.stringify({ groups: groups.map(tupleSha256), assetSource: plan.asset.sourceSha256,
        namespaceId: current.namespaceId, holder: current.holder }))
    } else {
      groups = structuredClone(derived?.groups ?? previousInput.groups)
      descriptorSha256 = derived?.descriptorSha256 ?? previousInput.descriptorSha256
      pairBinding = derived?.pairBinding ?? previousInput.pairBinding
    }
    const normal = groups[1], compatible = groups[2]
    const target = isDeepStrictEqual(manifest, normal.manifest) ? normal : compatible
    const originalTupleSha256 = initial ? tupleSha256(groups[0]) : previous.record.targetTupleSha256
    const pins = { kind: initial ? 'fd-profile' : successorRequested ? 'successor-js' : 'matching-js',
      operation, descriptorSha256, originalTupleSha256, targetTupleSha256: tupleSha256(target),
      compatibleTupleSha256: tupleSha256(target === normal ? compatible : normal) }
    state.nativeOriginalTupleSha256 = pins.originalTupleSha256
    Object.assign(privateState, { context: { namespaceId: current.namespaceId, nodePath: current.nodePath,
      seccompPath: current.seccompPath, holder: current.holder }, approved, groups, descriptorSha256 })
    if (pairBinding !== undefined) privateState.pairBinding = pairBinding
    if (successorRequested) privateState.controller = controller
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
      confirmPredecessor: async () => (await readPrevious()).record,
      holdOperation: action => action() })
  })
}
