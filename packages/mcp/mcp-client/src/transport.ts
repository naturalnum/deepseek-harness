/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { FetchLike, Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'
import { boundedHttpIncoming, type HttpIncomingOwner } from './http-incoming.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param observeIncoming - Enroll optional HTTP readers in their original supervisor generation.
 * @param httpFetch - Trusted programmatic HTTP transport.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, observeIncoming?: (owner: HttpIncomingOwner) => void, httpFetch?: FetchLike): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const incoming = config.maxIncomingResponseBytes === undefined
        ? undefined
        : boundedHttpIncoming(config.maxIncomingResponseBytes, httpFetch)
      const fetch = incoming?.fetch ?? httpFetch
      const transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers }, ...fetch === undefined ? {} : { fetch } },
      )
      if (incoming !== undefined) observeIncoming?.(incoming)
      return transport
    }
  }
}
