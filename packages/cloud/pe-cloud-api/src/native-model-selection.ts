/** Account policy projection over the original native model catalog and selection. */
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { CloudApiError } from './errors.ts'
import { firstScreenJsonBytes } from './first-screen-json.ts'

/** Same immutable Root route decisions used by actual account LLM execution. */
export interface NativeModelSelectionPolicy {
  /** Whether the exact provider/model route is approved for this account. */
  readonly allowedModel: (provider: string, model: string) => boolean
  /** Whether the provider has any approved route, including while its catalog is unavailable. */
  readonly allowedProvider: (provider: string) => boolean
}

/**
 * Require an approved route before native Session resume or model selection mutates state.
 * The native LLM resolver remains responsible for model availability and reasoning effort.
 * @param selection Original client selection or native deployment default.
 * @param policy Same Root-approved route policy used by native execution.
 * @throws CloudApiError when the exact route is outside the account policy.
 */
export function assertNativeModelRoute(selection: ModelSelection, policy: NativeModelSelectionPolicy): void {
  if (!policy.allowedProvider(selection.provider) || !policy.allowedModel(selection.provider, selection.model)) {
    throw new CloudApiError('cloud/model-not-allowed', 'The model route is not approved for this account.')
  }
}

/**
 * Retain approved rows from the original native catalog without replacing model or reasoning metadata.
 * The complete native result is bounded before filtering; an unavailable approved provider keeps its
 * native failure row, while unapproved providers and model routes never reach the browser.
 * @param value Original SessionController.modelCatalog result.
 * @param policy Same Root-approved route policy used by native execution.
 * @param maxCollectionItems Existing positive account collection limit, applied to each native list.
 * @param maxFrameBytes Existing positive account complete JSON byte limit.
 * @returns Native catalog fields restricted to approved provider/model rows.
 * @throws CloudApiError for an unapproved default or a result exceeding the selected limits.
 */
export function projectNativeModelCatalog(
  value: ModelCatalog, policy: NativeModelSelectionPolicy, maxCollectionItems: number, maxFrameBytes: number,
): ModelCatalog {
  if (!Number.isSafeInteger(maxCollectionItems) || maxCollectionItems < 1) {
    throw new CloudApiError('cloud/invalid-config', 'Native model reads require an explicit finite collection limit.')
  }
  firstScreenJsonBytes(value, maxFrameBytes)
  const lists: readonly (readonly unknown[])[] = [value.groups, value.failures, value.routableProviders,
    ...value.groups.flatMap(group => [group.models, ...group.models.flatMap(model => model.reasoning === undefined
      ? [] : [model.reasoning.efforts])])]
  if (lists.some(rows => rows.length > maxCollectionItems)) {
    throw new CloudApiError('cloud/capacity', 'The native model catalog exceeds its selected collection limit.')
  }
  assertNativeModelRoute(value.default, policy)
  const groups = value.groups.filter(group => policy.allowedProvider(group.id))
    .map(group => ({ ...group, models: group.models.filter(model => policy.allowedModel(group.id, model.id)) }))
    .filter(group => group.models.length !== 0)
  const providers = new Set(groups.map(group => group.id))
  return { ...value, groups, routableProviders: value.routableProviders.filter(id => providers.has(id)),
    failures: value.failures.filter(row => policy.allowedProvider(row.id)) }
}
