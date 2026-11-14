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

/**
 * Install the one reviewed FD/profile group, or continue with an already-approved matching JS bundle.
 * @param {object} request Current default command, private first-delivery input and saved latest state.
 * @returns {Promise<object>} Verified authoritative record; unknown actions retain the operation lock.
 */
export async function nativeUpdate({ mode, bundle, args, inputFile, latest }) {
  if (!['update', 'rollback'].includes(mode)) throw new NativeDeliveryUnconfirmed('native-start-requires-owner')
  const initial = inputFile !== undefined
  if (initial && latest?.format === PROJECTION) throw new NativeDeliveryUnconfirmed('native-group-already-owned')
  if (!initial && latest?.format !== PROJECTION) throw new NativeDeliveryUnconfirmed('native-state-missing')
  let plan, previousInput
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
    requireNativeReleaseComplete(STATE, undefined, latest.operation)
    previousInput = privateInput(join(STATE, latest.operation + '.native.json'))
    if (previousInput.format !== 'pe-cloud-local-native-input/v1' || previousInput.operation !== latest.operation
      || previousInput.descriptorSha256 !== latest.nativeAuthority?.descriptorSha256) {
      throw new NativeDeliveryUnconfirmed('native-private-state-mismatch')
    }
    plan = previousInput.plan
  }
  const selectedBundle = mode === 'rollback' ? resolve(plan.compatibleBundle) : resolve(bundle)
  const manifest = await verifyBundle(selectedBundle)
  const normalManifest = initial ? manifest : previousInput.groups.find(group => group.role === 'normal').manifest
  const compatibleManifest = initial ? await verifyBundle(resolve(plan.compatibleBundle))
    : previousInput.groups.find(group => group.role === 'compatible').manifest
  if (normalManifest.externalDependencyHash !== compatibleManifest.externalDependencyHash
    || normalManifest.researchLockHash !== compatibleManifest.researchLockHash) {
    throw new NativeDeliveryUnconfirmed('native-reader-dependencies')
  }
  if (!initial && ![normalManifest, compatibleManifest].some(value => isDeepStrictEqual(value, manifest))) {
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
    const privateState = { format: 'pe-cloud-local-native-input/v1', operation, plan }
    const save = state => saveNativeInput(STATE, operation, { ...privateState, state })
    const smokeArgs = args.length ? args : previousInput?.state.smokeArgs ?? args
    const state = await prepareNativeProductUpdate(selectedBundle, manifest, smokeArgs, operation, save)
    const current = { ...state.snapshot, holder: { pid: state.holder.pid,
      startTicks: state.holder.startTicks, namespaceId: state.holder.namespaceId } }
    if (!initial && (current.namespaceId !== previousInput.context.namespaceId
      || !isDeepStrictEqual(current.holder, previousInput.context.holder))) {
      throw new NativeDeliveryUnconfirmed('native-generation-changed')
    }
    if (!initial) requireProductOnlyRollback(state)
    const approved = initial ? { journal: state.nativeJournal, assetParent: plan.assetParent,
      asset: plan.asset, profile: plan.profile } : { ...previousInput.approved, journal: state.nativeJournal }
    const authority = await createNativeAuthority(current, approved)
    let groups, descriptorSha256, previousAuthority
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
      groups = structuredClone(previousInput.groups)
      descriptorSha256 = previousInput.descriptorSha256
      previousAuthority = await createNativeAuthority(current, previousInput.approved)
      const previous = await previousAuthority.read()
      if (previous.operation !== latest.operation || !isDeepStrictEqual(previous.directoryIdentity,
        latest.nativeAuthority.directoryIdentity)) throw new NativeDeliveryUnconfirmed('previous-authority-mismatch')
    }
    const normal = groups.find(group => group.role === 'normal'), compatible = groups.find(group => group.role === 'compatible')
    const target = isDeepStrictEqual(manifest, normal.manifest) ? normal : compatible
    const originalTupleSha256 = initial ? tupleSha256(groups.find(group => group.role === 'original'))
      : (await previousAuthority.read()).targetTupleSha256
    const pins = { kind: initial ? 'fd-profile' : 'matching-js', operation, descriptorSha256,
      originalTupleSha256, targetTupleSha256: tupleSha256(target),
      compatibleTupleSha256: tupleSha256(target === normal ? compatible : normal) }
    state.nativeOriginalTupleSha256 = pins.originalTupleSha256
    Object.assign(privateState, { context: { namespaceId: current.namespaceId, nodePath: current.nodePath,
      seccompPath: current.seccompPath, holder: current.holder }, approved, groups, descriptorSha256 })
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
      holdOperation: action => action() })
  })
}
