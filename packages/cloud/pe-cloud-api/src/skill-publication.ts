/** One API-owned native selector; original AccountSaves and files retain persistence and actual work. */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl, SkillProviderObservation, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { SkillCurrent, SkillVersion, SkillVersionPort } from '@deepseek-ai/dsh-pe-cloud-files'
import { FdMutationFailure } from '@deepseek-ai/dsh-pe-cloud-files'
import { ConfigSaveOutcomeUnknown, SkillEditApplyFailure } from './config-saves.ts'
import type { ConfigSaveBarrier, SkillEditVersion } from './save-hooks.ts'
import { CloudApiError } from './errors.ts'
import { skillProviderFor, type SkillResourcePreparation } from './skill-source.ts'
import type { SkillCurrentState, SkillPublicationLimits, SkillPublishResult, SkillVersionMetadata } from './skill-types.ts'

function metadata(version: SkillVersion): SkillVersionMetadata {
  return { id: version.id, skillSha256: version.skillSha256, resourceSha256: version.resourceSha256,
    skillBytes: version.skillBytes, resourceBytes: version.resourceBytes }
}

/** Fixed native providers for bounded immutable handles, with no new revision, queue or drain participant. */
export class AccountSkillPublication implements SkillProvider {
  /** Native registration identity for the account's one controlled pointer. */
  readonly name = 'account-published-skills'
  private visible: SkillCurrent | undefined
  private applied: boolean = false
  private readonly retained = new Map<SkillVersion, SkillProvider>()

  constructor(private readonly ctx: Context, private readonly control: SkillProviderControl,
    private readonly saves: ConfigSaveBarrier, private readonly port: SkillVersionPort, private readonly limits: SkillPublicationLimits,
    private readonly resources?: SkillResourcePreparation) {}

  /**
   * Read the real durable pointer in the original account submission turn.
   * @param check Repeated original Peer/Use/exposure check; contains observer cancellation before I/O.
   * @param signal Original observer signal.
   * @returns Native pointer facts and an opaque token whose expected native FsVersion stays in AccountSaves.
   */
  async current(check: () => void, signal: AbortSignal): Promise<SkillCurrentState> {
    const result = await this.saves.describeSkillEdit(async () => {
      const held = await this.port.current(signal)
      try { return { value: held.value === undefined ? null : metadata(held.value.version), revision: held.value?.revision ?? null } }
      finally { held.release() }
    }, () => { this.assertActive(); check() })
    const applied = this.applied && result.value !== null && result.value.id === this.visible?.version.id
    return { slot: 'sample', current: result.value, version: result.version, applied,
      resources: applied && this.resources !== undefined ? 'project-on-load' : 'unavailable' }
  }

  /**
   * Prepare both files and CAS the pointer with the original read's real FsVersion.
   * @param edit Original opaque edit, never a native revision from JSON.
   * @param markdown Complete bounded SKILL.md input.
   * @param resource Complete owned resource backing, retained through actual settlement.
   * @param check Original Peer/Use/exposure check inside the save turn and before commit.
   * @param signal Observer cancellation may refuse before commit; confirmed handoff always finishes native apply.
   * @returns Separate confirmed persistence/catalog-apply facts, or unknown with original responsibility retained.
   */
  async publish(edit: SkillEditVersion, markdown: string, resource: Uint8Array<ArrayBuffer>,
    check: () => void, signal: AbortSignal): Promise<SkillPublishResult> {
    let committed: SkillCurrent | undefined
    let handoff: { readonly value: SkillCurrent; release(): void } | undefined
    let provider: SkillProvider | undefined
    try {
      const version = await this.saves.commitSkillEdit(edit, async (expected) => {
        if (this.retained.size >= this.limits.maxRetainedVersions) return { persisted: false,
          error: new CloudApiError('cloud/capacity', 'The retained skill version budget is full.') }
        try {
          const prepared = await this.port.prepare({ skillMarkdown: markdown, resource }, signal)
          const exactVersion = prepared.value
          // The exact handle remains files-issued; release prepare residence before borrowing a new source snapshot.
          prepared.release()
          check()
          if (exactVersion.binding !== this.saves.binding) throw new ConfigSaveOutcomeUnknown()
          provider = skillProviderFor(this.ctx, this.control, this.port, exactVersion, this.resources?.materialize)
          this.retained.set(exactVersion, provider)
          const listed = await provider.list({ signal })
          const rows = 'candidates' in listed ? listed.candidates : listed
          if (rows.length !== 1 || rows[0]?.name !== 'sample' || !rows[0].invocation.userInvocable
            || 'candidates' in listed && !listed.complete) {
            return { persisted: false, error: new CloudApiError('cloud/forbidden', 'Only one complete native sample skill is accepted.') }
          }
          check()
          handoff = await this.port.commit(exactVersion, expected, signal)
          committed = handoff.value
          // Nothing observes cancellation or awaits new files work between durable handoff and synchronous apply.
          return { persisted: true, revision: committed.revision }
        } catch (error) {
          if (error instanceof FdMutationFailure && error.outcome === 'not-published') {
            return { persisted: false, error: new CloudApiError(error.code === 'FS_STALE_VERSION'
              ? 'cloud/config-conflict' : 'cloud/account-unavailable', 'The skill pointer was not published; read current state before editing.') }
          }
          throw new ConfigSaveOutcomeUnknown()
        }
      }, () => {
        try {
          if (committed === undefined || provider === undefined || committed.version.binding !== this.saves.binding) {
            throw new Error('The confirmed skill pointer lost its original provider.')
          }
          this.control.signal.throwIfAborted()
          this.applied = false
          this.visible = committed
          this.control.invalidate()
          this.applied = true
        } finally {
          // This synchronous section owns the native handoff; release before any later files mutation is awaited.
          handoff?.release()
          handoff = undefined
        }
      }, () => { this.assertActive(); check() })
      if (committed === undefined) throw new ConfigSaveOutcomeUnknown()
      return { persisted: true, applied: true, version, current: metadata(committed.version),
        resources: this.resources === undefined ? 'unavailable' : 'project-on-load' }
    } catch (error) {
      handoff?.release()
      if (error instanceof SkillEditApplyFailure && committed !== undefined) {
        return { persisted: true, applied: false, version: error.version, current: metadata(committed.version), resources: 'unavailable' }
      }
      if (error instanceof ConfigSaveOutcomeUnknown) return { persisted: 'unknown', applied: false, resources: 'unavailable' }
      throw error
    }
  }

  /**
   * Reconstruct only a complete current native catalog during trusted unpublished assembly.
   * @param check Actual graph installation check; this does not publish business readiness.
   * @returns Actual files/source settlement and synchronous registry invalidation.
   */
  restore(check: () => void): Promise<void> {
    return this.saves.admit('skill-publish', async () => {
      this.assertActive(); check()
      const held = await this.port.current(this.saves.binding.lifetime)
      let current: SkillCurrent | undefined
      try { current = held.value } finally { held.release() }
      // The exact immutable handle remains files-issued after the observation's residence is released.
      if (current === undefined) return
      let provider = this.retained.get(current.version)
      if (provider === undefined) {
        if (this.retained.size >= this.limits.maxRetainedVersions) throw new CloudApiError('cloud/capacity', 'The retained skill provider budget is full.')
        provider = skillProviderFor(this.ctx, this.control, this.port, current.version, this.resources?.materialize)
        this.retained.set(current.version, provider)
      }
      const result = await provider.list({ signal: this.saves.binding.lifetime })
      const rows = 'candidates' in result ? result.candidates : result
      if (rows.length !== 1 || rows[0]?.name !== 'sample') throw new Error('The durable sample catalog is unavailable.')
      check(); this.control.signal.throwIfAborted(); this.retained.set(current.version, provider)
      this.applied = false; this.visible = current; this.control.invalidate(); this.applied = true
    })
  }

  /** Discover through the current complete native provider without requiring a live Agent.
   * @param options Original cold-standing or live native view.
   * @returns Native candidates after actual source work settles in the original save turn.
   */
  list(options: SkillViewOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    return this.saves.admit('skill-projection', async () => {
      this.assertActive()
      const current = this.visible, provider = current === undefined ? undefined : this.retained.get(current.version)
      if (provider === undefined) return { candidates: [], complete: true }
      const result = await provider.list(options)
      const observation = 'candidates' in result ? result : { candidates: result, complete: true }
      return observation
    })
  }

  /** Load through the native provider only when original project admission and complete projection are supplied.
   * @param candidate Native selected candidate; never authority for a private path.
   * @param options Original view; a standing scope alone cannot authorize a project resource.
   * @returns The original native skill after complete authorized projection; absent preparation rejects before source I/O.
   */
  get(candidate: SkillCandidate, options: SkillViewOptions): Promise<SkillDefinition | undefined> {
    return this.saves.admit('skill-projection', async () => {
      const current = this.visible, provider = current === undefined ? undefined : this.retained.get(current.version)
      const resources = this.resources
      try {
        this.assertActive()
        if (resources === undefined || provider === undefined) throw new CloudApiError('cloud/forbidden', 'Account skill project resources are unavailable.')
        resources.assertCaller(options)
      } catch (error) { return { ok: false as const, error } }
      return { ok: true as const, value: await provider.get(candidate, options) }
    }).then((result) => { if (!result.ok) throw result.error; return result.value })
  }

  private assertActive(): void {
    this.ctx.fiber.assertActive(); this.control.signal.throwIfAborted(); this.saves.binding.lifetime.throwIfAborted()
  }

}
