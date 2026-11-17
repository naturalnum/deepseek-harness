// @vitest-environment jsdom
/** Cloud copy remains attached to the original Native root through locale changes. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { expect, it } from 'vitest'
import { createWorkspaceDeleteRestriction, workspaceDeletionCopy } from '../src/client/workspace-restriction.ts'

it('resolves every deployment restriction from the original root locale and keeps an English fallback', async () => {
  const root = new Context()
  try {
    const reason = createWorkspaceDeleteRestriction(root)
    expect(reason.message()).toBe(workspaceDeletionCopy.en)
    const locale = new LocaleRuntime(root)
    root.provide('locale', locale)
    for (const [id, copy] of Object.entries(workspaceDeletionCopy)) {
      if (!['en', 'zh'].includes(id)) root.effect(() => locale.addLanguage({ id, label: id, fallback: 'en' }))
      locale.setLocale(id)
      expect(reason.message()).toBe(copy)
    }
  } finally { await root.fiber.dispose() }
})
