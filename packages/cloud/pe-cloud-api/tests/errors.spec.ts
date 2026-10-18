/** Cloud policy failures retain their existing identity through native Remote error encoding. */
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import Typert from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished } from 'vitest'
import { CloudApiError, type CloudApiErrorCode } from '../src/errors.ts'

const codes: readonly CloudApiErrorCode[] = [
  'cloud/forbidden', 'cloud/invalid-config', 'cloud/account-unavailable', 'cloud/stale-generation',
  'cloud/model-not-allowed', 'cloud/config-busy', 'cloud/capacity',
]

it.each(codes)('keeps Error and CloudApiError compatibility while exposing the native Remote marker for %s', (code) => {
  const error = new CloudApiError(code, 'Fixed account policy diagnostic.')
  expect(error).toBeInstanceOf(Error)
  expect(error).toBeInstanceOf(CloudApiError)
  expect(error).toBeInstanceOf(RemoteError)
  expect(error.name).toBe('CloudApiError')
  expect(error.code).toBe(code)
  expect(error.message).toBe('Fixed account policy diagnostic.')
  expect(error.details).toEqual({})
  expect(remoteErrorOf(error)).toBe(error)
})

it('encodes all seven cloud denials through the actual Gateway while retaining unknown errors as internal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Typert)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway)
  for (const code of codes) {
    const error = new CloudApiError(code, 'Fixed account policy diagnostic.')
    expect(ctx.typertGateway.wireStream.failure(error)).toEqual({
      code, message: error.message, details: {},
    })
  }
  expect(ctx.typertGateway.wireStream.failure(new Error('Unknown native failure.'))).toEqual({
    code: 'gateway/internal', message: 'Unknown native failure.', details: {},
  })
})
