// @vitest-environment jsdom
import { cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { zh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { installCloudBrand } from '../src/client/branding.tsx'

afterEach(cleanup)

it('fills the native brand together after declaration and withdraws it with the original Cloud scope', async () => {
  const runtime = await SlotTestRuntime.create()
  try {
    const locale = new LocaleRuntime(runtime.ctx)
    locale.register('common', { zh, en })
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const fiber = await runtime.mount({ apply: installCloudBrand })
    for (const name of ['sidebar.brand.mark', 'sidebar.brand.name'] as const) expect(runtime.slots.entries(name)).toHaveLength(0)
    await runtime.declare({
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'conversation.hero.header': { kind: 'single', scope: 'root' },
    })
    const mark = runtime.renderSlot('sidebar.brand.mark', { size: 24 })
    expect(mark.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
    const name = runtime.renderSlot('sidebar.brand.name', {})
    expect(name.container.textContent).toBe('PowerEvolve')
    expect(runtime.slots.entries('conversation.hero.header')).toHaveLength(1)
    const welcome = runtime.renderSlot('conversation.hero.header', {})
    expect(welcome.container.textContent).toBe('')
    expect(welcome.container.childElementCount).toBe(0)
    await fiber.dispose()
    expect(runtime.slots.entries('conversation.hero.header')).toHaveLength(0)
    for (const name of ['sidebar.brand.mark', 'sidebar.brand.name'] as const) expect(runtime.slots.entries(name)).toHaveLength(0)
  } finally { await runtime.dispose() }
})
