/** Fixed native single-line delivery and matching JS continuation through the normal update lifecycle. */
import fs from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifyBundle } from '../bundle.mjs'
import { nativeUpdateEffects, prepareNativeProductUpdate, requireProductOnlyRollback } from './update.mjs'
import { createNativeAuthority } from './native-authority.mjs'
import { runNativeDelivery, saveNativeInput, withNativeOperationLock, requireNativeReleaseComplete } from './native-delivery.mjs'
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

function privateInput(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let value, failure
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
      || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new NativeDeliveryUnconfirmed('private-input-file')
    const bytes = fs.readFileSync(fd)
    if (bytes.length !== stat.size) throw new NativeDeliveryUnconfirmed('private-input-read')
    value = JSON.parse(bytes)
  } catch (error) { failure = error }
  try { fs.closeSync(fd) } catch (error) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'native input and close failed')
  }
  if (failure !== undefined) throw new NativeDeliveryUnconfirmed('private-input', failure)
  return value
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
