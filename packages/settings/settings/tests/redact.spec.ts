import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '../src/index.ts'

const Profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

const Adapter: z<object> = z.object({
  apiKey: z.string().role('secret'),
  providers: z.dict(Profile),
  fallbacks: z.array(Profile),
  nested: z.object({
    token: z.string().role('secret'),
  }),
})

describe('redactSecrets', () => {
  it('strips secrets from object, dict, and array containers and records each position', () => {
    const { value, secrets } = redactSecrets(Adapter, {
      apiKey: 'top-secret',
      providers: {
        openai: { apiKey: 'sk-live', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ apiKey: 'fb', baseURL: 'https://y' }],
      nested: {},
    })
    expect(value).toEqual({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ baseURL: 'https://y' }],
      nested: {},
    })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['providers', 'openai', 'apiKey'], set: true },
      { path: ['providers', 'anthropic', 'apiKey'], set: false },
      { path: ['fallbacks', '0', 'apiKey'], set: true },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('enumerates unset object-property slots without inventing containers', () => {
    const { value, secrets } = redactSecrets(Adapter, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('never mutates the input and preserves keys outside the schema', () => {
    const input = Object.freeze({
      apiKey: 'frozen',
      extra: Object.freeze({ keep: true }),
    })
    const { value } = redactSecrets(Adapter, input)
    expect(input.apiKey).toBe('frozen')
    expect(value).toEqual({ extra: { keep: true }, nested: undefined } as never)
    expect((value as { extra: unknown }).extra).toEqual({ keep: true })
  })

  it('passes malformed container values through untouched', () => {
    const { value, secrets } = redactSecrets(Adapter, {
      providers: 'not-a-dict',
      fallbacks: 'not-an-array',
    })
    expect(value).toEqual({ providers: 'not-a-dict', fallbacks: 'not-an-array' })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('treats a secret-role container as one opaque secret leaf', () => {
    const Weird = z.object({ blob: z.object({ inner: z.string() }).role('secret') })
    const { value, secrets } = redactSecrets(Weird, { blob: { inner: 'x' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['blob'], set: true }])
  })

  it('drops a dict entry whose entire value is the secret', () => {
    const Tokens = z.object({ tokens: z.dict(z.string().role('secret')) })
    const { value, secrets } = redactSecrets(Tokens, { tokens: { a: 'x', b: 'y' } })
    expect(value).toEqual({ tokens: {} })
    expect(secrets).toEqual([
      { path: ['tokens', 'a'], set: true },
      { path: ['tokens', 'b'], set: true },
    ])
  })

  it('tolerates structural nodes missing their relation maps', () => {
    expect(redactSecrets({ type: 'dict' }, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'object' }, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'array' }, ['v'])).toEqual({ value: ['v'], secrets: [] })
  })
  it('removes secrets declared by any union branch, intersection, or transform', () => {
    const schema = z.object({
      union: z.union([z.object({ token: z.string().role('secret') }), z.object({ token: z.string() })]),
      intersection: z.intersect([z.object({ token: z.string().role('secret') }), z.object({ name: z.string() })]),
      transformed: z.transform(z.object({ token: z.string().role('secret') }), value => value),
    })
    const { value, secrets } = redactSecrets(schema, {
      union: { token: 'union-secret' }, intersection: { token: 'intersection-secret', name: 'visible' },
      transformed: { token: 'transformed-secret' },
    })
    expect(value).toEqual({ union: {}, intersection: { name: 'visible' }, transformed: {} })
    expect(secrets).toEqual(['union', 'intersection', 'transformed'].map(key => ({ path: [key, 'token'], set: true })))
  })

})

it('preserves values when an unspecified union declares no secret alternatives', () => {
  expect(redactSecrets(new z({ type: 'union' }), 'visible')).toEqual({ value: 'visible', secrets: [] })
})

it('redacts tuple positions using the same native secret sidecar as array items', () => {
  const schema = z.tuple([z.string(), z.string().role('secret')])
  const value = ['public', 'private']
  expect(redactSecrets(schema, value)).toEqual({ value: ['public', undefined], secrets: [{ path: ['1'], set: true }] })
  expect(value).toEqual(['public', 'private'])
})

it('keeps secret dictionary keys out of values and presence-marker paths', () => {
  const schema = z.dict(z.string(), z.union([z.string().role('secret'), z.string()]))
  const redacted = redactSecrets(schema, { privateKey: 'public' })
  expect(redacted).toEqual({ value: undefined, secrets: [{ path: [], set: true }] })
  expect(JSON.stringify(redacted)).not.toContain('privateKey')
})
