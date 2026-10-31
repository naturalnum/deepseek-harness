/** Cloud policy rejects protected or incomplete schema metadata without evaluating builders. */
import { expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import type { ConfigSchemaNode } from '@deepseek-ai/dsh-settings'
import { ordinaryConfigPolicy } from '../src/ordinary-config-policy.ts'

it('classifies whole ordinary replacements from schema metadata rather than current container contents', () => {
  const schema = z.object({
    ordinary: z.object({ names: z.array(z.string()), ref: z.string().role('credential-ref') }),
    mixed: z.object({ fixed: z.number(), live: z.number().volatile() }),
    secret: z.object({ value: z.string() }).role('secret'),
    rows: z.array(z.object({ token: z.string().role('secret') })),
    tuple: z.tuple([z.string(), z.string().role('secret')]),
    unresolved: z.lazy(() => { throw new Error('must not run a builder') }),
  })
  expect(ordinaryConfigPolicy(schema, ['ordinary'])).toMatchObject({ writable: true })
  expect(ordinaryConfigPolicy(schema, ['mixed'])).toMatchObject({ writable: false, readOnlyReason: 'protected', volatile: true })
  expect(ordinaryConfigPolicy(schema, ['mixed', 'fixed'])).toMatchObject({ writable: true })
  expect(ordinaryConfigPolicy(schema, ['mixed', 'live'])).toMatchObject({ writable: false, readOnlyReason: 'live' })
  expect(ordinaryConfigPolicy(schema, ['secret', 'value'])).toMatchObject({ writable: false, readOnlyReason: 'secret' })
  for (const key of ['rows', 'tuple']) expect(ordinaryConfigPolicy(schema, [key])).toMatchObject({ writable: false, readOnlyReason: 'protected' })
  expect(ordinaryConfigPolicy(schema, ['unresolved'])).toMatchObject({ writable: false, readOnlyReason: 'unproven' })
})

it('retains refusal for cycles, dictionary keys, union members and absent paths', () => {
  const cycle: ConfigSchemaNode = { type: 'object', dict: {} }
  cycle.dict!.self = cycle
  expect(ordinaryConfigPolicy(cycle, [])).toMatchObject({ writable: false, readOnlyReason: 'unproven' })
  expect(ordinaryConfigPolicy({ type: 'dict', sKey: { type: 'string', meta: { role: 'secret' } }, inner: { type: 'string' } }, []))
    .toMatchObject({ writable: false, readOnlyReason: 'protected' })
  expect(ordinaryConfigPolicy(z.union([z.string(), z.number().volatile()]), []))
    .toMatchObject({ writable: false, readOnlyReason: 'protected', volatile: true })
  expect(ordinaryConfigPolicy(z.intersect([z.object({ a: z.string() }), z.object({ b: z.boolean() })]), []))
    .toMatchObject({ writable: true })
  expect(ordinaryConfigPolicy(z.object({ a: z.string() }), ['absent']))
    .toMatchObject({ writable: false, readOnlyReason: 'unproven' })
})
