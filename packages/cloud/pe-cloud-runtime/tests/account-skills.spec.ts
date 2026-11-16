/** Original Loader/policy/Agent/Workspace admission; Node fixtures issue no Linux skill-copy capability. */
import { mkdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CloudAccountFiles, FdMutationFailure, type SkillBundleVersion, type SkillBundleSource, type SkillVersionSource, type SkillVersion, type SkillVersionId } from '@deepseek-ai/dsh-pe-cloud-files'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { prepareAccountSkillResources } from '../src/account-skills.ts'
import { policyFixture } from './account-policy-fixture.ts'

async function fixture(sessionId = 'skill-caller', prepare?: Parameters<typeof prepareAccountSkillResources>[5]) {
  const owner = policyFixture(), graph = await owner.start()
  await graph.ctx.sessionController.create({ sessionId: SessionId(sessionId) })
  const agent = graph.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error('Original native Agent absent')
  const feature = prepareAccountSkillResources(graph.ctx, graph.binding, () => graph.files, () => graph.guards,
    (caller) => { graph.api.assertInstalled(caller) }, prepare)
  const project = vi.spyOn(graph.files, 'projectFor'), parent = vi.spyOn(graph.files, 'prepareSkillProject')
  return { owner, graph, agent, feature, project, parent }
}

// Rejection descriptors never reach an issuer or establish a successful copy; the actual files owner rejects missing capability.
function descriptor(binding: SkillVersion['binding']): SkillVersion {
  return Object.freeze({ binding, id: brandString<SkillVersionId>('00000000-0000-4000-8000-000000000001'),
    skillSha256: '0'.repeat(64), resourceSha256: '1'.repeat(64), skillBytes: 1, resourceBytes: 1 })
}

function sourceFor(version: SkillVersion): SkillVersionSource {
  return { version, readText: async () => { throw new Error('No rejected source read belongs to this fixture') },
    readBytes: async () => { throw new Error('No rejected source read belongs to this fixture') } }
}

it('rejects standing Contexts, cwd-only inputs and copied Agent ids before project I/O', async () => {
  const f = await fixture(), cwd = f.owner.project
  for (const options of [{ cwd }, { scope: f.graph.ctx, cwd }, { scope: { id: f.agent.id }, cwd }]) {
    expect(() => { f.feature.assertCaller(options) }).toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  }
  expect(f.project).not.toHaveBeenCalled()
  expect(f.parent).not.toHaveBeenCalled()
})

it('requires the same actual Agent returned by this original registry even when another graph uses the same id', async () => {
  const a = await fixture('same-local-id'), b = await fixture('same-local-id')
  expect(() => { a.feature.assertCaller({ scope: b.agent, cwd: a.owner.project }) })
    .toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  expect(a.project).not.toHaveBeenCalled()
  expect(a.parent).not.toHaveBeenCalled()
})

it('uses the actual WorkingDirectory for a live caller and rejects forged cwd or an aborted observer before I/O', async () => {
  const f = await fixture(), child = join(f.owner.project, 'nested')
  expect(() => { f.feature.assertCaller({ scope: f.agent, cwd: f.owner.project }) }).not.toThrow()
  expect(() => { f.feature.assertCaller({ scope: f.agent, cwd: child }) })
    .toThrow(expect.objectContaining({ code: 'cloud/stale-generation' }))
  const cancel = new AbortController(), reason = new Error('Observer cancelled')
  cancel.abort(reason)
  expect(() => { f.feature.assertCaller({ scope: f.agent, cwd: f.owner.project, signal: cancel.signal }) }).toThrow(reason)
  expect(f.project).not.toHaveBeenCalled()
  expect(f.parent).not.toHaveBeenCalled()
})

it('preserves the current shared policy refusal after a real WorkingDirectory change into a nested project directory', async () => {
  const f = await fixture(), child = join(f.owner.project, 'nested')
  mkdirSync(child)
  await f.graph.ctx.workingDirectory.set(f.agent, child)
  expect(() => { f.feature.assertCaller({ scope: f.agent, cwd: child }) })
    .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(f.project).not.toHaveBeenCalled()
  expect(f.parent).not.toHaveBeenCalled()
})

it('retains the original policy refusal for a detached native Workspace membership before I/O', async () => {
  const f = await fixture()
  await f.graph.files.project().workspace.detachSession(f.agent.id)
  expect(() => { f.feature.assertCaller({ scope: f.agent, cwd: f.owner.project }) })
    .toThrow(expect.objectContaining({ code: 'cloud/forbidden' }))
  expect(f.project).not.toHaveBeenCalled()
  expect(f.parent).not.toHaveBeenCalled()
})

it('rechecks native membership after the real projectFor await before asking for a parent grant', async () => {
  const f = await fixture()
  f.project.mockImplementation(async (...args) => {
    const installed = await CloudAccountFiles.prototype.projectFor.call(f.graph.files, ...args)
    await installed.workspace.detachSession(f.agent.id)
    return installed
  })
  const version = descriptor(f.graph.binding)
  await expect(f.feature.materialize(version, { scope: f.agent, cwd: f.owner.project }, sourceFor(version)))
    .rejects.toMatchObject({ code: 'cloud/forbidden' })
  expect(f.project).toHaveBeenCalledOnce()
  expect(f.parent).not.toHaveBeenCalled()
})

it('rejects missing original files projection after actual caller and project selection without returning resource guidance', async () => {
  const f = await fixture()
  const version = descriptor(f.graph.binding)
  await expect(f.feature.materialize(version, { scope: f.agent, cwd: f.owner.project }, sourceFor(version)))
    .rejects.toMatchObject({ code: 'files/prerequisite-missing' })
  expect(f.project).toHaveBeenCalledOnce()
  expect(f.parent).toHaveBeenCalledOnce()
})

/** The original Loader/Agent/policy remains real; only Linux projection I/O and its issued result settlement are scripted. */
async function bundleResourceFixture(existingCopy = false, prepare?: Parameters<typeof prepareAccountSkillResources>[5]) {
  const f = await fixture('skill-caller', prepare)
  const version: SkillBundleVersion = Object.freeze({ binding: f.graph.binding,
    id: brandString<SkillVersionId>('00000000-0000-4000-8000-000000000002'), format: 'bundle-tree-v1',
    files: [{ relativePath: 'SKILL.md', bytes: 12, sha256: '1'.repeat(64) },
      { relativePath: 'nested/resource.bin', bytes: 4, sha256: '2'.repeat(64) }],
    directories: ['nested'], treeSha256: '3'.repeat(64), contentBytes: 16, directoryCount: 1, chargedBytes: 128, chargedInodes: 5 })
  const lease = Object.freeze({ ...version })
  const metadata = { relativePath: '.pe', device: '7', inode: '11', mountId: '8', uid: 2000, gid: 2000, mode: 0o40700 }
  const parent: Awaited<ReturnType<CloudAccountFiles['prepareSkillProject']>>['value'] = {
    binding: f.graph.binding, workspaceId: f.graph.files.project().workspace.id,
    project: { rootPath: f.owner.project, rootDevice: '7', rootInode: '9', rootMountId: '8',
      quota: { device: '7', mountId: '8', maximumBytes: '65536', maximumInodes: '128' } },
    metadataDirectory: metadata, skillsDirectory: { ...metadata, inode: '12' },
  }
  const copy: Awaited<ReturnType<CloudAccountFiles['materializeBundleVersion']>>['value'] = {
    binding: parent.binding, workspaceId: parent.workspaceId, version, resourceBase: `.pe/skills/${version.id}/`,
    metadataDirectory: parent.metadataDirectory, skillsDirectory: parent.skillsDirectory,
    copyDirectory: { ...metadata, inode: '13' },
  }
  const source: SkillBundleSource = { version: lease, files: lease.files, directories: lease.directories,
    readText: async () => 'fixture', readBytes: async () => Uint8Array.of(1) }
  const releaseParent = vi.fn(), releaseOperation = vi.fn()
  f.parent.mockResolvedValue({ value: parent, release: releaseParent })
  vi.spyOn(f.graph.files, 'assertSkillProjectGrant').mockImplementation((value) => { expect(value).toBe(parent) })
  const materialize = vi.spyOn(f.graph.files, 'materializeWorkspaceSkill').mockImplementation(async (project, selected, snapshot, current) => {
    expect(project.workspace).toBe(f.graph.files.project().workspace); expect(selected).toBe(parent)
    expect(snapshot).toBe(source); current()
    return `.skills/${version.id}`
  })
  const operation = Object.freeze({ project: parent, copies: existingCopy ? [copy] : [] })
  const borrow = vi.spyOn(f.graph.files, 'borrowAllBundleWorkingCopies').mockImplementation(async (project) => {
    expect(project).toBe(parent)
    return { value: operation, release: releaseOperation }
  })
  vi.spyOn(f.graph.files, 'assertBundleOperationCopies').mockImplementation((value) => { expect(value).toBe(operation) })
  return { ...f, version, lease, source, copy, parentValue: parent, releaseParent, releaseOperation, materialize, borrow }
}

it('admits the actual Native caller before using execution-owned parent preparation for Workspace publication', async () => {
  const prepare = vi.fn<NonNullable<Parameters<typeof prepareAccountSkillResources>[5]>>()
  const f = await bundleResourceFixture(false, prepare), observer = new AbortController()
  prepare.mockImplementation(async (caller, project, signal) => {
    expect(caller).toBe(f.agent.ctx); expect(project.workspace).toBe(f.graph.files.project().workspace)
    expect(signal).not.toBe(observer.signal); expect(signal.aborted).toBe(false)
    return { value: f.parentValue, release: f.releaseParent }
  })
  await expect(f.feature.materialize(f.lease, { scope: { id: f.agent.id }, cwd: f.owner.project }, f.source)).rejects.toThrow()
  expect(prepare).not.toHaveBeenCalled()
  const resources = await f.feature.materialize(f.lease, { scope: f.agent, cwd: f.owner.project, signal: observer.signal }, f.source)
  expect(resources.resourceBase?.kind).toBe('directory')
  expect(prepare).toHaveBeenCalledOnce(); expect(f.parent).not.toHaveBeenCalled()
  expect(f.materialize).toHaveBeenCalledOnce(); expect(f.releaseParent).toHaveBeenCalledOnce()
})

it('joins execution-owned parent preparation after observer cancellation and releases the actual grant before refusal', async () => {
  const prepare = vi.fn<NonNullable<Parameters<typeof prepareAccountSkillResources>[5]>>()
  const f = await bundleResourceFixture(false, prepare), observer = new AbortController()
  const entered = Promise.withResolvers<undefined>(), gate = Promise.withResolvers<undefined>()
  prepare.mockImplementation(async () => {
    entered.resolve(undefined); await gate.promise
    return { value: f.parentValue, release: f.releaseParent }
  })
  const pending = f.feature.materialize(f.lease, { scope: f.agent, cwd: f.owner.project, signal: observer.signal }, f.source)
    .then(value => ({ value, cause: undefined }), (cause: unknown) => ({ value: undefined, cause }))
  onTestFinished(async () => { gate.resolve(undefined); await pending })
  await entered.promise; observer.abort(new Error('observer left preparation'))
  expect(f.releaseParent).not.toHaveBeenCalled(); expect(f.materialize).not.toHaveBeenCalled()
  gate.resolve(undefined)
  expect((await pending).cause).toBe(observer.signal.reason)
  expect(f.releaseParent).toHaveBeenCalledOnce(); expect(f.parent).not.toHaveBeenCalled()
})

it('[managed-skills] forwards the exact live source to the original Workspace publication after admission', async () => {
  const f = await bundleResourceFixture()
  expect(f.lease).not.toBe(f.version)
  expect(() => { f.feature.assertCaller({ scope: { id: f.agent.id }, cwd: f.owner.project }) }).toThrow()
  expect(f.materialize).not.toHaveBeenCalled()
  const resources = await f.feature.materialize(f.lease, { scope: f.agent, cwd: f.owner.project }, f.source)
  if (resources.resourceBase?.kind !== 'directory' || resources.path === undefined) throw new Error('Missing actual resource guidance')
  expect(posix.normalize(resources.resourceBase.path)).toBe(`${f.owner.project}/.skills/${f.version.id}/`)
  expect(posix.normalize(resources.path)).toBe(`${f.owner.project}/.skills/${f.version.id}/SKILL.md`)
  expect(f.materialize).toHaveBeenCalledOnce(); expect(f.borrow).toHaveBeenCalledOnce()
  expect(f.releaseParent).toHaveBeenCalledOnce(); expect(f.releaseOperation).toHaveBeenCalledOnce()
})

it('[managed-skills] keeps existing protected copies and user edits on their original execution borrow', async () => {
  const f = await bundleResourceFixture(true)
  const resources = await f.feature.materialize(f.lease, { scope: f.agent, cwd: f.owner.project }, f.source)
  if (resources.resourceBase?.kind !== 'directory') throw new Error('Missing legacy resources')
  expect(posix.normalize(resources.resourceBase.path)).toBe(`${f.owner.project}/.pe/skills/${f.version.id}/`)
  expect(f.materialize).not.toHaveBeenCalled()
  expect(f.borrow).toHaveBeenCalledOnce(); expect(f.releaseOperation).toHaveBeenCalledOnce()
  expect(f.releaseParent).toHaveBeenCalledOnce()
})

it('[managed-skills] keeps the original parent through a cancelled observer until actual Workspace publication settles', async () => {
  const f = await bundleResourceFixture(), observer = new AbortController()
  const entered = Promise.withResolvers<undefined>(), actual = Promise.withResolvers<string>()
  onTestFinished(() => { actual.resolve(`.skills/${f.version.id}`) })
  f.materialize.mockImplementation(async (_project, _parent, source, _current, signal) => {
    expect(source).toBe(f.source); expect(signal).not.toBe(observer.signal)
    entered.resolve(undefined); return actual.promise
  })
  const pending = f.feature.materialize(f.lease, { scope: f.agent, cwd: f.owner.project, signal: observer.signal }, f.source)
  const rejected = expect(pending).rejects.toThrow('observer left')
  await entered.promise; observer.abort(new Error('observer left'))
  expect(f.releaseParent).not.toHaveBeenCalled()
  expect(f.releaseOperation).toHaveBeenCalledOnce()
  actual.resolve(`.skills/${f.version.id}`); await rejected
  expect(f.releaseParent).toHaveBeenCalledOnce()
})

it.each(['not-published', 'unknown'] as const)('[managed-skills] retains original parent responsibility for Workspace publication outcome %s', async (outcome) => {
  const f = await bundleResourceFixture(), failure = new FdMutationFailure(outcome, 'FS_IO_ERROR')
  f.materialize.mockRejectedValueOnce(failure)
  await expect(f.feature.materialize(f.lease, { scope: f.agent, cwd: f.owner.project }, f.source)).rejects.toBe(failure)
  expect(f.releaseParent).toHaveBeenCalledTimes(outcome === 'not-published' ? 1 : 0)
  expect(f.releaseOperation).toHaveBeenCalledOnce()
})
