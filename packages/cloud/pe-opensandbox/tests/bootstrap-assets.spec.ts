import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNTIME_ASSET_MANIFEST, SOURCE_DIGEST, SOURCES } from '../src/bootstrap/asset-manifest.ts'
import { loadPackagedBootstrapPayload } from '../src/bootstrap/assets.ts'
import { loadBootstrapPayload } from '../src/bootstrap/bootstrap.ts'
import { AGENT_SOURCE_SHA256 } from '../src/agent-data/constants.ts'
import { digest } from '../src/agent-data/canonical.ts'

const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))

describe('fixed packaged bootstrap assets', () => {
  it('retains exactly the approved eleven Python files and loads their original pinned bytes', async () => {
    const files = (await Promise.all(['agent', 'bootstrap'].map(async directory =>
      (await readdir(join(runtime, directory))).map(name => `${directory}/${name}`)))).flat().sort()
    expect(files).toEqual(RUNTIME_ASSET_MANIFEST.map(item => item.path).sort())
    expect(files).toHaveLength(11)
    for (const item of RUNTIME_ASSET_MANIFEST) {
      const data = await readFile(join(runtime, item.path))
      expect(data.length).toBe(item.bytes)
      expect(createHash('sha256').update(data).digest('hex')).toBe(item.sha256)
    }
    const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
    expect(payload.uploads).toHaveLength(9)
    expect(payload.uploads.map(item => item.name).sort()).toEqual(['guardian.py', 'launcher.py', 'manager.py', 'paths.py',
      'publisher.py', 'server.py', 'stream.py', 'terminal.py', 'wire.py'])
  })

  it('refuses source-module asset discovery instead of looking up a source-tree fallback', async () => {
    await expect(loadPackagedBootstrapPayload()).rejects.toMatchObject({ code: 'binding' })
  })

  it('binds the loader checks to the publisher bytes that the same payload uploads', async () => {
    const payload = await loadBootstrapPayload(join(runtime, 'bootstrap'), join(runtime, 'agent'))
    const publisher = payload.uploads.find(file => file.name === 'publisher.py')
    expect(publisher).toBeDefined()
    if (publisher === undefined) throw new Error('The fixed publisher upload is missing.')
    const bytes = publisher.data.byteLength
    const sha256 = createHash('sha256').update(publisher.data).digest('hex')
    expect(payload.loader).toContain(`s.st_size!=${bytes}`)
    expect(payload.loader).toContain(`os.read(f,${bytes}+1)`)
    expect(payload.loader).toContain(`len(b)!=${bytes}`)
    expect(payload.loader).toContain(`hashlib.sha256(b).hexdigest()!='${sha256}'`)
  })

  it('binds the publisher, installation fixture and handshake digest to the same agent bytes', async () => {
    const hashes: Record<string, string> = {}
    const publisher = await readFile(join(runtime, 'bootstrap/publisher.py'), 'utf8')
    for (const [name, [expected, size]] of Object.entries(SOURCES)) {
      const data = await readFile(join(runtime, 'agent', name))
      hashes[name] = createHash('sha256').update(data).digest('hex')
      expect(data.byteLength).toBe(size)
      expect(hashes[name]).toBe(expected)
      expect(publisher).toContain(`'${name}': ('${expected}', ${size})`)
    }
    const fixture = JSON.parse(await readFile(new URL('./fixtures/agent-data/install-profile-source-pins.json', import.meta.url), 'utf8')) as {
      sources: Record<string, string>
      agentSourceSha256: string
    }
    expect(fixture.sources).toEqual(hashes)
    expect(digest(hashes)).toBe(SOURCE_DIGEST)
    expect(AGENT_SOURCE_SHA256).toBe(SOURCE_DIGEST)
    expect(fixture.agentSourceSha256).toBe(SOURCE_DIGEST)
  })
})
