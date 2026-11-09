/** Closed reviewed SDK suppliers; these declarations neither select a deployment nor enable account features. */
import { RUNTIME_PROFILES, type RuntimePlatform } from './runtime-profiles.ts'

/** Original Native workload supplier. */
export const NATIVE_WORKLOAD_IMAGE_DIGEST = 'sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a'
/** Native layers plus the pinned OpenSSH client dependency layer. */
export const REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST = 'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d'
/** Immutable Office dependency supplier; actual CLI/model execution requires separate qualification. */
export const OFFICE_WORKLOAD_IMAGE_DIGEST = 'sha256:ff336ad49a52795fa82960da50a46cc7cbb654326ad5160313f94355d1cce461'
/** Reviewed Session-directory guard with the original Native creation profile. */
export const SESSION_DIRECTORY_SERVER_IMAGE_DIGEST = 'sha256:7a41332aef7bcc74414b1434c7e10ee057c420e213d082fc79ac791c921af6ba'
/** Directory-aware server paired with the OpenSSH workload. */
export const REMOTE_CLIENT_SERVER_IMAGE_DIGEST = 'sha256:6497790ee3398569aef7d8f35d442e76c33c9be08633a6a2732dbcb2ee1fe01e'
/** Office-only creation policy; predecessor workloads remain closed-admission audit inputs. */
export const OFFICE_SERVER_IMAGE_DIGEST = 'sha256:1b7ec16bb1031eab0fd7024905fc03dc5f814fbfe46bbb2d5aa2f88e3813b628'

/** Built Office superset with separately installed dependencies; managed business and Web qualification remain separate. */
export const OFFICE_RESEARCH_WORKLOAD_IMAGE_DIGEST = 'sha256:71c7afa35f5d774ec6a198c7233b645bc16275c56595369efa368d6fac025bf8'
/** COPY-only Office server overlay that creates only the paired immutable superset workload. */
export const OFFICE_RESEARCH_SERVER_IMAGE_DIGEST = 'sha256:7d8a5f0bfe9d7db24ff396d57f930ef8a6be2d4651c05d229e6d2624cfc2e042'

/** Office/research dependency superset with the qualified independent Git prefix. */
export const OFFICE_RESEARCH_GIT_WORKLOAD_IMAGE_DIGEST = 'sha256:44e26197f73faece822111f939e23a14816cf4fd5eb53362e0088087c42a8c1e'
/** COPY-only server paired exclusively with the Git dependency superset. */
export const OFFICE_RESEARCH_GIT_SERVER_IMAGE_DIGEST = 'sha256:c0e629914f5b62c74f63e6a0632fd75de47ef6c4abc2321f277525350848894f'

/** Official Git getrandom build in the same independent dependency prefix. */
export const OFFICE_RESEARCH_GIT_GETRANDOM_WORKLOAD_IMAGE_DIGEST = 'sha256:4a7ce478412f06d3369ff338aaa971acaa7bc6e6778995c1558eb9c997cb263a'
/** COPY-only server paired exclusively with the getrandom Git workload. */
export const OFFICE_RESEARCH_GIT_GETRANDOM_SERVER_IMAGE_DIGEST = 'sha256:87bbc26029f68dab351a3abd958fda82877cb29b3d15a77fe5887c858ab1de57'

/** Actual Native AMD64 artifact; Office/Research layers and product use require separate qualification. */
export const NATIVE_AMD64_WORKLOAD_IMAGE_DIGEST = 'sha256:84d3c8cd1520dfb2b088f9d3dbd296f4d18fabed3b18fb0aea01e6e378f9d5eb'
/** Actual six-file guarded SDK overlay paired exclusively with the Native AMD64 artifact. */
export const NATIVE_AMD64_SERVER_IMAGE_DIGEST = 'sha256:7b9ef8e0c71d81c9d6909cae992015f8789e9e152d5a21aee03836fd08ac7224'

/** Complete AMD64 Office, independent Research, getrandom Git and SSH client supplier. */
export const OFFICE_RESEARCH_GIT_SSH_AMD64_WORKLOAD_IMAGE_DIGEST = 'sha256:4b7497e321629c90db04a8105865ca9f932beedeb67239cb22e68ed1a66dc360'
/** COPY-only original SDK policy variant paired exclusively with that complete AMD64 workload. */
export const OFFICE_RESEARCH_GIT_SSH_AMD64_SERVER_IMAGE_DIGEST = 'sha256:28e4ebc841f3bc9b09f5cbfce8ce289522d259daa95f2b9ca152786ca8b5de0b'

/** One reviewed storage schema, workload and server combination; no caller can register another supplier. */
export interface QualifiedSupplierTuple {
  readonly schema: 'pe-opensandbox-root-deployment-v1' | 'pe-opensandbox-root-deployment-v2'
  readonly workloadImageDigest: string
  readonly serverImageDigest: string
  /** Exact Linux architecture shared by the workload and original execd release. */
  readonly platform: RuntimePlatform
  /** The selected architecture's immutable original release image. */
  readonly execdImageDigest: string
  /** The exact server includes the original direct-UUID-child Session environment guard. */
  readonly sessionDirectories: boolean
}

/** Complete creation-admission inventory; readonly audit predecessors are not creation suppliers. */
export const qualifiedSupplierTuples: readonly QualifiedSupplierTuple[] = Object.freeze([
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v1', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: 'sha256:64383075f5bd4dae3f76b283c7cbed38d067446aad66373b840ffc16bdcefa17', sessionDirectories: false }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: 'sha256:fec2756169ff3e9baf123c0f2e9664baf3f2214898372c180847d991559ce0fd', sessionDirectories: false }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: SESSION_DIRECTORY_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: REMOTE_CLIENT_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: OFFICE_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_RESEARCH_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: OFFICE_RESEARCH_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_RESEARCH_GIT_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: OFFICE_RESEARCH_GIT_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_RESEARCH_GIT_GETRANDOM_WORKLOAD_IMAGE_DIGEST,
    platform: 'arm64', execdImageDigest: RUNTIME_PROFILES.arm64.execdImageDigest,
    serverImageDigest: OFFICE_RESEARCH_GIT_GETRANDOM_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: NATIVE_AMD64_WORKLOAD_IMAGE_DIGEST,
    platform: 'amd64', execdImageDigest: RUNTIME_PROFILES.amd64.execdImageDigest,
    serverImageDigest: NATIVE_AMD64_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
  Object.freeze({ schema: 'pe-opensandbox-root-deployment-v2', workloadImageDigest: OFFICE_RESEARCH_GIT_SSH_AMD64_WORKLOAD_IMAGE_DIGEST,
    platform: 'amd64', execdImageDigest: RUNTIME_PROFILES.amd64.execdImageDigest,
    serverImageDigest: OFFICE_RESEARCH_GIT_SSH_AMD64_SERVER_IMAGE_DIGEST, sessionDirectories: true }),
])

/**
 * Check the workload projection shared by protected selection and the original SDK bootstrap.
 * @param value Decoded workload selector.
 * @param platform When supplied, require that exact reviewed architecture; omission checks the inventory projection only.
 * @returns Whether an exact reviewed tuple contains the workload.
 */
export function isPinnedWorkloadImageDigest(value: unknown, platform?: RuntimePlatform): value is string {
  return qualifiedSupplierTuples.some(row => row.workloadImageDigest === value
    && (platform === undefined || row.platform === platform))
}

/**
 * Check the server projection before validating a complete protected selection.
 * @param schema Original deployment storage schema.
 * @param image Decoded server selector.
 * @returns Whether an exact reviewed tuple contains this server and storage schema.
 */
export function isQualifiedServerImageDigest(schema: QualifiedSupplierTuple['schema'], image: string): boolean {
  return qualifiedSupplierTuples.some(row => row.schema === schema && row.serverImageDigest === image)
}

/**
 * Require the complete reviewed selection, rather than combining separate image inventories.
 * @param schema Original deployment storage schema.
 * @param workload Exact decoded workload selector.
 * @param server Exact decoded server selector.
 * @param platform Exact protected Linux architecture.
 * @param execd Exact original release selector for that architecture.
 * @returns Whether one reviewed tuple matches every input.
 */
export function isQualifiedSupplierPair(schema: QualifiedSupplierTuple['schema'], workload: string, server: string,
  platform: RuntimePlatform, execd: string): boolean {
  return qualifiedSupplierTuples.some(row => row.schema === schema && row.workloadImageDigest === workload
    && row.serverImageDigest === server && row.platform === platform && row.execdImageDigest === execd)
}

/**
 * Identify reviewed implementations of the original Session-directory guard for shared mounts.
 * @param image Explicit protected server selection, absent for legacy callers.
 * @returns Whether an exact reviewed server includes that directory guard.
 */
export function isSessionDirectoryServerImageDigest(image: string | undefined): boolean {
  return qualifiedSupplierTuples.some(row => row.sessionDirectories && row.serverImageDigest === image)
}
