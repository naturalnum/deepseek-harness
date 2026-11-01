/** Approved configuration rendered inside the original native plugin detail page. */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { AccountPluginId, PluginManagementInjected } from './types.ts'
import { PluginEditPanel } from './PluginEditPanel.tsx'
import type {} from './locales.ts'

/** The section uses the existing account catalog and edit owner. */
export type NativePluginConfigurationProps = PropsRuntime<'plugins.detail.section'> & PropsLocale<'cloud-plugin-management'>
  & InjectFace<PluginManagementInjected & { readonly configurationId: (subject: PluginsSubject) => AccountPluginId | undefined }>

/** Show only a configuration that maps to one approved actual native subject. */
export function NativePluginConfigurationSection(props: NativePluginConfigurationProps): ReactNode {
  const catalog = props.useAccountPluginCatalog(value => value)
  const id = props.configurationId(props.subject)
  if (id === undefined) return null
  if (catalog.editor?.id === id) return <PluginEditPanel editor={catalog.editor} t={props.t}/>
  const row = catalog.plugins.find(item => item.id === id)
  const disabled = catalog.phase !== 'ready' || catalog.refreshing || catalog.editor !== undefined
    || row?.configuration !== 'available' || props.openPluginConfiguration === undefined
  return <Button size="sm" disabled={disabled} onClick={() => { props.openPluginConfiguration?.(id) }}>
    {props.t('configure')}
  </Button>
}
