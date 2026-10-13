/** An owned HTTP listener verifies trusted asset admission, bytes, MIME and browser isolation headers. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { serveTrustedAccountUi } from '../src/trusted-account-ui.ts'
import { sendFailure } from '../src/http.ts'

async function assets<T>(run: (fixture: { directory: string; origin: string }) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'pe-account-assets-'))
  const server = createServer((request, response) => {
    void serveTrustedAccountUi(request.url ?? '/', response, directory).then((served) => {
      if (!served) { response.writeHead(404); response.end() }
    }).catch((error: unknown) => { sendFailure(response, error) })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected owned HTTP listener')
    return await run({ directory, origin: `http://127.0.0.1:${address.port}` })
  } finally {
    server.close()
    await once(server, 'close')
    await rm(directory, { recursive: true, force: true })
  }
}

test('listed account assets retain their exact bytes and receive the appropriate MIME and restrictive headers', () =>
  assets(async ({ directory, origin }) => {
    const files = [
      ['index.html', 'text/html'], ['script.js', 'text/javascript'], ['style.css', 'text/css'],
      ['icon.svg', 'image/svg+xml'], ['icon.png', 'image/png'], ['font.woff', 'font/woff'], ['font.woff2', 'font/woff2'],
    ] as const
    await writeFile(join(directory, 'asset-list.json'), JSON.stringify(files.map(([name]) => name)))
    for (const [name, mime] of files) {
      const bytes = Buffer.from(`owned carrier fixture for ${name}`)
      await writeFile(join(directory, name), bytes)
      const response = await fetch(`${origin}/account/${name}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(mime)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'")
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    }
    for (const path of ['/account', '/account/']) {
      const response = await fetch(origin + path)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('owned carrier fixture for index.html')
    }
  }))

test('unlisted assets return 404 without replacing them with the account entry page', () =>
  assets(async ({ directory, origin }) => {
    await writeFile(join(directory, 'asset-list.json'), JSON.stringify(['index.html']))
    await writeFile(join(directory, 'index.html'), 'entry page')
    await writeFile(join(directory, 'private.html'), 'unlisted private bytes')
    for (const path of ['/account/private.html', '/account/missing.js', '/account/%2e%2e%2fprivate.html']) {
      const response = await fetch(origin + path)
      expect(response.status).toBe(404)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe('')
    }
    const unrelated = await fetch(`${origin}/unrelated`)
    expect(unrelated.status).toBe(404)
    expect(await unrelated.text()).toBe('')
  }))

test('invalid manifests and missing listed bytes fail without serving an entry-page fallback', () =>
  assets(async ({ directory, origin }) => {
    await writeFile(join(directory, 'index.html'), 'entry page')
    const manifests: unknown[] = [[], ['index.html', 'index.html'], ['index.html', '../private.html'],
      ['index.html', 'nested//file.js'], ['index.html', '/private.html'], ['index.html', 'file.txt'], { 'index.html': true }]
    for (const manifest of manifests) {
      await writeFile(join(directory, 'asset-list.json'), JSON.stringify(manifest))
      const response = await fetch(`${origin}/account`)
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('entry page')
    }
    await writeFile(join(directory, 'asset-list.json'), JSON.stringify(['index.html', 'missing.js']))
    const missing = await fetch(`${origin}/account/missing.js`)
    expect(missing.status).toBe(503)
    expect(await missing.text()).not.toContain('entry page')
  }))
