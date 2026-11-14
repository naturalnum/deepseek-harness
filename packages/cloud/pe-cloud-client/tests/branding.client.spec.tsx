// @vitest-environment jsdom
import { cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { zh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { installCloudBrand } from '../src/client/branding.tsx'
import { CLOUD_BRAND_NAMESPACE } from '../src/client/branding-locales.ts'

afterEach(cleanup)

it.each([['en', 'DSH Local Build'], ['zh', 'DSH 本地构建']])(
  'keeps the %s native brand while Cloud fills and withdraws its own brand', async (language, nativeBrand) => {
    const runtime = await SlotTestRuntime.create()
    try {
      const locale = new LocaleRuntime(runtime.ctx)
      locale.register('common', { zh, en })
      runtime.ctx.provide('locale', locale)
      runtime.slots.installLocale(locale)
      locale.setLocale(language)
      expect(locale.bind('common')('brand.localBuild')).toBe(nativeBrand)
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
      expect(locale.bind('common')('brand.localBuild')).toBe(nativeBrand)
      expect(locale.bind(CLOUD_BRAND_NAMESPACE)('brandName')).toBe('brandName')
    } finally { await runtime.dispose() }
  },
)
