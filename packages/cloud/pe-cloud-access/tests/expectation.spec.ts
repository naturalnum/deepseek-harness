import type { Branded } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import { readRequestExpectation } from '../src/expectation.ts'
import { accessConfig, carrier } from './ingress-fixture.ts'

const id = 'request-expectation-test' as Branded<'pe-request-id'>

describe('original binding carrier selection', () => {
  it('retains repeated raw header occurrences even when Node merged headers contain one final value', () => {
    const { request, response, socket } = carrier('/api/session/list', 'POST', [
      'X-Pe-Account', 'account-a', 'x-pe-account', 'account-a', 'X-Pe-Generation', 'generation-a',
    ])
    try {
      expect(request.headers['x-pe-account']).toBe('account-a')
      expect(() => readRequestExpectation(request, new URL(request.url ?? '/', accessConfig().publicOrigin),
        accessConfig().bindingFields, 'headers', id)).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
    } finally { request.destroy(); response.destroy(); socket.destroy() }
  })

  it('does not replace a missing header carrier with query expectations', () => {
    const { request, response, socket } = carrier('/api/session/list?peAccount=a&peGeneration=g', 'POST')
    try {
      const url = new URL(request.url ?? '/', accessConfig().publicOrigin)
      expect(() => readRequestExpectation(request, url, accessConfig().bindingFields, 'headers', id)).toThrow()
      expect(readRequestExpectation(request, url, accessConfig().bindingFields, 'query', id))
        .toEqual({ accountId: 'a', connectionGeneration: 'g' })
    } finally { request.destroy(); response.destroy(); socket.destroy() }
  })

  it.each(['peAccount=a&peAccount=a&peGeneration=g', 'peAccount=a&peGeneration=g&peGeneration=g', 'peAccount=%20a&peGeneration=g'])(
    'rejects query duplicates or padded values from %s', (query) => {
      const { request, response, socket } = carrier('/api/remote.mux?' + query)
      try {
        expect(() => readRequestExpectation(request, new URL(request.url ?? '/', accessConfig().publicOrigin),
          accessConfig().bindingFields, 'query', id)).toThrow()
      } finally { request.destroy(); response.destroy(); socket.destroy() }
    },
  )
})
