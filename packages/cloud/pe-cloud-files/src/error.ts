/** Typed admission and missing-provider failures owned by cloud files. */
export type FilesFailureCode =
  | 'cloud/capacity'
  | 'cloud/stale-generation'
  | 'files/deadline'
  | 'files/aborted'
  | 'files/prerequisite-missing'

/** A rejected operation has not started; cancellation of running work may remain unsettled. */
export class FilesFailure extends Error {
  constructor(readonly code: FilesFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FilesFailure'
  }
}
