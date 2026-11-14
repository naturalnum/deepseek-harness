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

/** A definite skill-project capacity refusal; no unconfirmed record publication is released. */
export class SkillProjectCapacityFailure extends FilesFailure {
  constructor(readonly resource: 'associations' | 'parent-borrows' | 'metadata', message: string) {
    super('cloud/capacity', message)
    this.name = 'SkillProjectCapacityFailure'
  }
}
