// @vitest-environment jsdom
/** Original public SlotRegistry, framework Session type, and real public primitives; navigation is a captured callback fixture. */
import { useState } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionId as NativeSessionId } from '@deepseek-ai/dsh-session/types'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { installCloudServicePreviews, type CloudServicePreviewPage } from '../src/client/service-previews.ts'
import { ServicePreviewRow, type ServicePreviewRowProps } from '../src/client/ServicePreviewRow.tsx'
import { SERVICE_PREVIEW_NAMESPACE } from '../src/client/service-preview-locales.ts'
import { cloudServicePreviewMeta, type CloudServicePreviewNavigation } from '../src/client/service-preview.ts'

expectTypeOf<ServicePreviewRowProps['sessionId']>().toEqualTypeOf<NativeSessionId>()
const id = SessionId('framework-original-session')
const meta = { kind: 'cloud-dev-service-v1', action: 'status', serviceHandle: 'recorded-service', processSubmitted: true }
function resultBlock(value: unknown, isError = false): ToolResultNode {
  return { kind: 'tool-result', seq: 0, time: 0, callId: 'call', name: 'dev_service', args: PartialArguments.EMPTY,
    callTime: 0, call: { name: 'dev_service', argsRaw: '{}' }, content: [{ type: 'text', text: 'process observation' }],
    isError, meta: value, subCalls: [] }
}
const useDisclosure = () => { const [expanded, set] = useState(false); return { expanded, toggle: () => { set(value => !value) } } }
function Host(_props: PropsRenderSlots<'tool.call.toolview'>) { return null }
afterEach(cleanup)

async function fixture(options: { absent?: boolean; disabled?: boolean; locale?: 'en' | 'zh' } = {}) {
  const ctx = new Context(); await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx, undefined, { preference: options.locale ?? 'en', languages: [options.locale ?? 'en'] }))
  const pageLife = new AbortController(), navigate = vi.fn<CloudServicePreviewNavigation>()
  const page: CloudServicePreviewPage = { bootstrap: { capabilities: { servicePreview: options.disabled
    ? { state: 'disabled', reason: 'not-approved' } : { state: 'available' } } },
  lifetime: { transport: { signal: pageLife.signal } }, ...(options.absent ? {} : { servicePreviewNavigation: navigate }) }
  const fiber = ctx.plugin({ apply(owner: Context) { installCloudServicePreviews(owner, page) } }); await fiber.await()
  onTestFinished(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  const declare = () => ctx.slots.register({ name: 'root', children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } }, Host)
  const entry = () => ctx.slots.entries('tool.call.toolview').find(item => item.options.key === 'dev_service')
  const action = (overrides: Partial<ServicePreviewRowProps> = {}, sessionId = id) => {
    const actual = entry(); if (actual?.inject === undefined) throw new Error('Actual native preview row did not register')
    const injected = actual.inject()
    const props = { ...injected, sessionId, useDisclosure, toolName: 'dev_service', callId: 'call', phase: 'result',
      block: resultBlock(meta), t: ctx.locale.bind(SERVICE_PREVIEW_NAMESPACE), ...overrides } as ServicePreviewRowProps
    const Component = actual.component as typeof ServicePreviewRow
    return <Component {...props} />
  }
  return { ctx, pageLife, navigate, fiber, declare, entry, action }
}

it('does not register a preview row without the actual original page carrier or approved capability', async () => {
  for (const options of [{ absent: true }, { disabled: true }]) {
    const f = await fixture(options); f.declare(); expect(f.entry()).toBeUndefined(); expect(f.navigate).not.toHaveBeenCalled()
  }
})

it.each(['en', 'zh'] as const)('uses public primitives and sends only framework SessionId plus task handle through the original %s page callback', async (locale) => {
  const f = await fixture({ locale }); expect(f.entry()).toBeUndefined(); const remove = f.declare()
  await waitFor(() => { expect(f.entry()).toBeDefined() }); const view = render(f.action())
  const label = locale === 'en' ? 'Open controlled preview' : '打开受控预览'
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith({ sessionId: id, serviceHandle: 'recorded-service' })
  expect(Object.isFrozen(f.navigate.mock.calls[0]![0])).toBe(true)
  expect(view.container.querySelector('a')).toBeNull(); expect(view.container.querySelector('pre')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Development service' : '开发服务' }))
  expect(view.container.querySelector('pre')?.textContent).toBe('process observation')
  remove(); fireEvent.click(screen.getByRole('button', { name: label })); expect(f.navigate).toHaveBeenCalledTimes(1)
  f.declare(); expect(f.entry()).toBeDefined()
})

it('keeps callbacks scoped to each framework Session and withdraws stale mounted actions on page revocation', async () => {
  const f = await fixture(), remove = f.declare(), other = SessionId('other-framework-session')
  render(f.action({}, other)); fireEvent.click(screen.getByRole('button', { name: 'Open controlled preview' }))
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith({ sessionId: other, serviceHandle: 'recorded-service' })
  await act(async () => { f.pageLife.abort() })
  await waitFor(() => { expect(f.entry()).toBeUndefined() })
  fireEvent.click(screen.getByRole('button', { name: 'Open controlled preview' })); expect(f.navigate).toHaveBeenCalledTimes(1)
  remove(); f.declare(); expect(f.entry()).toBeUndefined()
})

it('hides the action for missing or malformed metadata, foreign tools, non-submitted and failed results', async () => {
  const f = await fixture(); f.declare()
  for (const value of [undefined, null, { ...meta, processSubmitted: false }, { ...meta, kind: 'other' },
    { ...meta, serviceHandle: 'x'.repeat(65) }, { ...meta, url: 'https://forbidden.invalid' }, { ...meta, action: 'stop' }]) {
    const view = render(f.action({ block: resultBlock(value) }))
    expect(screen.queryByRole('button', { name: 'Open controlled preview' })).toBeNull(); view.unmount()
    expect(cloudServicePreviewMeta(value)).toBeUndefined()
  }
  const failed = render(f.action({ block: resultBlock(meta, true) }))
  expect(screen.queryByRole('button', { name: 'Open controlled preview' })).toBeNull(); failed.unmount()
  render(f.action({ toolName: 'other' })); expect(screen.queryByRole('button', { name: 'Open controlled preview' })).toBeNull()
})
