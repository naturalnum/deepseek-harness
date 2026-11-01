/** Original settings schemas select only explicitly approved ordinary fields. */
import z from '@deepseek-ai/schemastery'
import { expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { projectApprovedSettingsNamespace } from '../src/approved-settings.ts'
import { pluginLiteralValue } from '../src/plugin-json.ts'

function view(schema: { toJSON(): unknown }, value: JsonValue) {
  return { ns: 'provider', schema: pluginLiteralValue(JSON.parse(JSON.stringify(schema.toJSON()))), value, user: value,
    autoGenerate: true, applies: 'live' as const, secrets: [], revision: 3 }
}

it('projects a bounded approved model list without exposing another field', () => {
  const schema = z.object({ models: z.array(z.object({ id: z.string().required(), name: z.string() })).volatile(),
    other: z.string() })
  const actual = projectApprovedSettingsNamespace(view(schema, { models: [{ id: 'sample', name: 'Example' }], other: 'private' }),
    [{ namespace: 'provider', field: 'models' }], 64)
  expect(actual.value).toEqual({ models: [{ id: 'sample', name: 'Example' }] })
  expect(JSON.stringify(actual.schema)).not.toContain('other')
})

it.each(['secret', 'credential-ref'])('refuses nested %s in an approved field', (role) => {
  const schema = z.object({ models: z.array(z.object({ id: z.string(), key: z.string().role(role) })) })
  expect(() => projectApprovedSettingsNamespace(view(schema, { models: [{ id: 'a', key: 'private' }] }),
    [{ namespace: 'provider', field: 'models' }], 64)).toThrow()
})

it('retains finite scalar choices and rejects a structured schema with scalar choices', () => {
  const schema = z.object({ models: z.array(z.object({ id: z.string() })) })
  expect(() => projectApprovedSettingsNamespace(view(schema, { models: [{ id: 'a' }] }),
    [{ namespace: 'provider', field: 'models', values: ['a'] }], 64)).toThrow()
})
