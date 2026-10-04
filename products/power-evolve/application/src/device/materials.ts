/** Owner-only local Home and immutable, selected skill packages; this module executes no code. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { deviceMaterialSelection, deviceSkillManifest, deviceSkillMaterial,
  ownedContainerOwner, type DeviceMaterialBinding, type DeviceSkillMaterial, type DeviceSkillManifest,
  type OwnedContainerOwner } from '@power-evolve/contracts/device-execution'

type Code = 'device_material_invalid' | 'device_material_cache_invalid' | 'device_material_path_changed'
  | 'device_material_home_invalid' | 'device_material_cancelled' | 'device_material_io'
  | 'device_material_not_owned' | 'device_material_unavailable'
class MaterialsError extends Error {
  constructor(readonly code: Code) { super(code) }
}
type Identity = Pick<BigIntStats, 'dev' | 'ino'>
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function reject(code: Code): never { throw new MaterialsError(code) }
function owner(stat: BigIntStats, directory: boolean, mode: bigint, code: Code): void {
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
    || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7777n) !== mode) reject(code)
}

/**
 * Prepares one enrollment's persistent Home and only the packages selected by its frozen dispatch.
 * The caller keeps its private kernel lock throughout prepare; assertOwned checks that retained
 * ownership before filesystem work and after external authorization. No private credential or
 * arbitrary storage path can appear in a material response or a returned package mount.
 */
export class DeviceMaterials {
  private readonly root: string
  private readonly identities = new Map<string, Identity>()

  /**
   * @param privateRoot Absolute owner-only Device private root already held by the Worker.
   * @param assertOwned Check the Worker's retained kernel lock and private-root identity.
   */
  constructor(privateRoot: string, private readonly assertOwned: () => Promise<void>) {
    if (!isAbsolute(privateRoot) || privateRoot.includes('\0') || resolve(privateRoot) === parse(privateRoot).root) {
      reject('device_material_path_changed')
    }
    this.root = resolve(privateRoot)
  }

  private async checkpoint(signal: AbortSignal): Promise<void> {
    if (signal.aborted) reject('device_material_cancelled')
    try { await this.assertOwned() } catch { reject('device_material_not_owned') }
    if (signal.aborted) reject('device_material_cancelled')
  }

  private remember(path: string, stat: Identity): void {
    const prior = this.identities.get(path)
    if (prior && !same(prior, stat)) reject('device_material_path_changed')
    this.identities.set(path, { dev: stat.dev, ino: stat.ino })
  }

  private async ancestors(path: string, signal: AbortSignal): Promise<void> {
    await this.checkpoint(signal)
    const suffix = relative(this.root, dirname(path))
    if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) reject('device_material_path_changed')
    let parent = this.root
    for (const part of ['', ...(suffix ? suffix.split('/') : [])]) {
      if (part) parent = join(parent, part)
      const stat = await lstat(parent, { bigint: true })
      const mode = stat.mode & 0o7777n
      if ((parent === this.root && mode !== 0o700n) || ![0o700n, 0o555n].includes(mode)) reject('device_material_path_changed')
      owner(stat, true, mode, 'device_material_path_changed')
      if (stat.isSymbolicLink()) reject('device_material_path_changed')
      this.remember(parent, stat)
    }
  }

  private async directory(path: string, mode: bigint, signal: AbortSignal, create = false): Promise<BigIntStats> {
    await this.checkpoint(signal)
    if (path !== this.root) await this.ancestors(path, signal)
    if (create) {
      try { await mkdir(path, { mode: Number(mode) }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat({ bigint: true })
      owner(stat, true, mode, 'device_material_path_changed')
      const linked = await lstat(path, { bigint: true })
      if (!same(stat, linked) || linked.isSymbolicLink()) reject('device_material_path_changed')
      this.remember(path, stat)
      await file.sync()
      await this.checkpoint(signal)
      if (path !== this.root) await this.ancestors(path, signal)
      const after = await lstat(path, { bigint: true })
      owner(after, true, mode, 'device_material_path_changed')
      if (!same(stat, after)) reject('device_material_path_changed')
      return stat
    } finally { await file.close() }
  }

  private async parents(signal: AbortSignal): Promise<void> {
    let path = parse(this.root).root
    for (const part of this.root.slice(path.length).split('/')) {
      await this.checkpoint(signal)
      path = join(path, part)
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) reject('device_material_path_changed')
    }
    await this.directory(this.root, 0o700n, signal)
  }

  private async verifyFile(path: string, size: number, sha256: string, mode: bigint,
    signal: AbortSignal, code: Code): Promise<void> {
    await this.ancestors(path, signal)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat({ bigint: true })
      owner(stat, false, mode, code)
      if (stat.size !== BigInt(size)) reject(code)
      const linked = await lstat(path, { bigint: true })
      if (!same(stat, linked) || linked.isSymbolicLink()) reject(code)
      let count = 0
      const actual = createHash('sha256')
      for await (const bytes of file.createReadStream({ autoClose: false })) {
        await this.checkpoint(signal)
        count += bytes.length
        if (count > size) reject(code)
        actual.update(bytes)
      }
      if (count !== size || actual.digest('hex') !== sha256) reject(code)
      // Retry a previously visible publication only after syncing its existing bytes and parents.
      await file.sync()
      const after = await lstat(path, { bigint: true })
      const held = await file.stat({ bigint: true })
      owner(after, false, mode, code); owner(held, false, mode, code)
      if (!same(stat, after) || !same(stat, held) || held.size !== BigInt(size)
        || held.mtimeNs !== stat.mtimeNs || held.ctimeNs !== stat.ctimeNs) reject(code)
      await this.ancestors(path, signal)
      this.remember(path, stat)
      await this.checkpoint(signal)
    } finally { await file.close() }
  }

  private async write(path: string, bytes: Uint8Array, mode: number, signal: AbortSignal): Promise<void> {
    await this.ancestors(path, signal)
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const before = await file.stat({ bigint: true })
      owner(before, false, 0o600n, 'device_material_path_changed')
      await file.writeFile(bytes)
      await file.chmod(mode)
      await file.sync()
      const linked = await lstat(path, { bigint: true })
      owner(linked, false, BigInt(mode), 'device_material_path_changed')
      if (!same(before, linked)) reject('device_material_path_changed')
      await this.ancestors(path, signal)
      await this.checkpoint(signal)
    } finally { await file.close() }
  }

  private async home(instanceId: OwnedContainerOwner['enrollmentId'], signal: AbortSignal): Promise<string> {
    const parent = join(this.root, 'execution-homes')
    await this.directory(parent, 0o700n, signal, true)
    const home = join(parent, instanceId), identity = join(parent, `.${instanceId}.identity.json`)
    const stat = await this.directory(home, 0o700n, signal, true)
    const bytes = Buffer.from(JSON.stringify({ version: 1, dev: stat.dev.toString(), ino: stat.ino.toString() }) + '\n')
    let present = true
    try { await lstat(identity) } catch (error) { if (missing(error)) present = false; else throw error }
    if (!present) {
      // A crash before the first identity publication can leave only an unused empty Home.
      if ((await readdir(home)).length !== 0) reject('device_material_home_invalid')
      const temporary = join(parent, `.home-${randomUUID()}`)
      try {
        await this.write(temporary, bytes, 0o600, signal)
        await this.directory(home, 0o700n, signal)
        await this.checkpoint(signal)
        await link(temporary, identity)
        await unlink(temporary)
        await this.directory(parent, 0o700n, signal)
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
    }
    await this.verifyFile(identity, bytes.length, hash(bytes), 0o600n, signal, 'device_material_home_invalid')
    await this.directory(home, 0o700n, signal)
    await this.directory(parent, 0o700n, signal)
    return home
  }

  private material(binding: DeviceMaterialBinding, input: DeviceSkillMaterial):
    { material: DeviceSkillMaterial; manifest: DeviceSkillManifest; directories: string[] } {
    const parsed = deviceSkillMaterial.safeParse(input)
    if (!parsed.success || !isDeepStrictEqual(parsed.data.binding, binding)) reject('device_material_invalid')
    const material = parsed.data
    if (Buffer.byteLength(material.manifest) > 128 * 1024 || hash(material.manifest) !== binding.manifestDigest) {
      reject('device_material_invalid')
    }
    let raw: unknown
    try { raw = JSON.parse(material.manifest) } catch { reject('device_material_invalid') }
    const validated = deviceSkillManifest.safeParse(raw)
    if (!validated.success || validated.data.artifactSha256 !== binding.packageDigest) reject('device_material_invalid')
    const manifest = validated.data
    const instructions = manifest.files.find(file => file.path === 'skill/SKILL.md')!
    if (instructions.sha256 !== binding.instructionDigest) reject('device_material_invalid')
    const files = new Set(manifest.files.map(file => file.path)), directories = new Set(['skill'])
    if (material.files.length !== files.size || material.files.some(file => !files.has(file.path))) reject('device_material_invalid')
    for (const file of manifest.files) {
      let parent = dirname(file.path)
      while (parent !== '.') { directories.add(parent); parent = dirname(parent) }
    }
    if ([...directories].some(path => files.has(path))) reject('device_material_invalid')
    return { material, manifest, directories: [...directories].sort((a, b) => a.length - b.length) }
  }

  private async verifyPackage(root: string, material: DeviceSkillMaterial, manifest: DeviceSkillManifest,
    directories: readonly string[], signal: AbortSignal): Promise<void> {
    const expected = new Set(['manifest.json', ...directories, ...manifest.files.map(file => file.path)])
    const found = new Set<string>(), pending = ['']
    while (pending.length) {
      const relative = pending.pop()!, path = relative ? join(root, relative) : root
      await this.directory(path, 0o555n, signal)
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (!expected.has(child) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          reject('device_material_cache_invalid')
        }
        found.add(child)
        if (entry.isDirectory()) pending.push(child)
      }
    }
    if (found.size !== expected.size) reject('device_material_cache_invalid')
    await this.verifyFile(join(root, 'manifest.json'), Buffer.byteLength(material.manifest), hash(material.manifest),
      0o444n, signal, 'device_material_cache_invalid')
    for (const file of manifest.files) {
      await this.verifyFile(join(root, file.path), file.size, file.sha256, 0o444n, signal, 'device_material_cache_invalid')
    }
    for (const relative of [...directories].reverse()) await this.directory(join(root, relative), 0o555n, signal)
    await this.directory(root, 0o555n, signal)
  }

  private async package(parent: string, binding: DeviceMaterialBinding, input: DeviceSkillMaterial,
    signal: AbortSignal): Promise<string> {
    const { material, manifest, directories } = this.material(binding, input)
    // Validate even a cache hit against today's authorized response, one file buffer at a time.
    for (const file of manifest.files) {
      const encoded = material.files.find(item => item.path === file.path)!.data
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.toString('base64') !== encoded || bytes.length !== file.size || hash(bytes) !== file.sha256) {
        reject('device_material_invalid')
      }
    }
    const target = join(parent, binding.packageDigest)
    let present = true
    try { await lstat(target) } catch (error) { if (missing(error)) present = false; else throw error }
    if (present) {
      await this.verifyPackage(target, material, manifest, directories, signal)
      await this.directory(parent, 0o700n, signal)
      return target
    }
    const stage = join(parent, `.stage-${randomUUID()}`)
    await this.ancestors(stage, signal)
    await mkdir(stage, { mode: 0o700 })
    const stageIdentity = await lstat(stage, { bigint: true })
    owner(stageIdentity, true, 0o700n, 'device_material_path_changed')
    let published = false
    let failure: unknown
    try {
      await this.directory(stage, 0o700n, signal)
      for (const relative of directories) await this.directory(join(stage, relative), 0o700n, signal, true)
      for (const file of manifest.files) {
        const encoded = material.files.find(item => item.path === file.path)!.data
        await this.write(join(stage, file.path), Buffer.from(encoded, 'base64'), 0o444, signal)
      }
      await this.write(join(stage, 'manifest.json'), Buffer.from(material.manifest), 0o444, signal)
      for (const relative of [...directories, ''].reverse()) {
        const path = relative ? join(stage, relative) : stage
        const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.chmod(0o555); await directory.sync() } finally { await directory.close() }
      }
      await this.verifyPackage(stage, material, manifest, directories, signal)
      await this.directory(parent, 0o700n, signal)
      await this.checkpoint(signal)
      await rename(stage, target)
      published = true
      await this.directory(parent, 0o700n, signal)
      await this.verifyPackage(target, material, manifest, directories, signal)
      return target
    } catch (error) {
      failure = error
      throw error
    } finally {
      try {
        if (!published) {
          await this.assertOwned()
          const current = await lstat(stage, { bigint: true }).catch(error => { if (missing(error)) return undefined; throw error })
          if (current && current.isDirectory() && !current.isSymbolicLink() && same(current, stageIdentity)) {
            for (const relative of ['', ...directories]) {
              const path = relative ? join(stage, relative) : stage
              const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
                .catch(error => { if (missing(error)) return undefined; throw error })
              try { await file?.chmod(0o700) } finally { await file?.close() }
            }
            await rm(stage, { recursive: true })
          }
        }
      } catch (error) { if (failure === undefined) throw error }
      for (const relative of ['', ...directories, 'manifest.json', ...manifest.files.map(file => file.path)]) {
        this.identities.delete(relative ? join(stage, relative) : stage)
      }
    }
  }

  /**
   * Reauthorize and prepare each selected package serially; cache hits never bypass load. Packages
   * are published only after full validation and sync. Retrying a failed sync rechecks and syncs
   * visible bytes; prior versions and Home contents are retained. Returned package mounts require
   * read-only Docker mounting, and only the returned Home may be writable alongside the project.
   * @param instanceId Validated enrollment identity, separate from a worker process generation.
   * @param bindings Immutable packages selected by this accepted dispatch.
   * @param load Fetch the original binding's bounded bytes through current Platform authorization.
   * @param signal Abort admission and unpublished staging work.
   * @returns Local persistent Home and individual selected package mount sources and targets.
   */
  async prepare(instanceId: OwnedContainerOwner['enrollmentId'], bindings: readonly DeviceMaterialBinding[],
    load: (binding: DeviceMaterialBinding) => Promise<DeviceSkillMaterial>, signal: AbortSignal):
    Promise<{ home: string; mounts: readonly { source: string; target: string }[] }> {
    try {
      await this.checkpoint(signal)
      const enrollment = ownedContainerOwner.shape.enrollmentId.safeParse(instanceId)
      if (!enrollment.success) reject('device_material_invalid')
      const selected: DeviceMaterialBinding[] = []
      if (bindings.length) {
        const parsed = deviceMaterialSelection.safeParse(bindings)
        if (!parsed.success) reject('device_material_invalid')
        selected.push(...parsed.data.map(binding => Object.freeze(binding)))
      }
      await this.parents(signal)
      const home = await this.home(enrollment.data, signal)
      const mounts: { source: string; target: string }[] = []
      if (selected.length) {
        let parent = this.root
        for (const part of ['materials', enrollment.data, 'sha256']) {
          parent = join(parent, part); await this.directory(parent, 0o700n, signal, true)
        }
        for (const binding of selected) {
          await this.checkpoint(signal)
          let material: DeviceSkillMaterial
          try { material = await load(binding) } catch { reject(signal.aborted ? 'device_material_cancelled' : 'device_material_unavailable') }
          await this.checkpoint(signal)
          const source = await this.package(parent, binding, material, signal)
          mounts.push({ source, target: `/opt/power-evolve/skills/sha256/${binding.packageDigest}` })
        }
      }
      await this.parents(signal)
      await this.home(enrollment.data, signal)
      await this.checkpoint(signal)
      return { home, mounts }
    } catch (error) {
      if (error instanceof MaterialsError) throw error
      if (signal.aborted) reject('device_material_cancelled')
      reject('device_material_io')
    }
  }
}
