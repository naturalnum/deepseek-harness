/** Strict worker-side decode before the independent full-tree native operation. */
import type { FdBundleRequest } from './bundle-native.ts'
import type { FdProjectMetadataRequest, FdWorkerInput } from './worker-protocol.ts'
import { bundlePath, skillBundleLimits } from './bundle-codec.ts'
import { skillVersionLimits } from './skill-versions.ts'
import type { SkillVersionId } from './skill-versions.ts'

/** Complete fixed native signature; no callback or host extraction path crosses this boundary. */
export type BundleNativeOperation = (this: void, path: string, device: string, inode: string, mount: string,
  uid: number, gid: number, operation: number, version: string, files: FdBundleRequest['tree']['files'],
  directories: readonly string[], retained: readonly string[], revision: string, maxVersions: number, maxBytes: number,
  maxInodes: number, maxFile: number, maxEntries: number, maxDepth: number, maxPath: number, maxCatalog: number,
  timeout: number, cancel: Int32Array<SharedArrayBuffer>, metadataInode: string, expectedCopyInode: string) => unknown

function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function uuid(v: unknown): v is SkillVersionId { return typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) }
function decimal(v: unknown): v is string { return typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)
  && BigInt(v) <= 0xffffffffffffffffn }

/**
 * Decode a bounded cloned request against exact bootstrap capacities and the original root parser.
 * @param raw The cloned request received by the worker.
 * @param base Original root, identity, operation and cancellation validated by the fixed parser.
 * @param config Actual immutable worker bootstrap capacities.
 * @returns The complete checked request, or undefined without invoking the helper.
 */
export function bundleRequest(raw: Record<string, unknown>, base: FdProjectMetadataRequest, config: FdWorkerInput)
  : FdBundleRequest | undefined {
  const limits = skillBundleLimits(raw.limits), storage = skillVersionLimits(raw.storage), configured = config.skillBundles
  const expectedStorage = config.skillVersions === undefined ? undefined : { ...config.skillVersions,
    maxVersions: raw.kind === 'bundle-project' && config.skillProjection !== undefined ? config.skillProjection.maxCopiesPerProject
      : config.skillVersions.maxVersions }
  if (configured === undefined || expectedStorage === undefined || limits === undefined || storage === undefined
    || Object.keys(raw).length !== 14 || !Object.entries(configured).every(([k, v]) => Object.entries(limits)
    .some(([key, value]) => key === k && value === v))
    || !Object.entries(expectedStorage).every(([k, v]) => Object.entries(storage).some(([key, value]) => key === k && value === v))
    || !['bundle-prepare', 'bundle-project', 'bundle-reclaim'].includes(String(raw.kind)) || !uuid(raw.version)
    || !object(raw.tree) || Object.keys(raw.tree).length !== 2 || !Array.isArray(raw.tree.files)
    || !Array.isArray(raw.tree.directories) || raw.tree.files.length > limits.maxFiles + 1
    || raw.tree.directories.length > limits.maxDirectories + 1 || !Array.isArray(raw.retained)
    || raw.retained.length > storage.maxVersions || !raw.retained.every(uuid) || new Set(raw.retained).size !== raw.retained.length
    || typeof raw.revision !== 'string' || Buffer.byteLength(raw.revision) > 191 || !decimal(raw.expectedCopyInode)) return undefined
  const kind = raw.kind
  if (kind !== 'bundle-prepare' && kind !== 'bundle-project' && kind !== 'bundle-reclaim') return undefined
  const pathLimits = { ...limits, maxPathBytes: limits.maxPathBytes + 5, maxDepth: limits.maxDepth + 1 }
  let bytes = 2048, dataBytes = 0
  const files: Array<{ relativePath: string; data: Uint8Array<ArrayBuffer> }> = []
  const directories: string[] = []
  try {
    for (const item of raw.tree.files) {
      if (!object(item) || Object.keys(item).length !== 2 || !(item.data instanceof Uint8Array)
        || !(item.data.buffer instanceof ArrayBuffer) || item.data.byteOffset !== 0
        || item.data.byteLength !== item.data.buffer.byteLength) return undefined
      const relativePath = bundlePath(item.relativePath, pathLimits), data = new Uint8Array(item.data.buffer)
      const maximum = kind === 'bundle-prepare' && relativePath === 'manifest.json' ? limits.maxManifestBytes : limits.maxFileBytes
      if (data.byteLength > maximum) return undefined
      bytes += data.byteLength + 2 * Buffer.byteLength(relativePath) + 128; dataBytes += data.byteLength
      files.push({ relativePath, data })
    }
    for (const item of raw.tree.directories) {
      const path = bundlePath(item, pathLimits); bytes += 2 * Buffer.byteLength(path) + 64; directories.push(path)
    }
  } catch (_error) { return undefined }
  const paths = files.map(f => f.relativePath)
  if (new Set(paths).size !== paths.length || new Set(directories).size !== directories.length
    || directories.some(d => paths.includes(d)) || bytes > limits.maxRequestBytes
    || dataBytes > limits.maxContentBytes + limits.maxManifestBytes || dataBytes > limits.maxStagingBytes
    || base.root.rootMountId === undefined || Buffer.byteLength(base.root.rootPath) + 96 + pathLimits.maxPathBytes > config.maxPathBytes
    || kind === 'bundle-reclaim' && (files.length !== 0 || directories.length !== 0)) return undefined
  const m = raw.metadata
  if (kind === 'bundle-project' ? !object(m) || Object.keys(m).length !== 6 || m.device !== base.root.rootDevice
    || m.mountId !== base.root.rootMountId || !decimal(m.inode) || m.inode === '0'
    || m.uid !== base.uid || m.gid !== base.gid || m.mode !== 0o40700 : m !== null) return undefined
  const metadata = object(m) && decimal(m.inode) ? { device: base.root.rootDevice, inode: m.inode,
    mountId: base.root.rootMountId, uid: base.uid, gid: base.gid, mode: 0o40700 } : null
  return { ...base, kind, version: raw.version, tree: { files, directories }, metadata, expectedCopyInode: raw.expectedCopyInode,
    retained: raw.retained, revision: raw.revision, limits, storage }
}

/**
 * Invoke the actual helper with validated complete values; no synthesized success is permitted.
 * @param operation The independently advertised native callback.
 * @param request The complete checked original request.
 * @param config Actual worker timeout and transport capacities.
 * @returns The actual raw native result for the production receipt parser.
 */
export function runBundleNative(operation: BundleNativeOperation, request: FdBundleRequest, config: FdWorkerInput): unknown {
  const root = request.root, limits = request.limits, storage = request.storage
  if (root.rootMountId === undefined || config.content === undefined) throw new Error('Bundle bootstrap is incomplete')
  return operation(root.rootPath, root.rootDevice, root.rootInode, root.rootMountId, request.uid, request.gid,
    request.kind === 'bundle-prepare' ? 0 : request.kind === 'bundle-project' ? 1 : 2,
    request.version, request.tree.files, request.tree.directories, request.retained, request.revision,
    storage.maxVersions, storage.maxTotalBytes, storage.maxTotalInodes, Math.max(limits.maxFileBytes, limits.maxManifestBytes),
    limits.maxFiles + limits.maxDirectories + 2, limits.maxDepth + 2, config.maxPathBytes, limits.maxCatalogBytes,
    config.content.operationTimeoutMs, new Int32Array(request.cancel), request.metadata?.inode ?? '0', request.expectedCopyInode)
}
