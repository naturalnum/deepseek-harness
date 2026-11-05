/** Reviewed immutable workload suppliers; Root still selects one exact digest explicitly. */
export const NATIVE_WORKLOAD_IMAGE_DIGEST = 'sha256:62016189c3c5cec1c88d10af21b5dc0dfac0fc2247cd66709374dbdfc9d1135a'

/** Original Native layers plus the pinned OpenSSH client dependency layer; no Office capability is implied. */
export const REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST = 'sha256:c75632ff5ced1d239c688e836c383ce3629ef1a93f7b698294345f2aa8074f2d'

/** Immutable Office dependency supplier; declaration does not enable providers or certify actual CLI/model execution. */
export const OFFICE_WORKLOAD_IMAGE_DIGEST = 'sha256:ff336ad49a52795fa82960da50a46cc7cbb654326ad5160313f94355d1cce461'

/**
 * Restrict protected selection and SDK bootstrap to reviewed immutable workload images.
 * @param value Untrusted decoded image selector.
 * @returns Whether the selector is one of the exact reviewed digests.
 */
export function isPinnedWorkloadImageDigest(value: unknown): value is string {
  return value === NATIVE_WORKLOAD_IMAGE_DIGEST || value === REMOTE_CLIENT_WORKLOAD_IMAGE_DIGEST
    || value === OFFICE_WORKLOAD_IMAGE_DIGEST
}
