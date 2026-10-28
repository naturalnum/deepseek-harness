/** Private diagnostics retain only fixed error facts and approved public locations, never raw errors or accessors. */
export type FileWorkerStartupStage = 'input' | 'storage-initialize' | 'fd-helper-load' | 'kernel-probe' | 'staging-helper-load'

const CODES = new Set(['FS_IO_ERROR', 'FS_PERMISSION_DENIED', 'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_ABORTED', 'FS_TOO_LARGE',
  'EIO', 'EINVAL', 'ENOSYS', 'EPERM', 'EACCES', 'ENOENT', 'ELOOP', 'EXDEV', 'ESTALE', 'ENOMEM', 'ENOTSUP',
  'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED', 'ERR_WORKER_INIT_FAILED', 'ERR_WORKER_OUT_OF_MEMORY',
  'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_IMPORT_ATTRIBUTE_MISSING', 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE',
  'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_UNSUPPORTED_ESM_URL_SCHEME', 'ERR_PACKAGE_PATH_NOT_EXPORTED'])
const NAMES = new Map<object, string>([[SyntaxError.prototype, 'SyntaxError'], [TypeError.prototype, 'TypeError'],
  [RangeError.prototype, 'RangeError'], [ReferenceError.prototype, 'ReferenceError'], [EvalError.prototype, 'EvalError'],
  [URIError.prototype, 'URIError'], [AggregateError.prototype, 'AggregateError'], [Error.prototype, 'Error']])
const PUBLIC_SITE = new RegExp(
  String.raw`/(packages/(?:cloud/pe-cloud-files|fs/fs|llm/llm|typert/protocol|util/(?:brand|crypto|timeout|values)))`
  + String.raw`/lib/(file-worker|worker-client|directory-budget|error|account-service|account|root|index)`
  + String.raw`(-[A-Za-z0-9_-]{8})?\.(m?js):([0-9]{1,7})(?::([0-9]{1,7}))?\)?$`,
)
const NODE_SITE = new RegExp(
  String.raw`(?:^|[\s(])node:(internal/(?:modules/esm/(?:module_job|loader|module_map|resolve|load|translators|utils|worker|hooks)`
  + String.raw`|modules/cjs/loader|main/worker_thread|worker|per_context/messageport|process/task_queues|event_target|errors|vm)`
  + String.raw`|events|async_hooks|vm):([0-9]{1,7}):([0-9]{1,7})\)?$`,
)
const EXPORTS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-fs': ['FsVersion'], 'yauzl': ['fromBuffer'], 'fflate': ['Zip', 'ZipPassThrough'],
  'node:crypto': ['createHash', 'randomUUID'], 'node:module': ['createRequire'],
  'node:worker_threads': ['Worker', 'parentPort', 'workerData', 'isMainThread'], 'node:zlib': ['crc32'],
}

function ownString(error: unknown, key: string): string | undefined {
  try {
    const own = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, key) : undefined
    return own !== undefined && 'value' in own && typeof own.value === 'string' ? own.value : undefined
  } catch (_unavailableProperty) { return undefined }
}

function threadFacts(error: unknown): {
  name: string
  sites: readonly string[]
  namedExport?: Readonly<{ specifier: string; identifier: string }>
} {
  let name = 'Error'
  try {
    const own = ownString(error, 'name')
    if (own !== undefined && [...NAMES.values()].includes(own)) name = own
    else if (typeof error === 'object' && error !== null) name = NAMES.get(Object.getPrototypeOf(error)) ?? name
  } catch (_unavailableName) { /* Unknown error types retain only the fixed generic name. */ }
  const stack = ownString(error, 'stack'), sites: string[] = []
  if (stack !== undefined && stack.length <= 16384) for (const line of stack.split('\n')) {
    const match = PUBLIC_SITE.exec(line), node = NODE_SITE.exec(line)
    if (match !== null && (match[1] === 'packages/cloud/pe-cloud-files' || match[2] === 'index' && match[3] === undefined)) {
      sites.push(`${match[1]}/lib/${match[2]}${match[3] === undefined ? '' : '*'}.${match[4]}:${match[5]}`
        + (match[6] === undefined ? '' : ':' + match[6]))
    } else if (node !== null) sites.push(`node:${node[1]}:${node[2]}:${node[3]}`)
    if (sites.length === 6) break
  }
  const message = ownString(error, 'message')
  const named = name === 'SyntaxError' && message !== undefined && message.length <= 512
    ? /^The requested module '([^'\n]{1,128})' does not provide an export named '([A-Za-z_$][A-Za-z0-9_$]{0,63})'$/.exec(message) : null
  const specifier = named?.[1], identifier = named?.[2]
  const approved = specifier !== undefined && identifier !== undefined && Object.hasOwn(EXPORTS, specifier)
    && EXPORTS[specifier]?.includes(identifier) === true
  return { name, sites, ...approved ? { namedExport: { specifier, identifier } } : {} }
}

export function observeFileWorkerFailure(stage: FileWorkerStartupStage | 'worker-thread-error', error: unknown): void {
  let code = 'unclassified'
  try {
    const own = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code') : undefined
    if (own !== undefined && 'value' in own && typeof own.value === 'string' && CODES.has(own.value)) code = own.value
  } catch (_unavailableCode) { /* A hostile descriptor cannot alter the worker's original failure path. */ }
  try { console.warn('Cloud files worker failure: %j', { stage, code, ...stage === 'worker-thread-error' ? threadFacts(error) : {} }) }
  catch (_unavailableObservation) { /* Reply, port closure and actual Worker exit retain their original owner. */ }
}
