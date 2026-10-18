import {
  createSnapshotStore, type ClientPersistence, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'

/**
 * Create the browser-wide trajectory duration preference source.
 * @param persistence - captured page port; omitted uses ordinary browser storage.
 * @returns a persisted source shared by every session view in one plugin lifecycle.
 */
export function createTrajectoryDurationStore(persistence?: ClientPersistence): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'dsh.trajectory.duration', storage: persistence },
  })
}
