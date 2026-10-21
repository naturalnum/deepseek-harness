/** Serializable service policy resolved once before Root attaches its original native service callbacks. */
import type { DevServiceProfile } from './dev-service-consumer.ts'
import type { NativeCommandAccountLimits } from './native-command-account.ts'
import type { HttpTransportLimits } from './application-http.ts'

/** Required fixed service profile, per-stream raw collection and native drain grace; no runtime authority. */
export interface ManagedServiceConfig {
  readonly profile: DevServiceProfile
  readonly maxOutputBytes: number
  readonly graceMs: number
  /** Optional request planning only; absence keeps the application HTTP provider closed. Root supplies actual authority. */
  readonly application?: {
    readonly maxRequests: number
    readonly maxRequestsPerAccount: number
    readonly maxRequestsPerService: number
    readonly transport: HttpTransportLimits
  }
}

/** Parsed native consumers; absent services explicitly keeps the service consumer closed at configuration resolution. */
export interface ManagedNativeCommandConfig extends Omit<NativeCommandAccountLimits, 'services'> {
  readonly services?: ManagedServiceConfig
}
