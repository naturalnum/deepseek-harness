// @vitest-environment jsdom
/** Exercise the standalone browser entry with the actual React renderer. */
import type { Root } from 'react-dom/client'
import { act, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const roots = vi.hoisted(() => [] as Root[])
vi.mock('react-dom/client', async (original) => {
  const renderer = await original<typeof import('react-dom/client')>()
  return { ...renderer, createRoot: (...args: Parameters<typeof renderer.createRoot>) => {
    const root = renderer.createRoot(...args); roots.push(root); return root
  } }
})
const title = document.title
const lang = document.documentElement.lang
afterEach(() => {
  act(() => { roots.splice(0).forEach((root) =>{  root.unmount() }) })
  document.body.replaceChildren(); document.title = title; document.documentElement.lang = lang
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

it.each([{ language: 'zh-CN', hash: '#admin', copy: zh, expected: 'zh' },
  { language: 'en-US', hash: '#password', copy: en, expected: 'en' }])('mounts the $language trusted entry and renders its localized login', async ({ language, hash, copy, expected }) => {
  vi.resetModules()
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)
  window.history.replaceState(null, '', hash)
  const mount = document.createElement('div'); mount.id = 'account-root'; document.body.append(mount)
  await act(async () => { await import('../src/trusted/main.tsx') })
  expect(document.documentElement.lang).toBe(expected)
  expect(document.title).toBe(copy.account)
  expect(screen.getByRole('heading', { name: copy.accountLogin })).toBeTruthy()
  expect(screen.getByRole('button', { name: copy.login })).toBeTruthy()
})

it('refuses an absent trusted mount instead of rendering an unrelated document', async () => {
  vi.resetModules()
  await expect(import('../src/trusted/main.tsx')).rejects.toThrow('Missing trusted account mount')
})
