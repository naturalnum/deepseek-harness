/** Explicit owner authority consumed by the common gVisor process and filesystem provider. */
import type { NativeExecutionProcessWorld } from '../native-execution/types.ts'
import type { StorageBinding } from './cloud-storage-types.ts'
import type { NativeExecutionProcessIdentity } from './native-execution-authority-store.ts'

/** Each owner validates its own durable lease; physical execution never infers an alternate authority. */
export interface NativeProcessAuthority<World extends NativeExecutionProcessWorld> {
  /** Check dispatch or initialization storage authority against the original owner and generations.
   * @param token Original bounded owner bearer.
   * @param world Captured immutable owner and storage address.
   * @param purpose Initialization reads never grant process execution or mutation.
   * @returns Current exact server-selected storage binding.
   */
  assert(token: string, world: World, purpose?: 'execution' | 'storage-read'): Promise<StorageBinding>
  /** Check only the original already-admitted process lifetime and collected output.
   * @param token Original bounded owner bearer.
   * @param world Original immutable owner and storage address.
   * @param process Server-retained process, name, UID and namespace.
   * @returns Current exact storage binding while the owner lease remains valid.
   */
  assertProcess(token: string, world: World, process: NativeExecutionProcessIdentity): Promise<StorageBinding>
  /** Authenticate original ownership for exact cleanup after revocation; never grant dispatch or output.
   * @param token Original owner bearer.
   * @param world Original immutable owner address.
   */
  assertOwnership(token: string, world: World): Promise<void>
  /** Serialize one native guarded mutation by its physical path without serializing users or projects.
   * @param token Original owner bearer.
   * @param world Original immutable owner address.
   * @param path Canonical execution-world path.
   * @param apply Original single non-replayed mutation.
   * @returns The native filesystem result after joined cleanup.
   */
  mutate<T>(token: string, world: World, path: string, apply: () => Promise<T>): Promise<T>
}
