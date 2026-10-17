/** Same-package classification for SQL that the driver adapter never submitted. */
import { AccountRuntimeError } from './errors.ts'

/** Only a trusted adapter may establish absence of an owner write; server/transport failures cannot. */
export class OwnerPgNotSubmittedError extends AccountRuntimeError {
  /**
   * @param code Capacity or unavailable admission failure.
   * @param message Safe diagnostic without SQL, parameters, or connection secrets.
   * @param options Optional private cause.
   */
  constructor(code: 'cloud/capacity' | 'cloud/account-unavailable', message: string, options?: ErrorOptions) {
    super(code, message, options)
    this.name = 'OwnerPgNotSubmittedError'
  }
}
