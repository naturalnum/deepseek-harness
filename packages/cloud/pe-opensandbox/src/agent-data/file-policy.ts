/** Finite per-operation file mode covered by the original Root spec hash and role signature. */
import { LocalRefusal } from './errors.ts'

/** The fixed cloud workload supports these modes inside its existing account mounts. */
export interface NativeFilePolicy {
  readonly mode: 'read-only' | 'workspace-write'
}

/**
 * Validate and copy one per-operation policy at the private protocol boundary.
 * @param value Parsed JSON or original Root operation-policy input.
 * @returns Immutable normalized mode; omission is handled by the caller's explicit legacy policy.
 * @throws LocalRefusal for extra fields, omitted mode or unsupported permission values.
 */
export function filePolicy(value: unknown): NativeFilePolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'mode')) throw new LocalRefusal('invalid_file_policy')
  const mode: unknown = Reflect.get(value, 'mode')
  if (mode !== 'read-only' && mode !== 'workspace-write') throw new LocalRefusal('invalid_file_policy')
  return Object.freeze({ mode })
}
