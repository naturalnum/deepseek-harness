/** The original settings roster store with admitted public reads and no write operations. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AgentPresetCompositionSummary, AgentPresetSettingsIntegration } from './integration.ts'
import type { AgentPresetSectionState } from './section-store.ts'

/** Own one page's asynchronous reads and its public composition viewer. */
export class ReadonlyAgentPresetSectionController {
  /** Stable original-section source with no default-selection writes. */
  readonly store = createSnapshotStore<AgentPresetSectionState>({ status: 'idle', error: null, saving: false, rows: [], view: null })
  private current = true
  private loading: Promise<void> | undefined
  private summaries: readonly AgentPresetCompositionSummary[] = []
  constructor(private readonly reads: AgentPresetSettingsIntegration, private readonly unavailable: () => string) {}

  private accepts(): boolean { return this.current && this.reads.isCurrent() }

  /** Read actual account summaries once per explicit load; concurrent loads share the read.
   * @returns When the current read settles; retired-page results are ignored.
   */
  load(): Promise<void> {
    if (!this.accepts()) return Promise.resolve()
    return this.loading ??= this.read().finally(() => { this.loading = undefined })
  }
  private async read(): Promise<void> {
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', error: null })
    try {
      const summaries = await this.reads.list()
      if (!this.accepts()) return
      this.summaries = summaries
      this.store.set({ ...this.store.getSnapshot(), status: 'ready', error: null,
        rows: summaries.map(({ id, name, description, isDefault, broken }) => ({ id, isDefault,
          ...name === undefined ? {} : { name }, ...description === undefined ? {} : { description },
          ...broken === undefined ? {} : { broken } })) })
    } catch {
      if (!this.accepts()) return
      this.summaries = []
      this.store.set({ status: 'error', error: this.unavailable(), saving: false, rows: [], view: null })
    }
  }

  /** Inspect only public facts from the last accepted roster.
   * @param id Identity from that roster.
   * @returns When the original viewer state has been updated.
   */
  view(id: string): Promise<void> {
    if (!this.accepts()) return Promise.resolve()
    const row = this.summaries.find(summary => summary.id === id)
    if (row === undefined) return Promise.resolve()
    this.store.set({ ...this.store.getSnapshot(), view: { id: row.id, title: row.name ?? row.id, content: '',
      composition: row.rows.map(({ entryId, moduleName, enabled, fiberPhase }) => ({ entryId, moduleName, enabled, fiberPhase })) } })
    return Promise.resolve()
  }
  /** Close the public composition viewer without reading another page. */
  closeView(): void { if (this.current) this.store.set({ ...this.store.getSnapshot(), view: null }) }
  /** Revoke the controller; later read responses cannot update its store. */
  dispose(): void { this.current = false }
}
