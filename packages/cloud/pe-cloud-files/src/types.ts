/** File-owned budget inputs; account binding and drain types belong to runtime. */
import type FileSystem from '@deepseek-ai/dsh-fs'

/** Deployment-supplied finite limits; no production capacity defaults are inferred. */
export interface FilesLimits {
  readonly maxLanes: number
  readonly maxRunning: number
  readonly maxRunningPerLane: number
  readonly maxQueued: number
  readonly maxQueuedPerLane: number
  readonly maxResidentBytes: number
  readonly maxResidentBytesPerLane: number
  readonly waitTimeoutMs: number
}

/** The original native provider is required; this increment supplies no substitute protocol. */
export interface NativeFilesRequirement {
  readonly native: FileSystem
}
