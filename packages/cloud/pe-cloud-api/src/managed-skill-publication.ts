/** Complete account directory management within the original AccountSaves serial turn. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillCatalogInspection, SkillDefinition, SkillProvider, SkillProviderControl,
  SkillProviderObservation, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { FdMutationFailure, FilesFailure, type SkillBundleFile, type SkillBundlePort, type SkillBundleVersion,
  type SkillCatalog, type SkillCatalogCommit, type SkillCatalogEntry, type SkillInstallationId,
  type SkillVersion, type SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import type { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConfigSaveOutcomeUnknown, SkillEditApplyFailure } from './config-saves.ts'
import type { ConfigSaveBarrier, SkillEditVersion } from './save-hooks.ts'
import { CloudApiError } from './errors.ts'
import { skillProviderFor, type SkillResourcePreparation } from './skill-source.ts'
import { managedSkillProviderFor, type ManagedSkillPreparation } from './managed-skill-source.ts'
import type { ManagedSkillBundleUpload, ManagedSkillDetails, ManagedSkillDownload, ManagedSkillDownloadRequest,
  ManagedSkillEntry, ManagedSkillId, ManagedSkillMutationResult, ManagedSkillPublicLimits, ManagedSkillSelection,
  ManagedSkillsInstalled, ManagedSkillsInstalledRequest } from './managed-skill-types.ts'
import type { SkillCurrentState, SkillPublicationLimits, SkillPublishResult, SkillVersionMetadata } from './skill-types.ts'

/** Preparation may retain actual files responsibility although no directory commit was submitted. */
class SkillPreparationFailure extends ConfigSaveOutcomeUnknown {}

type OwnedProvider = Readonly<{ provider: FileSystemSkillProvider; lifetime: AbortController }>
type Handle = Readonly<{
  skillId: SkillInstallationId
  legacy: boolean
  version: SkillBundleVersion | SkillVersion
  files: readonly SkillBundleFile[]
  contentBytes: number
  provider: FileSystemSkillProvider
  owned: OwnedProvider
  native: SkillCandidate
}>
type Locator = Readonly<{ handle: Handle; candidate: SkillCandidate }>
function refused(message: string, conflict = false): CloudApiError {
  return new CloudApiError(conflict ? 'cloud/config-conflict' : 'cloud/forbidden', message)
}
function sampleMetadata(files: readonly SkillBundleFile[], id: string): SkillVersionMetadata {
  const skill = files.find(file => file.relativePath === 'SKILL.md'), resource = files.find(file => file.relativePath === 'resource.bin')
  if (files.length !== 2 || skill === undefined || resource === undefined) throw refused('The legacy sample is not a complete two-file version.')
  return { id, skillSha256: skill.sha256, resourceSha256: resource.sha256, skillBytes: skill.bytes, resourceBytes: resource.bytes }
}

/** No second pointer, queue, drain participant or registry selection algorithm. */
export class AccountManagedSkills implements SkillProvider {
  readonly name = 'account-published-skills'
  private visible = new Map<SkillInstallationId, Handle>()
  private revision: FsVersion | null = null
  private applied = false
  private readonly providers = new Set<OwnedProvider>()
  private readonly locators = new WeakMap<object, Locator>()
  private readonly publicLimits: ManagedSkillPublicLimits

  constructor(private readonly ctx: Context, private readonly control: SkillProviderControl,
    private readonly saves: ConfigSaveBarrier, private readonly port: SkillBundlePort, private readonly legacyPort: SkillVersionPort,
    private readonly registry: SkillRegistry, private readonly input: ManagedSkillPreparation,
    private readonly sampleLimits: SkillPublicationLimits, private readonly sampleResources?: SkillResourcePreparation) {
    control.signal.addEventListener('abort', () => {
      for (const owned of this.providers) owned.lifetime.abort(control.signal.reason)
    }, { once: true })
    ctx.effect(() => async () => { await this.disposeProviders([...this.providers]) }, 'pe-cloud-api: settle native skill providers')
    const files = input.bundleLimits, api = input.limits
    this.publicLimits = Object.freeze({ maxSkills: files.maxInstallations, maxFilesPerBundle: files.maxFiles,
      maxDirectoriesPerBundle: files.maxDirectories, maxFileBytes: files.maxFileBytes, maxBundleBytes: files.maxContentBytes,
      maxZipBytes: files.maxArchiveBytes, maxPathBytes: files.maxPathBytes, maxPathDepth: files.maxDepth,
      maxRequestBytes: api.maxRequestBytes, maxReplyBytes: api.maxReplyBytes })
  }

  /**
   * Reconcile visible native providers with the persisted catalog before business admission.
   * @param check Original installed-owner check.
   * @returns Full native source validation before business admission.
   */
  restore(check: () => void): Promise<void> {
    return this.saves.admit('skill-publish', async () => {
      this.active(); check()
      const catalog = await this.observe(this.saves.binding.lifetime)
      const handles = new Map<SkillInstallationId, Handle>()
      if (catalog.entries.length > this.input.limits.maxRetainedProviders) throw this.capacity()
      for (const entry of catalog.entries) {
        const existing = this.visible.get(entry.skillId)
        if (existing !== undefined && existing.version.id === entry.version.id && existing.legacy === (entry.kind === 'legacy-sample')) {
          await this.native(existing.provider, this.saves.binding.lifetime, existing.legacy)
          handles.set(entry.skillId, existing)
        } else handles.set(entry.skillId, await this.bundleHandle(entry, this.saves.binding.lifetime))
      }
      check(); const old = [...this.visible.values()]
      this.apply(handles, catalog.revision)
      await this.disposeProviders(old.filter(handle => ![...handles.values()].includes(handle)).map(handle => handle.owned))
    })
  }

  /**
   * Inspect installed skills under the original directory-edit read turn.
   * @param request Optional original workspace selector.
   * @param check Original Peer/Use guard.
   * @param signal Observer signal.
   * @returns Complete native-inspected installed list and directory edit.
   */
  async installed(request: ManagedSkillsInstalledRequest, check: () => void, signal: AbortSignal): Promise<ManagedSkillsInstalled> {
    const result = await this.saves.describeSkillEdit(async () => {
      const options = this.view(request, signal), catalog = await this.observeCurrent(signal)
      const inspection = await this.registry.inspect(options)
      check()
      return { value: { entries: catalog.entries.map(entry => this.row(this.handle(entry), inspection)),
        complete: inspection.complete, actions: { install: catalog.entries.length < this.publicLimits.maxSkills
          && this.providers.size < this.input.limits.maxRetainedProviders }, limits: this.publicLimits }, revision: catalog.revision }
    }, () => { this.active(); check() })
    return this.reply({ ...result.value, version: result.version })
  }

  /**
   * Inspect one current installation and its complete version-file metadata.
   * @param skillId Original installation selector.
   * @param check Original Peer/Use guard.
   * @param signal Observer signal.
   * @returns Complete metadata and the single directory edit.
   */
  async details(skillId: ManagedSkillId, check: () => void, signal: AbortSignal): Promise<ManagedSkillDetails> {
    const result = await this.saves.describeSkillEdit(async () => {
      const catalog = await this.observeCurrent(signal), entry = this.selected(catalog, skillId)
      const inspection = await this.registry.inspect({ signal })
      check()
      return { value: { entry: this.row(this.handle(entry), inspection), files: entry.version.files.map(file => ({ ...file })) },
        revision: catalog.revision }
    }, () => { this.active(); check() })
    return this.reply({ ...result.value, version: result.version })
  }

  /**
   * Describe the legacy sample against the current complete directory revision.
   * @param check Original Peer/Use guard.
   * @param signal Observer signal.
   * @returns Legacy sample view with the entire directory's real revision, even when sample is absent.
   */
  async current(check: () => void, signal: AbortSignal): Promise<SkillCurrentState> {
    const result = await this.saves.describeSkillEdit(async () => {
      const catalog = await this.observeCurrent(signal), sample = catalog.entries.find(entry => entry.kind === 'legacy-sample')
      return { value: sample === undefined ? null : sampleMetadata(sample.version.files, sample.version.id), revision: catalog.revision }
    }, () => { this.active(); check() })
    const applied = this.applied && result.value !== null
    return this.reply({ slot: 'sample', current: result.value, version: result.version, applied,
      resources: applied && (this.input.resources !== undefined || this.sampleResources !== undefined) ? 'project-on-load' : 'unavailable' }, true)
  }

  /**
   * Install a complete managed bundle through the original serialized directory mutation.
   * @param version Original directory edit.
   * @param bundle Complete files-owned input.
   * @param check Original Peer/Use guard.
   * @param signal Observer signal.
   * @returns Durable and native application facts.
   */
  install(version: SkillEditVersion, bundle: ManagedSkillBundleUpload, check: () => void,
    signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    return this.mutate(version, { kind: 'install', bundle }, check, signal)
  }

  /**
   * Replace one managed installation through the original version-checked directory mutation.
   * @param skillId Original managed installation.
   * @param version Directory edit.
   * @param bundle Complete replacement.
   * @param check Original guard.
   * @param signal Observer signal.
   * @returns Separate persistence/application facts.
   */
  update(skillId: ManagedSkillId, version: SkillEditVersion, bundle: ManagedSkillBundleUpload,
    check: () => void, signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    return this.mutate(version, { kind: 'update', skillId, bundle }, check, signal)
  }

  /**
   * Remove an installation from future admission without deleting working copies.
   * @param skillId Original installation.
   * @param version Directory edit.
   * @param check Original guard.
   * @param signal Observer signal.
   * @returns Future native admission removal; no working-copy deletion.
   */
  uninstall(skillId: ManagedSkillId, version: SkillEditVersion, check: () => void,
    signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    return this.mutate(version, { kind: 'uninstall', skillId }, check, signal)
  }

  /**
   * Export exact installed content inside the original retained read turn.
   * @param request Exact installed content selectors.
   * @param check Original guard.
   * @param signal Observer signal.
   * @returns Complete authorized ZIP, settled inside the original save turn.
   */
  download(request: ManagedSkillDownloadRequest, check: () => void, signal: AbortSignal): Promise<ManagedSkillDownload> {
    return this.read(async () => {
      check()
      const catalog = await this.observeCurrent(signal), entry = this.selected(catalog, request.skillId)
      if (entry.version.id !== request.contentVersion) throw refused('The installed content changed; refresh before downloading.', true)
      // Selection and the files borrow begin inside this same original turn; no source is captured before admission.
      const held = await this.port.exportBundle(entry.version, signal)
      try {
        check()
        return this.reply({ skillId: entry.skillId, contentVersion: entry.version.id, fileName: `${entry.skillId}.skill`,
          mediaType: 'application/zip', bytes: held.value.byteLength,
          sha256: createHash('sha256').update(held.value).digest('hex'), dataBase64: Buffer.from(held.value).toString('base64') })
      } finally { held.release() }
    })
  }

  /**
   * Publish the legacy two-file sample through the directory commit and native-provider lifecycle.
   * @param edit Original directory edit.
   * @param markdown Complete legacy instruction.
   * @param resource Complete legacy bytes.
   * @param check Original guard.
   * @param signal Observer signal.
   * @returns Legacy two-file result, committing the same schema2 directory.
   */
  async publish(edit: SkillEditVersion, markdown: string, resource: Uint8Array<ArrayBuffer>, check: () => void,
    signal: AbortSignal): Promise<SkillPublishResult> {
    let preparation: Awaited<ReturnType<SkillVersionPort['prepare']>> | undefined
    const releasePreparation = (): void => {
      const held = preparation; preparation = undefined; held?.release()
    }
    let handoff: Awaited<ReturnType<SkillVersionPort['commit']>> | undefined
    let next: Map<SkillInstallationId, Handle> | undefined, selected: Handle | undefined, committing = false
    try {
      const version = await this.saves.commitSkillEdit(edit, async (expected) => {
        const catalog = await this.observeCurrent(signal)
        if (catalog.revision !== expected) return { persisted: false, error: refused('The skill directory changed; read it before editing.', true) }
        if (this.providers.size >= this.input.limits.maxRetainedProviders) return { persisted: false, error: this.capacity() }
        try {
          preparation = await this.legacyPort.prepare({ skillMarkdown: markdown, resource }, signal)
          const exact = preparation.value
          if (exact.binding !== this.saves.binding) throw new ConfigSaveOutcomeUnknown()
          const owned = this.createProvider(control =>
            skillProviderFor(this.ctx, control, this.legacyPort, exact, this.sampleResources?.materialize))
          let native: SkillCandidate
          try { native = await this.native(owned.provider, signal, true) }
          catch (error) { await this.disposeProviders([owned]); throw error }
          selected = { skillId: brandString<SkillInstallationId>('sample'), legacy: true, version: exact, provider: owned.provider, owned, native,
            contentBytes: exact.skillBytes + exact.resourceBytes, files: [
              { relativePath: 'SKILL.md', bytes: exact.skillBytes, sha256: exact.skillSha256 },
              { relativePath: 'resource.bin', bytes: exact.resourceBytes, sha256: exact.resourceSha256 }] }
          next = new Map(this.visible); next.set(selected.skillId, selected)
          this.reply({ persisted: true, applied: false, version: edit, current: sampleMetadata(selected.files, selected.version.id), resources: 'project-on-load' }, true); check()
          committing = true
          handoff = await this.legacyPort.commit(exact, expected, signal)
          return { persisted: true, revision: handoff.value.revision }
        } catch (error) {
          try {
            if (selected !== undefined) await this.disposeProviders([selected.owned])
            return this.persistenceFailure(error, committing)
          } finally { releasePreparation() }
        }
      }, async () => {
        try {
          const old = [...this.visible.values()]
          try {
            if (handoff === undefined || next === undefined) throw new Error('The confirmed sample handoff is unavailable.')
            this.apply(next, handoff.value.revision)
          } finally { handoff?.release(); handoff = undefined }
          await this.disposeProviders(old.filter(handle => ![...this.visible.values()].includes(handle)).map(handle => handle.owned))
        } finally { releasePreparation() }
      }, () => { this.active(); check() })
      if (selected === undefined) throw new ConfigSaveOutcomeUnknown()
      return this.reply({ persisted: true, applied: true, version, current: sampleMetadata(selected.files, selected.version.id),
        resources: this.sampleResources === undefined ? 'unavailable' : 'project-on-load' }, true)
    } catch (error) {
      handoff?.release()
      if (error instanceof SkillEditApplyFailure && selected !== undefined) return this.reply({ persisted: true, applied: false,
        version: error.version, current: sampleMetadata(selected.files, selected.version.id), resources: 'unavailable' }, true)
      if (error instanceof SkillPreparationFailure) throw new CloudApiError('cloud/account-unavailable', 'Skill preparation did not settle; no directory publication was submitted.')
      if (error instanceof ConfigSaveOutcomeUnknown) return { persisted: 'unknown', applied: false, resources: 'unavailable' }
      throw error
    } finally { releasePreparation() }
  }

  list(options: SkillViewOptions): Promise<SkillProviderObservation> {
    return this.read(async () => {
      // Read current handles only after admission; no pre-turn provider capture survives a catalog mutation.
      const candidates: SkillCandidate[] = []
      let complete = true
      for (const handle of this.visible.values()) {
        const result = await handle.provider.list(options), observed = 'candidates' in result ? result : { candidates: result, complete: true }
        complete &&= observed.complete
        for (const candidate of observed.candidates) {
          const locator = Object.freeze({})
          this.locators.set(locator, { handle, candidate })
          candidates.push({ ...candidate, locator })
        }
      }
      return { candidates, complete }
    })
  }

  get(candidate: SkillCandidate, options: SkillViewOptions): Promise<SkillDefinition | undefined> {
    return this.read(async () => {
      const locator = candidate.locator
      const selected = locator !== null && typeof locator === 'object' ? this.locators.get(locator) : undefined
      if (selected === undefined || this.visible.get(selected.handle.skillId) !== selected.handle) return undefined
      const resources = 'format' in selected.handle.version ? this.input.resources : this.sampleResources
      if (resources === undefined) throw refused('Account skill project resources are unavailable.')
      resources.assertCaller(options)
      return selected.handle.provider.get(selected.candidate, options)
    })
  }

  private async mutate(edit: SkillEditVersion, change: Readonly<{ kind: 'install'; bundle: ManagedSkillBundleUpload }>
    | Readonly<{ kind: 'update'; skillId: ManagedSkillId; bundle: ManagedSkillBundleUpload }>
    | Readonly<{ kind: 'uninstall'; skillId: ManagedSkillId }>, check: () => void, signal: AbortSignal): Promise<ManagedSkillMutationResult> {
    let preparation: Awaited<ReturnType<SkillBundlePort['prepareBundle']>> | undefined
    const releasePreparation = (): void => {
      const held = preparation; preparation = undefined; held?.release()
    }
    let handoff: { readonly value: SkillCatalogCommit; release(): void } | undefined
    let next: Map<SkillInstallationId, Handle> | undefined, changed: Handle | undefined, preparedHandle: Handle | undefined
    try {
      const version = await this.saves.commitSkillEdit(edit, async (expected) => {
        const catalog = await this.observeCurrent(signal)
        if (catalog.revision !== expected) return { persisted: false, error: refused('The skill directory changed; refresh before editing.', true) }
        if (change.kind !== 'install') {
          const selected = catalog.entries.find(entry => entry.skillId === change.skillId)
          if (selected === undefined) return { persisted: false, error: refused('The installation is unavailable.') }
          if (change.kind === 'update' && selected.kind === 'legacy-sample') return { persisted: false,
            error: refused('Update the preserved sample through its two-file publish method.') }
        }
        if (change.kind !== 'uninstall' && (this.providers.size >= this.input.limits.maxRetainedProviders
          || change.kind === 'install' && catalog.entries.length >= this.publicLimits.maxSkills)) return { persisted: false, error: this.capacity() }
        let provisional: Handle | undefined, committing = false
        let mutation: Parameters<SkillBundlePort['commitCatalog']>[1]
        try {
          if (change.kind === 'uninstall') {
            this.mutationReplyBudget(null, edit)
            mutation = change
          } else {
            preparation = await this.port.prepareBundle(change.bundle, signal)
            const prepared = preparation.value
            // The provisional id is never published or accepted as authority; files generates the actual installation id.
            provisional = await this.bundleHandle({ skillId: change.kind === 'update' ? change.skillId : brandString<SkillInstallationId>('00000000-0000-0000-0000-000000000000'),
              kind: 'managed', version: prepared }, signal)
            this.mutationReplyBudget(this.row(provisional), edit)
            mutation = change.kind === 'install' ? { kind: 'install', bundle: prepared }
              : { kind: 'update', skillId: change.skillId, bundle: prepared }
          }
          check()
          committing = true
          handoff = await this.port.commitCatalog(catalog, mutation, signal)
          preparedHandle = provisional
          const revision = handoff.value.catalog.revision
          if (revision === null) throw new ConfigSaveOutcomeUnknown()
          return { persisted: true, revision }

        } catch (error) {
          try {
            if (provisional !== undefined) await this.disposeProviders([provisional.owned])
            return this.persistenceFailure(error, committing)
          } finally { releasePreparation() }
        }
      }, async () => {
        try {
          const old = [...this.visible.values()]
          try {
            if (handoff === undefined) throw new Error('The confirmed directory handoff is unavailable.')
            const committed = handoff.value
            next = new Map(this.visible)
            if (change.kind === 'uninstall') next.delete(change.skillId)
            else {
              if (committed.entry === null || preparedHandle === undefined) throw new Error('The confirmed installation metadata is unavailable.')
              changed = { ...preparedHandle, skillId: committed.entry.skillId }
              next.set(changed.skillId, changed)
            }
            this.apply(next, committed.catalog.revision)
          } finally { handoff?.release(); handoff = undefined }
          await this.disposeProviders(old.filter(handle => ![...this.visible.values()].includes(handle)).map(handle => handle.owned))
        } finally { releasePreparation() }
      }, () => { this.active(); check() })
      return this.reply({ persisted: true, applied: true, version, entry: changed === undefined ? null : this.row(changed) })
    } catch (error) {
      handoff?.release()
      if (error instanceof SkillEditApplyFailure) return this.reply({ persisted: true, applied: false,
        version: error.version, entry: changed === undefined ? null : this.row(changed) })
      if (error instanceof SkillPreparationFailure) throw new CloudApiError('cloud/account-unavailable', 'Skill preparation did not settle; no directory publication was submitted.')
      if (error instanceof ConfigSaveOutcomeUnknown) return { persisted: 'unknown', applied: false }
      throw error
    } finally { releasePreparation() }
  }

  private async observe(signal: AbortSignal): Promise<SkillCatalog> {
    try {
      const held = await this.port.observeCatalog(signal)
      try { return held.value } finally { held.release() }
    } catch (error) {
      if (error instanceof FdMutationFailure && error.outcome === 'unknown') throw new ConfigSaveOutcomeUnknown()
      throw error
    }
  }
  private async observeCurrent(signal: AbortSignal): Promise<SkillCatalog> {
    const catalog = await this.observe(signal)
    if (!this.applied || catalog.revision !== this.revision || catalog.entries.length !== this.visible.size) {
      throw new CloudApiError('cloud/account-unavailable', 'The durable skill directory requires native reconciliation.')
    }
    for (const entry of catalog.entries) this.handle(entry)
    return catalog
  }
  private handle(entry: SkillCatalogEntry): Handle {
    const handle = this.visible.get(entry.skillId)
    if (handle === undefined || handle.version.id !== entry.version.id || handle.legacy !== (entry.kind === 'legacy-sample')) {
      throw new CloudApiError('cloud/account-unavailable', 'The native skill directory differs from durable storage.')
    }
    return handle
  }
  private selected(catalog: SkillCatalog, skillId: ManagedSkillId): SkillCatalogEntry {
    const entry = catalog.entries.find(value => value.skillId === skillId)
    if (entry === undefined) throw refused('The installation is unavailable.')
    return entry
  }
  private async bundleHandle(entry: SkillCatalogEntry, signal: AbortSignal): Promise<Handle> {
    if (entry.version.binding !== this.saves.binding) throw refused('The skill source belongs to another account generation.')
    if (this.providers.size >= this.input.limits.maxRetainedProviders) throw this.capacity()
    let version: SkillBundleVersion | SkillVersion = entry.version
    let owned: OwnedProvider
    if (entry.kind === 'legacy-sample' && this.sampleResources !== undefined) {
      const held = await this.legacyPort.current(signal)
      try {
        if (held.value === undefined || held.value.version.id !== entry.version.id) throw refused('The preserved sample source is unavailable.')
        version = held.value.version
      } finally { held.release() }
      const exact = version
      owned = this.createProvider(control => skillProviderFor(this.ctx, control, this.legacyPort, exact, this.sampleResources?.materialize))
    } else owned = this.createProvider(control =>
      managedSkillProviderFor(this.ctx, control, this.port, entry.version, this.input.resources))
    let native: SkillCandidate
    try { native = await this.native(owned.provider, signal, entry.kind === 'legacy-sample') }
    catch (error) { await this.disposeProviders([owned]); throw error }
    const handle: Handle = { skillId: entry.skillId, legacy: entry.kind === 'legacy-sample', version,
      files: entry.version.files, contentBytes: entry.version.contentBytes, provider: owned.provider, owned, native }
    try { this.row(handle); return handle }
    catch (error) { await this.disposeProviders([owned]); throw error }
  }
  private async native(provider: SkillProvider, signal: AbortSignal, sample: boolean): Promise<SkillCandidate> {
    const result = await provider.list({ signal }), rows = 'candidates' in result ? result.candidates : result
    if ('candidates' in result && !result.complete || rows.length !== 1 || rows[0] === undefined
      || sample && (rows[0].name !== 'sample' || !rows[0].invocation.userInvocable)) throw refused('The bundle must contain one complete native skill root.')
    return rows[0]
  }
  private row(handle: Handle, inspection?: SkillCatalogInspection): ManagedSkillEntry {
    let selection: ManagedSkillSelection = { kind: 'incomplete' }
    if (inspection?.complete) {
      const found = inspection.candidates.find((row) => {
        const locator = row.candidate.locator
        return locator !== null && typeof locator === 'object' && this.locators.get(locator)?.handle === handle
      })
      if (found?.selected) selection = { kind: 'effective' }
      else if (found?.overriddenBy !== undefined) selection = { kind: 'shadowed', by: {
        name: found.overriddenBy.name, source: found.overriddenBy.source, provider: found.overriddenBy.provider } }
    }
    const native = handle.native
    const row: ManagedSkillEntry = { skillId: handle.skillId, name: native.name, description: native.description,
      invocation: { ...native.invocation }, source: native.source, provider: native.provider, contentVersion: handle.version.id,
      fileCount: handle.files.length, contentBytes: handle.contentBytes, legacySample: handle.legacy, selection, mutable: true,
      actions: { update: !handle.legacy && this.providers.size < this.input.limits.maxRetainedProviders, uninstall: true, download: true } }
    if (Buffer.byteLength(JSON.stringify(row)) > this.input.limits.maxMetadataBytes) throw this.capacity()
    return row
  }
  private apply(handles: Map<SkillInstallationId, Handle>, revision: FsVersion | null): void {
    this.control.signal.throwIfAborted()
    this.applied = false; this.visible = handles; this.revision = revision
    this.control.invalidate(); this.applied = true
  }
  private view(request: ManagedSkillsInstalledRequest, signal: AbortSignal): SkillViewOptions {
    if (request.workspaceId === undefined) return { signal }
    const registry = this.ctx.get('workspaceRegistry'), workspace = registry?.get(request.workspaceId)
    if (workspace === undefined || this.ctx.root.get('workspaceRegistry')?.get(request.workspaceId) !== workspace) throw refused('The original account workspace is unavailable.')
    this.input.assertWorkspace(workspace)
    return { cwd: workspace.path, signal }
  }
  private async read<T>(submit: () => Promise<T>): Promise<T> {
    const result = await this.saves.admit('skill-projection', async () => {
      try {
        this.active()
        if (!this.applied) throw new CloudApiError('cloud/account-unavailable', 'The native skill directory is not applied.')
        return { ok: true as const, value: await submit() }
      }
      catch (error) {
        if (error instanceof ConfigSaveOutcomeUnknown || error instanceof FdMutationFailure && error.outcome === 'unknown') throw new ConfigSaveOutcomeUnknown()
        // Known read/projection refusal performs no directory write; actual files failures remain files-owned.
        return { ok: false as const, error }
      }
    })
    if (!result.ok) throw result.error
    return result.value
  }
  private persistenceFailure(error: unknown, committing: boolean): { readonly persisted: false; readonly error: CloudApiError } {
    if (error instanceof FilesFailure) return { persisted: false, error: new CloudApiError(error.code === 'cloud/capacity'
      ? 'cloud/capacity' : 'cloud/account-unavailable', 'The files operation was refused before native work started.') }
    if (error instanceof FdMutationFailure && error.outcome === 'not-published') return { persisted: false,
      error: new CloudApiError(error.code === 'FS_STALE_VERSION' ? 'cloud/config-conflict' : 'cloud/account-unavailable',
        'The skill directory was not published; refresh before editing.') }
    if (error instanceof CloudApiError) return { persisted: false, error }
    if (!committing) throw new SkillPreparationFailure()
    throw new ConfigSaveOutcomeUnknown()
  }
  private createProvider(create: (control: SkillProviderControl) => FileSystemSkillProvider): OwnedProvider {
    if (this.providers.size >= this.input.limits.maxRetainedProviders) throw this.capacity()
    const lifetime = new AbortController(), provider = create({ signal: lifetime.signal, invalidate: this.control.invalidate })
    const owned = { lifetime, provider }; this.providers.add(owned)
    return owned
  }
  private async disposeProviders(providers: readonly OwnedProvider[]): Promise<void> {
    for (const owned of providers) {
      owned.lifetime.abort()
      // Await the original provider's shared disposal, including any watcher settlement; failed disposal stays charged.
      try { await owned.provider.dispose() }
      catch (error) { this.applied = false; throw error }
      this.providers.delete(owned)
    }
  }
  private mutationReplyBudget(entry: ManagedSkillEntry | null, version: SkillEditVersion): void {
    this.reply({ persisted: true, applied: false, version, entry })
  }
  private reply<T>(value: T, sample = false): T {
    if (Buffer.byteLength(JSON.stringify(value)) > (sample ? this.sampleLimits.maxReplyBytes : this.input.limits.maxReplyBytes)) {
      throw this.capacity()
    }
    return value
  }
  private capacity(): CloudApiError { return new CloudApiError('cloud/capacity', 'The complete skill operation exceeds its installed finite budget.') }
  private active(): void { this.control.signal.throwIfAborted(); this.saves.binding.lifetime.throwIfAborted() }
}
