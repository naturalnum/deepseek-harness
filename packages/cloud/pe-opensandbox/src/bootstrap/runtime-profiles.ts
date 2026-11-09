/** Original release binaries selected by protected Linux deployment inputs. */
export const RUNTIME_PROFILES = Object.freeze({
  arm64: Object.freeze({
    execdImageDigest: 'sha256:39ee9357842bc4a931a208170484ae6d1e33985f5d256b13d654a7c3ce35cbdf',
    bwrapSha256: '0fc274e60c4b606db202dc9e82db60b4d944ba74bab8b6af2cd95ea28c4f8b2d',
    bwrapBytes: 814328,
    elfMachine: 183,
  }),
  amd64: Object.freeze({
    execdImageDigest: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de',
    bwrapSha256: '2eac825be98626a3a7e8daf17afdedcb65560951cb26ffaecea261f5686acb28',
    bwrapBytes: 734864,
    elfMachine: 62,
  }),
})

/** Closed platform inventory; image qualification remains a separate complete tuple check. */
export type RuntimePlatform = keyof typeof RUNTIME_PROFILES

/**
 * Decode only a reviewed platform before selecting its fixed binary bytes.
 * @param value Protected deployment or local carrier platform; never learned from a remote response.
 * @returns Whether the value selects one of the two reviewed profiles.
 */
export function isRuntimePlatform(value: unknown): value is RuntimePlatform {
  return value === 'arm64' || value === 'amd64'
}
