import {
  createSnapshotStore, type ClientPersistence, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'

/**
 * Create the browser-wide default for expanded JSON strings.
 * @param persistence - captured page port; omitted uses ordinary browser storage.
 * @returns A persisted preference sampled only when a string is expanded.
 */
export function createTrajectoryStringWrappingStore(persistence?: ClientPersistence): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'dsh.trajectory.jsonStringWrapping', storage: persistence },
  })
}
