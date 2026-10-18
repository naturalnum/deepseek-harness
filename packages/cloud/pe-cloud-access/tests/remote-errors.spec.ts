/** Shared cloud Remote codes preserve each producer's original safe payload. */
import type {} from '../src/peers.ts'
import { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { CloudApiError } from '@deepseek-ai/dsh-pe-cloud-api'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished } from 'vitest'
import { AuthAccessError } from '../src/auth-error.ts'
import { RequestBindingError } from '../src/binding.ts'

it('keeps auth correlation and retry fields in JSON and native Remote encoding while API details stay empty', async () => {
  const ctx = new Context(), requestId = brandString<Branded<'pe-request-id'>>('safe-request-correlation')
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Typert)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  for (const code of ['cloud/forbidden', 'cloud/account-unavailable', 'cloud/capacity'] as const) {
    const auth = new AuthAccessError(code, requestId), details = auth.toJSON()
    expect(JSON.parse(JSON.stringify(auth))).toEqual({ code, message: auth.message, requestId,
      retry: code === 'cloud/forbidden' ? 'never' : 'after-status-check' })
    expect(ctx.typertGateway.wireStream.failure(new RemoteError(code, auth.message, details)))
      .toEqual({ code, message: auth.message, details })
    expect(ctx.typertGateway.wireStream.failure(new CloudApiError(code, 'Fixed policy denial.')))
      .toEqual({ code, message: 'Fixed policy denial.', details: {} })
  }
  const binding = new RequestBindingError(requestId), details = binding.toJSON()
  expect(JSON.parse(JSON.stringify(binding))).toEqual({ code: 'cloud/stale-generation', message: binding.message,
    requestId, retry: 'after-status-check' })
  expect(ctx.typertGateway.wireStream.failure(new RemoteError('cloud/stale-generation', binding.message, details)))
    .toEqual({ code: 'cloud/stale-generation', message: binding.message, details })
  expect(ctx.typertGateway.wireStream.failure(new CloudApiError('cloud/stale-generation', 'Fixed policy denial.')))
    .toEqual({ code: 'cloud/stale-generation', message: 'Fixed policy denial.', details: {} })
  const exclusive = new AuthAccessError('cloud/unauthenticated', requestId)
  const remote = new RemoteError('cloud/unauthenticated', exclusive.message, exclusive.toJSON())
  expect(remote.details.requestId).toBe(requestId)
  expect(remote.details.retry).toBe('never')
})
