/** Bounded compiled Cloud locations for deployment diagnostics; error text stays private. */
const SITE = new RegExp(
  String.raw`/packages/cloud/(pe-cloud-access|pe-cloud-api|pe-cloud-files|pe-cloud-runtime|pe-opensandbox)`
  + String.raw`/lib/(root|index|account-service|managed-coordinator|closed-owner)(-[A-Za-z0-9_-]{8})?\.js:([0-9]{1,7}):([0-9]{1,7})\)?$`,
)
const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get
const CHUNKS: Readonly<Record<string, readonly string[]>> = {
  'pe-cloud-api': ['account-service'], 'pe-cloud-files': ['account-service'],
  'pe-opensandbox': ['managed-coordinator', 'closed-owner'],
}

/**
 * Read an own stack value or the unchanged native accessor, retaining fixed names and numeric positions.
 * @param error Original failure; custom accessors, oversized stacks and other locations are ignored.
 * @returns At most six locations with chunk hashes normalized, without messages, request values or private paths.
 */
export function cloudFailureSites(error: unknown): readonly string[] {
  if (error === null || typeof error !== 'object') return []
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'stack')
    const stack: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value
      : NATIVE_STACK_GETTER !== undefined && descriptor?.get === NATIVE_STACK_GETTER
        ? Reflect.apply(NATIVE_STACK_GETTER, error, []) : undefined
    if (typeof stack !== 'string' || stack.length > 16384) return []
    const sites: string[] = []
    for (const line of stack.split('\n').slice(1)) {
      const match = SITE.exec(line)
      if (match !== null && (match[2] === 'root' || match[2] === 'index'
        || CHUNKS[match[1] ?? '']?.includes(match[2] ?? '') === true)) {
        sites.push(`${match[1]}/${match[2]}${match[3] === undefined ? '' : '*'}.js:${match[4]}:${match[5]}`)
      }
      if (sites.length === 6) break
    }
    return sites
  } catch (_unreadable: unknown) { return [] } // Diagnostics do not replace the original failure.
}
