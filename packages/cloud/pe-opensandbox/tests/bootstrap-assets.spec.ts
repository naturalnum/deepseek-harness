import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNTIME_ASSET_MANIFEST, SOURCE_DIGEST, SOURCES } from '../src/bootstrap/asset-manifest.ts'
import { loadPackagedBootstrapPayload } from '../src/bootstrap/assets.ts'
import { loadBootstrapPayload } from '../src/bootstrap/bootstrap.ts'
import { AGENT_SOURCE_SHA256 } from '../src/agent-data/constants.ts'
import { digest } from '../src/agent-data/canonical.ts'

const runtime = fileURLToPath(new URL('../runtime/', import.meta.url))

describe('fixed packaged bootstrap assets', () => {
  it('refuses changed agent bytes before returning a bootstrap payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pe-runtime-source-guard-'))
    try {
      await cp(join(runtime, 'agent'), join(directory, 'agent'), { recursive: true })
      await cp(join(runtime, 'bootstrap'), join(directory, 'bootstrap'), { recursive: true })
      const launcher = join(directory, 'agent/launcher.py'), bytes = await readFile(launcher)
      bytes[bytes.length - 1] = bytes[bytes.length - 1] === 10 ? 32 : 10
      await writeFile(launcher, bytes)
      await expect(loadBootstrapPayload(join(directory, 'bootstrap'), join(directory, 'agent')))
        .rejects.toMatchObject({ code: 'binding' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

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
