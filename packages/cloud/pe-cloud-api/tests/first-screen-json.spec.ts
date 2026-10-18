/** Complete-byte and pre-encoding work limits for actual native first-screen DTOs. */
import { expect, it } from 'vitest'
import { firstScreenJsonBytes } from '../src/first-screen-json.ts'

it('measures the exact complete UTF-8 frame including escaping and legitimate shared native values', () => {
  const shared = { preference: '中"\\\n' }
  const frame = { type: 'emit', event: 'settings/document-updated', args: [shared, shared], omitted: undefined }
  const bytes = Buffer.byteLength(JSON.stringify(frame))
  expect(firstScreenJsonBytes(frame, bytes)).toBe(bytes)
  expect(() => firstScreenJsonBytes(frame, bytes - 1)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(firstScreenJsonBytes({ omitted: undefined }, 2)).toBe(2)
})

it('rejects large strings and structural input before invoking any complete serializer', () => {
  const large = { content: 'x'.repeat(1024), toJSON() { throw new Error('Caller serializer must never execute') } }
  expect(() => firstScreenJsonBytes(large, 16)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  expect(() => firstScreenJsonBytes(Array.from({ length: 1024 }), 16)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
  const cycle: { child?: object } = {}
  cycle.child = cycle
  expect(() => firstScreenJsonBytes(cycle, 128)).toThrow(expect.objectContaining({ code: 'cloud/account-unavailable' }))
})
