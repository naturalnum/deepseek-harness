/** The browser follows only the Host-declared fixed, credential-free approval URL. */
import { afterEach, expect, test, vi } from 'vitest'
import { approvalUrl } from '../src/client/approval-api.ts'

test.each(['https://platform.test/approval', 'http://127.0.0.1:19881/approval',
  'http://localhost:19881/approval', 'http://[::1]:19881/approval'])('returns permitted approval destination %s', async (destination) => {
  const request = vi.fn<typeof fetch>(async () => Response.json({ approvalUrl: destination }))
  expect(await approvalUrl(request)).toBe(destination)
  expect(request).toHaveBeenCalledExactlyOnceWith('/config', { credentials: 'same-origin' })
})

test.each(['http://platform.test/approval', 'https://user:secret@platform.test/approval',
  'https://platform.test/approval?token=private', 'https://platform.test/approval#fragment',
  'https://platform.test/approval/', 'https://platform.test/other', 'ftp://platform.test/approval',
  'not a URL'])('refuses approval destination %s', async (destination) => {
  await expect(approvalUrl(async () => Response.json({ approvalUrl: destination }))).rejects.toThrow()
})

test.each([null, {}, { approvalUrl: 12 }])('refuses malformed approval configuration', async (value) => {
  await expect(approvalUrl(async () => Response.json(value))).rejects.toThrow('Invalid approval URL')
})

test('refuses unavailable configuration before accepting a destination', async () => {
  await expect(approvalUrl(async () => new Response('', { status: 503 }))).rejects.toThrow('503')
})

afterEach(() => { vi.unstubAllGlobals() })
test('uses the current global browser transport and refuses noncanonical explicit ports', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ approvalUrl: 'https://platform.test/approval' }))
  expect(await approvalUrl()).toBe('https://platform.test/approval')
  await expect(approvalUrl(async () => Response.json({ approvalUrl: 'https://platform.test:443/approval' }))).rejects.toThrow('Invalid approval URL')
})
