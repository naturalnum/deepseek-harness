/** Client data-only ordinary plugin fixtures over the actual generated current DTO. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CloudPluginRemote } from '../src/client/management/plugins/plugin-edit.ts'

/** Stable test-only approved identity, with no production special case. */
export const TEST_PLUGIN_ID = 'execution-tuning'
/** Genuine generated current reply type. */
export type PluginFixtureCurrent = Extract<Awaited<ReturnType<CloudPluginRemote['current']>>, { ok: true }>['value']
/** Native entry fixture with an actual inventory record. */
export type EntryPluginFixtureCurrent = PluginFixtureCurrent & { readonly plugin: NonNullable<PluginFixtureCurrent['plugin']> }
/** Build native ordinary JSON Schema metadata and original raw values.
 * @param token Original private edit token.
 * @param enabled Effective native entry activation.
 * @param value Original literal field value.
 * @param id Original approved catalog identity.
 * @returns Complete public current reply for scripted carriers.
 */
export function pluginFixture(token: string, enabled = false, value: JsonValue = [3, 5, 8],
  id = TEST_PLUGIN_ID): EntryPluginFixtureCurrent {
  return { id, plugin: { entryId: brandString<NonNullable<PluginFixtureCurrent['plugin']>['entryId']>(`include:${id}`),
    moduleName: `@example/${id}`, patchId: id, enabled, fiberPhase: enabled ? 'active' : null,
    meta: { title: { en: `Test ${id}`, zh: `测试 ${id}` }, description: { en: 'Approved plugin metadata', zh: '获批插件元数据' } } },
  selectionTarget: { kind: 'entry', id: `include:${id}` }, operations: ['enabled', 'configure'], maxImpact: 'local',
  configuration: { fields: [{ path: ['limits', 'steps'], schema: { type: 'array', items: { type: 'integer' } },
    writable: true, secrets: [], acceptsMissing: false, limitations: ['Native item validation'], value }] },
  version: { epoch: brandString<PluginFixtureCurrent['version']['epoch']>('epoch-A'),
    editToken: brandString<PluginFixtureCurrent['version']['editToken']>(token) } }
}

/** Test-only preinstalled bundle identity with multiple native members. */
export const TEST_BUNDLE_ID = 'preinstalled-tools'
/** Native bundle fixture without a fabricated PluginInfo. */
export type BundlePluginFixtureCurrent = PluginFixtureCurrent & { readonly bundle: NonNullable<PluginFixtureCurrent['bundle']> }
/** Build native bundle facts independent of profile dependency and actual entry presence.
 * @param token Original private edit token.
 * @param selected Actual native manifest selection.
 * @param id Approved catalog identity.
 * @param facts Native BundleInfo fields to override explicitly.
 * @returns A complete bundle current reply with no PluginInfo.
 */
export function bundleFixture(token: string, selected = false, id = TEST_BUNDLE_ID,
  facts: Partial<NonNullable<PluginFixtureCurrent['bundle']>> = {}): BundlePluginFixtureCurrent {
  const bundle: NonNullable<PluginFixtureCurrent['bundle']> = { name: '@example/preinstalled-tools', official: true,
    availability: 'installation', version: '1.2.3', enabled: selected, installed: false, optional: true, removable: false,
    rows: [{ rowId: 'provider', moduleName: '@example/provider' }, { rowId: 'consumer', moduleName: '@example/consumer' }], overrides: [],
    meta: { title: { en: 'Preinstalled tools', zh: '预安装工具' }, description: { en: 'Native bundle metadata', zh: '原生插件包元数据' } }, ...facts }
  return { id, bundle, selectionTarget: { kind: 'bundle', name: bundle.name }, operations: ['selected'], maxImpact: 'graph',
    configuration: { fields: [] }, version: pluginFixture(token).version }
}
