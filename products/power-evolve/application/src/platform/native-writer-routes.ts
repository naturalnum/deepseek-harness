/** Internal writer routes carry operation authority on acquisition and independent writer authority on maintenance. */
import { PlatformError } from '../contracts.ts'
import { nativeWriterIdentity, type NativeWriterLease, type NativeWriterReleased } from '../native-writer-contracts.ts'
import type { NativeSessionWriter } from './native-session-writer.ts'

const maintenance = nativeWriterIdentity.omit({ token: true }).strict()

/** Dispatch bounded runtime JSON; exact ownership and PG clock checks belong to the production Writer service.
 * @param writer Configured Platform provider using the current database.
 * @param path Product-owned internal writer endpoint.
 * @param token Operation bearer for acquire; independent writer bearer for renew and release.
 * @param input Bounded JSON; maintenance bodies carry no second token or owner field.
 * @returns Committed tokenless receipt; the caller already retains its original writer token.
 */
export async function routeNativeWriter(writer: NativeSessionWriter, path: string, token: string,
  input: unknown): Promise<NativeWriterLease | NativeWriterReleased> {
  switch (path) {
    case '/runtime/native-writer/acquire': return writer.acquire(token, input)
    case '/runtime/native-writer/renew': return writer.renew({ ...maintenance.parse(input), token })
    case '/runtime/native-writer/release': return writer.release({ ...maintenance.parse(input), token })
    default: throw new PlatformError(404, 'not_found')
  }
}
