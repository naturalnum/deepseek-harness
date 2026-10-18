/** Native Client Gateway encoding paired with the Host Controller's golden list arguments. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import * as NativeClientGateway from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'

it('encodes native Client list arguments using the Host-verified Session parameter name', async () => {
  const wire = z.object({ parameter: z.string().min(1), args: z.record(z.string(), z.object({}).strict()) }).strict()
    .parse(JSON.parse(readFileSync(new URL('./native-list-wire.json', import.meta.url), 'utf8')))
  const client = new Context()
  onTestFinished(async () => { await client.fiber.dispose() })
  await client.plugin(TypertRegistry)
  const call = vi.fn(async (
    _channel: string, _endpoint: string, _payload: unknown, _signal?: AbortSignal,
  ): Promise<{ readonly ok: true; readonly value: SessionListValue }> => ({ ok: true, value: { items: [] } }))
  const connection: ConnectionHandle = {
    interactions: 'none', isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, start: () => ({ stop: () => {} }),
    openWebSocket: () => { throw new Error('List must not open a socket') },
    registerGenerationSource: () => () => {},
    rpc: { call, open: async function* () { throw new Error('List must not open a stream') } },
  }
  client.provide('connection', connection)
  await client.plugin(NativeClientGateway)
  const contribution: TypertRemoteContribution = {
    package: '@deepseek-ai/dsh-api-session-controller', descriptors: [{
      id: 'native-session-list', service: 'sessionController', namespace: 'session', method: 'list',
      invocation: { kind: 'direct' }, parameters: [{ name: wire.parameter, wire: wire.parameter, source: 'json',
        codec: { mode: 'strict', typeSymbol: 'native-list-test#SessionListRequest', create: () => ({ parse: value => value }) } }],
      cancellation: { parameter: 'signal' }, result: { mode: 'src-json' },
    }],
  }
  await client.remote.$mount(contribution)
  await expect(client.remote.session.list({})).resolves.toEqual({ ok: true, value: { items: [] } })
  expect(call).toHaveBeenCalledExactlyOnceWith('/api', 'session/list', { args: wire.args }, expect.any(AbortSignal))
})
