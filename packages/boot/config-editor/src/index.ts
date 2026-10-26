/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service, resolveConfig } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import {
  composeProfileEntries, loadProfileDirectory, readProfilePatches, reconcileProfilePatches,
  prepareProfileConfigUpdate, prepareProfilePluginUpdate, assertProfileConfigUpdate, withProfileConfigUpdate, type ProfileConfigUpdatePlan,
} from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

/** Admission and observation of an explicitly instrumented native save submission. */
export interface ConfigSaveSubmissionHook {
  /**
   * Decide admission synchronously before invoking submit or entering a writer queue.
   * Accepted work must retain its result and rejection through required application;
   * invoke submit at most once and observe the Promise it returns.
   * @param writer - native writer identifier, without config values or secrets.
   * @param submit - actual queue submission, including required write and reconciliation.
   * @returns the operation's result after the hook's admitted work settles.
   */
  submit<T>(writer: string, submit: () => Promise<T>): Promise<T>
}

/** Native authorization recheck at the actual edit and replacement points. */
export interface ConfigEditControl {
  /** Reject an ended caller before persistence; called again after awaited policy work. */
  assertCurrent(): void
  /** Trusted Host selection of the bounded native leaf planner; omission retains live-only edits. */
  readonly maxRemountRegistryEntries?: number
  /** Approve the actual native plan before persistence; omission grants no additional impact.
   * @param plan Original prepared profile decision.
   */
  check?(plan: ProfileConfigUpdatePlan): void | Promise<void>
}

/** Host policy checked against a native prepared profile decision before persistence. */
export interface ConfigImpactGuard {
  /**
   * Approve or reject the native plan; approval cannot grant an unsupported impact.
   * @param plan - opaque native entry identities, versions and impact decisions.
   * @returns Completion of the policy check; rejection leaves the profile unwritten.
   */
  check(plan: ProfileConfigUpdatePlan): void | Promise<void>
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']
  private saveHook: ConfigSaveSubmissionHook | undefined
  private impactGuard: ConfigImpactGuard | undefined
  private readonly saveScopes = new AsyncLocalStorage<{ active: boolean }>()
  private readonly editFailures = new WeakMap<object, 'not-published' | 'unknown'>()

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /**
   * Install one live-only impact policy for actual edits through this editor.
   * Without a guard the original reconciliation and rollback path is unchanged.
   * @param guard - policy for the native plan, without a cloud field allowlist.
   * @returns awaitable disposer; caller unload removes the guard.
   * @throws If another impact guard is installed.
   */
  registerImpactGuard(guard: ConfigImpactGuard): () => Promise<void> {
    const dispose = this.ctx.effect(() => {
      if (this.impactGuard !== undefined) throw new Error('config-editor: an impact guard is already registered')
      this.impactGuard = guard
      return () => { this.impactGuard = undefined }
    }, 'config-editor: impact guard')
    return () => Promise.resolve(dispose())
  }

  /**
   * Install the sole hook for explicit save submissions through this editor.
   * The caller must stop and settle protected writers before withdrawing the hook.
   * Nested submissions in one admitted operation share its hook and completion.
   * @param hook - synchronous admission and Promise observation owned by the caller.
   * @returns awaitable disposer; caller unload also removes the hook.
   * @throws If a hook is already installed.
   */
  registerSaveHook(hook: ConfigSaveSubmissionHook): () => Promise<void> {
    const dispose = this.ctx.effect(() => {
      if (this.saveHook !== undefined) throw new Error('config-editor: a save submission hook is already registered')
      this.saveHook = hook
      return () => { this.saveHook = undefined }
    }, 'config-editor: save submission hook')
    return () => Promise.resolve(dispose())
  }

  /**
   * Submit one instrumented save before its writer enters any private queue.
   * Without a hook, invoke submit directly and return its original Promise.
   * Nested submissions through the same editor share the admitted operation;
   * callers must await all nested work. A continuation after settlement submits anew.
   * @param writer - native writer identifier, without config values or secrets.
   * @param submit - actual queue submission and all required write/application work.
   * @returns the original operation Promise, or the hook's admitted operation Promise.
   * @throws If synchronous admission rejects the submission.
   */
  submitSave<T>(writer: string, submit: () => Promise<T>): Promise<T> {
    if (this.saveHook === undefined || this.saveScopes.getStore()?.active === true) return submit()
    return this.saveHook.submit(writer, () => {
      const scope = { active: true }
      let operation: Promise<T>
      try { operation = this.saveScopes.run(scope, submit) } catch (error) {
        scope.active = false
        throw error
      }
      void operation.then(() => { scope.active = false }, () => { scope.active = false })
      return operation
    })
  }

  /** Read this editor's actual guarded replacement disposition without changing the original rejection.
   * @param error Exact object rejected by a guarded edit; copied or unrelated errors have no receipt.
   * @returns Not-published before atomic replacement, unknown after it was entered, or undefined for unobserved errors.
   */
  editFailureOutcome(error: unknown): 'not-published' | 'unknown' | undefined {
    return error !== null && typeof error === 'object' ? this.editFailures.get(error) : undefined
  }

  /** The profile patch edited by this service. */
  get documentPath(): string { return this.ownerContext.profileContext.patchPath }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor, { readOnly: true })
    const entries = this.entries()
    // An own config key can replace inherited config even when its value is undefined.
    const overridden = new Set(loaded.patches.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeProfileEntries(this.ownerContext.root, readProfilePatches('dsh', profile, loaded)))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((loaded.patches.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
    }))
  }

  private inherited(entry: Entry, loaded: ReturnType<typeof loadProfileDirectory>): Record<string, unknown> {
    const patches = loaded.patches.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeProfileEntries(this.ownerContext.root, readProfilePatches('dsh', this.ownerContext.profileContext, { ...loaded, patches }))).find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * An impact guard selects the live path; an explicit trusted Host control may select the bounded optional-leaf planner.
   * Unsupported native plans reject before writing.
   * A required post-replacement failure remains failed with its committed state for caller diagnosis;
   * that path never falls back to an unguarded rollback or remount.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @param control Optional original caller recheck; omission preserves ordinary native edits.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
    control?: ConfigEditControl,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const path = this.documentPath
      const guard = this.impactGuard
      const publication = { entered: false }
      try {
        control?.assertCurrent()
        await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
          if (!this.entries().includes(entry) || control?.maxRemountRegistryEntries === undefined && entry.fiber === undefined) {
            throw new Error('Configuration entry is no longer available')
          }
          const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
          if (guard === undefined) await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          else if (control?.maxRemountRegistryEntries === undefined && entry.fiber?.runtime?.Config !== undefined) {
            entry.assertConfigUpdateSupported()
          }
          if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
          const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
          const inherited = this.inherited(entry, loadProfileDirectory('dsh', this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor, { readOnly: guard !== undefined }))
          const next = change(current, inherited)
          const fiber = entry.fiber
          if (control?.maxRemountRegistryEntries === undefined && fiber?.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
          if (guard === undefined) {
            if (fiber === undefined) throw new Error('Configuration plugin is no longer active')
            const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
            resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
          }
          let before: string
          try { before = await readFile(path, 'utf8') }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            before = '[]\n'
          }
          const document = parseDocument(before, {
            customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
          })
          if (document.errors[0] !== undefined) throw document.errors[0]
          if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
          document.contents.flow = false
          const index = document.contents.items.findLastIndex((item, index) => isMap(item)
            && document.getIn([index, 'id']) === entry.options.id && !item.has('insert')
            && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
          if (isDeepStrictEqual(next, inherited)) {
            for (let index = document.contents.items.length - 1; index >= 0; index--) {
              const row = document.contents.items[index]
              if (!isMap(row) || document.getIn([index, 'id']) !== entry.options.id || row.has('insert')) continue
              row.delete('config')
              if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) document.delete(index)
            }
          } else if (index < 0) document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))
          else document.setIn([index, 'config'], document.createNode(next))
          visit(document, { Map(_key, node) {
            if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
            const expression = new Scalar(node.get('__jsExpr'))
            expression.tag = 'tag:yaml.org,2002:js'
            return expression
          } })
          const profile = this.ownerContext.profileContext
          const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor, { readOnly: true })
          const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
          const effective = flatten(composeProfileEntries(this.ownerContext.root, patches)).find(row => row.id === entry.options.id)
          if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
            throw new Error(`Configuration for "${entry.options.id}" is overridden by a home patch or command-line overlay`)
          }
          if (guard !== undefined) {
            const plan = control?.maxRemountRegistryEntries === undefined
              ? prepareProfileConfigUpdate(this.ownerContext.root, entry, beforePatches, patches)
              : await prepareProfilePluginUpdate(this.ownerContext.root, entry, beforePatches, patches, control.maxRemountRegistryEntries)
            await guard.check(plan)
            await control?.check?.(plan)
            control?.assertCurrent()
            assertProfileConfigUpdate(plan)
            await withProfileConfigUpdate(plan, async () => {
              control?.assertCurrent()
              assertProfileConfigUpdate(plan)
              publication.entered = true
              await writeFileAtomic(path, String(document), { mode: 0o600 })
              assertProfileConfigUpdate(plan, true)
              await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', entry.disabled ? [] : [entry.options.id])
            })
            return
          }
          control?.assertCurrent()
          await writeFileAtomic(path, String(document), { mode: 0o600 })
          try {
            await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', entry.disabled ? [] : [entry.options.id])
          } catch (error) {
            await writeFileAtomic(path, before, { mode: 0o600 })
            await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
            throw error
          }
        })
      } catch (cause) {
        if (guard !== undefined && cause !== null && typeof cause === 'object') {
          // Reusing an error object can only retain the more conservative actual disposition.
          const outcome = publication.entered || this.editFailures.get(cause) === 'unknown' ? 'unknown' : 'not-published'
          this.editFailures.set(cause, outcome)
        }
        throw cause
      }
    }
    await this.submitSave('config-editor/edit', () => {
      const hmr = this.ownerContext.get('hmr')
      return hmr === undefined ? run() : hmr.runExclusive(run)
    })
  }
}

export default ConfigEditor
