/** Private per-graph exposure audit beneath the deployment's immutable manifest ceiling. */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountBinding } from '@deepseek-ai/dsh-pe-cloud-runtime/types'
import type {} from '@deepseek-ai/dsh-pe-cloud-runtime/account'
import { CloudApiError } from './errors.ts'
import { ExposurePolicy } from './exposure.ts'
import type { EndpointExposure, ExactFetchExposure, ExposureInventory, ExposureManifest } from './types.ts'

function invalidSubset(): never {
  throw new CloudApiError('cloud/invalid-config', 'Account exposure must be an exact subset of the deployment manifest.')
}

function endpoints(upper: readonly EndpointExposure[], selected: readonly EndpointExposure[]): void {
  for (const entry of selected) {
    const approved = upper.find(row => row.endpoint === entry.endpoint)
    if (approved === undefined || approved.handlerId !== entry.handlerId || approved.guard !== entry.guard) invalidSubset()
  }
}

function subset(upper: ExposureManifest, selected: ExposureManifest): void {
  if (upper.recipeVersion !== selected.recipeVersion) invalidSubset()
  endpoints(upper.rpcEndpoints, selected.rpcEndpoints)
  endpoints(upper.streamEndpoints, selected.streamEndpoints)
  for (const entry of selected.exactFetchRoutes) {
    const approved = upper.exactFetchRoutes.find(row => row.method === entry.method && row.path === entry.path)
    if (approved === undefined || approved.handlerId !== entry.handlerId || approved.guard !== entry.guard) invalidSubset()
  }
  for (const entry of selected.allowedSettings) {
    const approved = upper.allowedSettings.find(row => row.namespace === entry.namespace)
    if (approved === undefined || entry.fields.some(field => !approved.fields.includes(field))) invalidSubset()
  }
}

class AccountExposure extends ExposurePolicy {
  constructor(
    private readonly ctx: Context,
    private readonly binding: AccountBinding,
    private readonly assertGraphCurrent: (binding: AccountBinding) => void,
    root: ExposurePolicy,
    manifest: ExposureManifest,
  ) {
    super(manifest)
    subset(root.manifest, this.manifest)
    if (binding.recipeVersion !== this.manifest.recipeVersion) invalidSubset()
    this.assertBinding()
    ctx.effect(() => () => { this.invalidate() }, 'pe-cloud-api: revoke account exposure inventory')
  }

  override audit(inventory: ExposureInventory): void {
    super.invalidate()
    try {
      this.admit()
      super.audit(inventory)
      this.admit()
    } catch (error: unknown) {
      super.invalidate()
      throw error
    }
  }

  override requireRpc(endpoint: string): EndpointExposure {
    this.admit()
    return super.requireRpc(endpoint)
  }

  override requireStream(endpoint: string): EndpointExposure {
    this.admit()
    return super.requireStream(endpoint)
  }

  override requireFetch(method: string, pathname: string): ExactFetchExposure {
    this.admit()
    return super.requireFetch(method, pathname)
  }

  override assertSettingsFields(namespace: string, fields: readonly string[]): void {
    this.admit()
    super.assertSettingsFields(namespace, fields)
  }

  private assertBinding(): void {
    if (this.binding.lifetime.aborted || this.ctx.get('peAccount') !== this.binding || this.ctx.root.get('peAccount') !== this.binding) {
      throw new CloudApiError('cloud/stale-generation', 'The account exposure view belongs to a stale graph binding.')
    }
    this.ctx.fiber.assertActive()
  }

  private admit(): void {
    this.assertBinding()
    this.assertGraphCurrent(this.binding)
    // The trusted callback can close or replace its graph during the same synchronous call.
    this.assertBinding()
  }
}

/**
 * Create an independently audited exposure view for one installed account graph.
 * The root contributes only its frozen manifest ceiling; auditing or invalidating
 * this view never changes root or another graph. Selected declarations must keep
 * the root recipe, transport, handler, guard and exact settings fields. Audits
 * still require the actual mounted inventory; this factory does not produce it
 * or establish readiness. Graph disposal invalidates only this view.
 * @param ctx - owning fiber inside the independent account graph.
 * @param binding - runtime's exact installed AccountBinding, not a request borrow.
 * @param assertGraphCurrent - trusted runtime graph/mount-current; restricted mounting may audit, closed/stale graphs reject.
 * Business-ready is checked separately by Controller, LLM and external AccountUse admission.
 * @param root - deployment-owned policy whose immutable manifest defines the upper bound.
 * @param manifest - this graph's selected subset, copied and frozen before use.
 * @returns an unaudited native-compatible ExposurePolicy owned by this graph.
 * @throws CloudApiError for a recipe/binding mismatch or an account declaration outside the root ceiling.
 */
export function createAccountExposure(
  ctx: Context,
  binding: AccountBinding,
  assertGraphCurrent: (binding: AccountBinding) => void,
  root: ExposurePolicy,
  manifest: ExposureManifest,
): ExposurePolicy {
  return new AccountExposure(ctx, binding, assertGraphCurrent, root, manifest)
}
