import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNTIME_ASSET_MANIFEST } from '../src/bootstrap/asset-manifest.ts'
import { loadPackagedBootstrapPayload } from '../src/bootstrap/assets.ts'
import { loadBootstrapPayload } from '../src/bootstrap/bootstrap.ts'

const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))

describe('fixed packaged bootstrap assets', () => {
  it('retains exactly the approved nine Python files and loads their original pinned bytes', async () => {
    const files = (await Promise.all(['agent', 'bootstrap'].map(async directory =>
      (await readdir(join(runtime, directory))).map(name => `${directory}/${name}`)))).flat().sort()
    expect(files).toEqual(RUNTIME_ASSET_MANIFEST.map(item => item.path).sort())
    expect(files).toHaveLength(9)
    for (const item of RUNTIME_ASSET_MANIFEST) {
      const data = await readFile(join(runtime, item.path))
      expect(data.length).toBe(item.bytes)
      expect(createHash('sha256').update(data).digest('hex')).toBe(item.sha256)
    }
    const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
    expect(payload.uploads).toHaveLength(7)
    expect(payload.uploads.map(item => item.name)).toEqual(['server.py', 'wire.py', 'manager.py', 'launcher.py',
      'guardian.py', 'paths.py', 'publisher.py'])
  })

  it('refuses source-module asset discovery instead of looking up a source-tree fallback', async () => {
    await expect(loadPackagedBootstrapPayload()).rejects.toMatchObject({ code: 'binding' })
  })
})
