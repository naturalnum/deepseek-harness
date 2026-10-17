type InstructionConfigurationCode = 'cloud/invalid-config'

/** Invalid budgets or missing owner adapters prevent instruction activation. */
export class InstructionConfigurationError extends Error {
  /** Stable configuration failure for the receiving protocol adapter. */
  readonly code: InstructionConfigurationCode = 'cloud/invalid-config'

  /** @param message - actionable diagnosis without instruction text or private paths. */
  constructor(message: string) {
    super(message)
    this.name = 'InstructionConfigurationError'
  }
}
