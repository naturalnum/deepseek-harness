import { afterEach, describe, expect, it } from 'vitest'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion, type FsDirEntry, type FsTarget } from '@deepseek-ai/dsh-fs'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import {
  FileSystemSkillProvider,
  type Config,
  type FileSystemSkillReader,
  type FileSystemSkillSource,
} from '../src/index.ts'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; reader: FileSystemSkillReader }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-source-'))
  roots.push(root)
  await mkdir(join(root, 'sample'))
  await writeFile(join(root, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Borrowed source skill\n---\nRead resource.bin.\n')
  await writeFile(join(root, 'sample', 'resource.bin'), 'same-version-resource')
  // The provider cannot read these virtual paths through Node's host fallback.
  const paths = new Map([
    ['/snapshot', root],
    ['/snapshot/sample', join(root, 'sample')],
    ['/snapshot/sample/SKILL.md', join(root, 'sample', 'SKILL.md')],
  ])
  const local = (target: FsTarget): string => {
    const path = paths.get(target.displayPath)
    if (path === undefined) throw new FsError('Unknown fixture target', 'FS_NOT_FOUND')
    return path
  }
  const target = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })
  const reader: FileSystemSkillReader = {
    resolve: async path => target(path),
    processPath: value => value.displayPath,
    stat: async (value) => {
      const info = await stat(local(value))
      return { version: FsVersion(String(info.mtimeMs)), type: info.isDirectory() ? 'directory' : 'file', size: info.size }
    },
    listDir: async (value) => {
      expect(value.displayPath).toBe('/snapshot')
      const entries: FsDirEntry[] = [{ name: 'sample', type: 'directory', target: target('/snapshot/sample'), version: FsVersion('fixture') }]
      return entries
    },
    readText: async (value, signal) => readFile(local(value), { encoding: 'utf8', ...signal === undefined ? {} : { signal } }),
  }
  return { root, reader }
}

async function setup(source: FileSystemSkillSource): Promise<Context> {
  const ctx = new Context()
  const registry = ctx.plugin(SkillRegistry)
  cleanups.push(async () => { await registry.dispose() })
  await registry
  let provider!: FileSystemSkillProvider
  const unregister = ctx.skills.registerProvider((control) => {
    provider = new FileSystemSkillProvider(ctx, control, {
      includeDefaultRoots: false, watch: false, customSkillDirs: ['/snapshot'],
    }, source)
    return provider
  })
  cleanups.push(async () => { unregister(); await provider.dispose() })
  return ctx
}

describe('programmatic skill source', () => {
  it('keeps discovery source paths private and waits for complete resources before returning a loaded skill', async () => {
    const { root, reader } = await fixture()
    const preparationStarted = Promise.withResolvers<undefined>()
    const allowPreparation = Promise.withResolvers<undefined>()
    const scope = {}
    let borrowed = 0
    const ctx = await setup({
      async withFiles(read, options) {
        expect(options.scope).toBe(scope)
        borrowed += 1
        try {
          return await read({ files: reader, async materialize(directory, received) {
            expect(directory).toBe('/snapshot/sample')
            expect(received).toBe(options)
            preparationStarted.resolve(undefined)
            await allowPreparation.promise
            const projectCopy = join(root, 'project-copy')
            await mkdir(projectCopy)
            await copyFile(join(root, 'sample', 'resource.bin'), join(projectCopy, 'resource.bin'))
            return { resourceBase: { kind: 'directory', path: projectCopy } }
          } })
        } finally { borrowed -= 1 }
      },
    })
    const summaries = await ctx.skills.list({ scope })
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).not.toHaveProperty('path')
    expect(summaries[0]).not.toHaveProperty('resourceBase')
    let returned = false
    const loading = ctx.skills.get('sample', { scope }).then((value) => { returned = true; return value })
    await preparationStarted.promise
    expect(returned).toBe(false)
    expect(borrowed).toBe(1)
    allowPreparation.resolve(undefined)
    const skill = await loading
    expect(skill).toMatchObject({ name: 'sample', content: 'Read resource.bin.', resourceBase: { kind: 'directory', path: join(root, 'project-copy') } })
    expect(await readFile(join(root, 'project-copy', 'resource.bin'), 'utf8')).toBe('same-version-resource')
    expect(borrowed).toBe(0)
  })

  it('retains the source borrow after caller cancellation until actual preparation ends, without returning partial guidance', async () => {
    const { reader } = await fixture()
    const started = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    let borrowed = 0
    let materializing = false
    const ctx = await setup({
      async withFiles(read) {
        borrowed += 1
        try {
          return await read({ files: reader, async materialize() {
            materializing = true
            started.resolve(undefined)
            await finish.promise
            throw new Error('Resources unavailable')
          } })
        } finally {
          borrowed -= 1
          if (materializing) settled.resolve(undefined)
        }
      },
    })
    await ctx.skills.list()
    const abort = new AbortController()
    const loading = ctx.skills.get('sample', { signal: abort.signal })
    await started.promise
    abort.abort(new Error('Caller left'))
    await expect(loading).rejects.toThrow('Caller left')
    expect(borrowed).toBe(1)
    finish.resolve(undefined)
    await settled.promise
    expect(borrowed).toBe(0)
  })

  it.each<Config>([{}, { includeDefaultRoots: false }, { includeDefaultRoots: false, watch: false, bundledSkillDir: '/host' }])(
    'rejects implicit host roots, host watching and bundled bypass for an explicit source: %j',
    (config) => {
      const ctx = new Context()
      const source: FileSystemSkillSource = { async withFiles() { throw new Error('Must not read') } }
      expect(() => new FileSystemSkillProvider(ctx, { signal: new AbortController().signal, invalidate() {} }, config, source)).toThrow('explicit source requires isolated roots')
    },
  )
})
