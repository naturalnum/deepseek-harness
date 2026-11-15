import { expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { redactCloudConfig } from '../src/config-redaction.ts'

it('redacts tuple positions using the same native secret sidecar as array items', () => {
  const schema = z.tuple([z.string(), z.string().role('secret')])
  const value = ['public', 'private']
  expect(redactCloudConfig(schema, value)).toEqual({ value: ['public', undefined], secrets: [{ path: ['1'], set: true }] })
  expect(value).toEqual(['public', 'private'])
})

it('keeps secret dictionary keys out of values and presence-marker paths', () => {
  const schema = z.dict(z.string(), z.union([z.string().role('secret'), z.string()]))
  const redacted = redactCloudConfig(schema, { privateKey: 'public' })
  expect(redacted).toEqual({ value: undefined, secrets: [{ path: [], set: true }] })
  expect(JSON.stringify(redacted)).not.toContain('privateKey')
})

it('projects nested Cloud containers through original native object and array traversal', () => {
  const schema = z.object({ rows: z.array(z.tuple([z.string(), z.string().role('secret')])),
    dictionary: z.dict(z.string(), z.string().role('secret')), token: z.string().role('secret') })
  const input = Object.freeze({ rows: [['public', 'tuple-secret']], dictionary: { privateKey: 'public' }, token: 'native-secret' })
  expect(redactCloudConfig(schema, input)).toEqual({ value: { rows: [['public', undefined]] }, secrets: [
    { path: ['rows', '0', '1'], set: true }, { path: ['dictionary'], set: true }, { path: ['token'], set: true },
  ] })
  expect(input.rows[0]).toEqual(['public', 'tuple-secret'])
  expect(redactSecrets(schema, input).secrets).toEqual([{ path: ['token'], set: true }])
})

it('cannot bypass native secret-role removal and leaves ordinary malformed containers unchanged', () => {
  const schema = z.object({ protected: z.tuple([z.string()]).role('secret'), tuple: z.tuple([z.string()]),
    dictionary: z.dict(z.string(), z.string().role('secret')) })
  expect(redactCloudConfig(schema, { protected: ['private'], tuple: 'malformed', dictionary: null }))
    .toEqual({ value: { tuple: 'malformed', dictionary: null }, secrets: [{ path: ['protected'], set: true }] })
})
