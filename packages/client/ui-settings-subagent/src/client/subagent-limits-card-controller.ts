/** Staged delegation limits backed by the Host's subagent settings section. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Host-owned delegation defaults and live capacity. */
export interface SubagentLimitsSettings {
  maxDepth: number
  maxActiveSubagents: number
}

/** Effective values and drafts presented by the limits card. */
export interface SubagentLimitsCardState extends SettingsFormShell {
  /** Whether the native account policy supplies each field. */
  allowMaxDepth?: boolean
  allowMaxActiveSubagents?: boolean
  maxDepth: SettingsFieldState
  maxActiveSubagents: SettingsFieldState
}

/** Actions and observable state bound by the slot renderer. */
export interface SubagentLimitsCardFace extends SettingsFormActions {
  hooks: {
    subagentLimitsCard: SnapshotStore<SubagentLimitsCardState>
  }
}

function limitField(field: keyof SubagentLimitsSettings, minimum: number): SettingsFieldSpec {
  const numeric = settingsNumberField(field)
  return {
    ...numeric,
    parse: (text) => {
      const write = numeric.parse(text)
      if (write?.kind !== 'set') return write
      const value = write.value as number
      return Number.isSafeInteger(value) && value >= minimum && !Object.is(value, -0) ? write : undefined
    },
  }
}

/** Bind two independently resettable limits to one staged settings form. */
export class SubagentLimitsCardController {
  private active = true
  private readonly form: SettingsFormModel<SubagentLimitsSettings>
  private readonly store: SnapshotStore<SubagentLimitsCardState>

  /** @param scope - The Host's `subagent` settings section. */
  constructor(private readonly scope: SettingsFormScope<SubagentLimitsSettings>, private readonly fields?: readonly string[]) {
    this.form = new SettingsFormModel(scope, [limitField('maxDepth', 0), limitField('maxActiveSubagents', 1)])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      allowMaxDepth: this.allowed('maxDepth'),
      allowMaxActiveSubagents: this.allowed('maxActiveSubagents'),
      maxDepth: this.form.field('maxDepth'),
      maxActiveSubagents: this.form.field('maxActiveSubagents'),
    }))
  }

  private allowed(field: string): boolean {
    if (!this.active) return false
    if (this.fields === undefined) return true
    const value = this.scope.getSnapshot().value
    return this.fields.includes(field) && value !== undefined && Object.hasOwn(value, field)
  }

  /**
   * Bind the limits editor to the slot renderer.
   * @returns The limits snapshot and staged write actions.
   */
  inject(): SubagentLimitsCardFace {
    const actions = this.form.actions()
    return { hooks: { subagentLimitsCard: this.store }, ...actions,
      edit: (field, text) => { if (this.allowed(field)) actions.edit(field, text) },
      resetField: (field) => { if (this.allowed(field)) actions.resetField(field) },
      save: () => { if (this.active && (this.fields === undefined || this.fields.every(field => this.allowed(field)))) actions.save() } }
  }
  /** Release accepted-value subscriptions. */
  dispose(): void { this.active = false; this.form.dispose() }

}
