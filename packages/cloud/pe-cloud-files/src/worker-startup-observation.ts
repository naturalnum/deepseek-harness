/** Private stderr diagnostics never read error messages, stacks, accessors or filesystem/configuration values. */
export type FileWorkerStartupStage = 'input' | 'storage-initialize' | 'fd-helper-load' | 'kernel-probe' | 'staging-helper-load'

const CODES = new Set(['FS_IO_ERROR', 'FS_PERMISSION_DENIED', 'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_ABORTED', 'FS_TOO_LARGE',
  'EIO', 'EINVAL', 'ENOSYS', 'EPERM', 'EACCES', 'ENOENT', 'ELOOP', 'EXDEV', 'ESTALE', 'ENOMEM', 'ENOTSUP',
  'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED', 'ERR_WORKER_INIT_FAILED', 'ERR_WORKER_OUT_OF_MEMORY'])

export function observeFileWorkerFailure(stage: FileWorkerStartupStage | 'worker-thread-error', error: unknown): void {
  let code = 'unclassified'
  try {
    const own = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
    if (own !== undefined && 'value' in own && typeof own.value === 'string' && CODES.has(own.value)) code = own.value
  } catch (_unavailableCode) { /* A hostile descriptor cannot alter the worker's original failure path. */ }
  try { console.warn('Cloud files worker failure: %j', { stage, code }) }
  catch (_unavailableObservation) { /* Reply, port closure and actual Worker exit retain their original owner. */ }
}
