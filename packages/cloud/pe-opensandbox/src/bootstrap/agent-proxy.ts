/** Original fixed-server proxy over the same bounded HTTP/WebSocket transport and cleanup owner. */
import type { Dispatcher } from 'undici'
import { UndiciOwnedTransport } from '../agent-data/transport.ts'

/** Root supplies the original selected endpoint and protected proxy headers; operations cannot select another target. */
export class RootAgentProxyTransport extends UndiciOwnedTransport {
  /** @param endpoint Original sandbox port proxy URL. @param headers Protected selected-server headers.
   * @param dispatcher Exclusively owned component-test replacement; production creates its own Pool.
   */
  constructor(endpoint: URL, headers: Record<string, string>, dispatcher?: Dispatcher) {
    super(endpoint.origin, { prefix: endpoint.pathname, headers: { ...headers, 'OpenSandbox-Access-Renew': 'skip' } }, dispatcher)
  }
}
