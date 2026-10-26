// @vitest-environment jsdom
/** Original native controls expose explicit modes and outcomes; they never select a submit mode on render. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime/src/translate.ts'
import { PluginEditPanel } from '../src/client/management/plugins/PluginEditPanel.tsx'
import { pluginManagementDictionaries } from '../src/client/management/plugins/locales.ts'
import type { AccountPluginEditor } from '../src/client/management/plugins/types.ts'

afterEach(cleanup)
const en = pluginManagementDictionaries.en, t = makeTranslate(en)
function fixture(patch: Partial<AccountPluginEditor> = {}): AccountPluginEditor {
  return { phase: 'editing', action: 'configure', fields: [{ path: ['limits', 'steps'], schema: { type: 'array' },
    writable: true, secrets: [], acceptsMissing: false, limitations: [], value: [3, 5, 8] }], path: ['limits', 'steps'], valueText: '[3,5,8]', invalid: false,
  chooseField: vi.fn(), editValue: vi.fn(), submit: vi.fn(), close: vi.fn(), ...patch }
}
it('requires an explicit idle or stop choice, carries the ordinary literal field, and disables all submissions while pending', () => {
  const editor = fixture(), view = render(<PluginEditPanel editor={editor} t={t}/>)
  expect(editor.submit).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText(en.literalValue), { target: { value: '[1,2]' } })
  expect(editor.editValue).toHaveBeenCalledExactlyOnceWith('[1,2]')
  fireEvent.click(screen.getByRole('button', { name: en.applyIfIdle }))
  fireEvent.click(screen.getByRole('button', { name: en.stopAndApply }))
  expect(editor.submit).toHaveBeenNthCalledWith(1, 'if-idle')
  expect(editor.submit).toHaveBeenNthCalledWith(2, 'stop-and-apply')
  expect(screen.getByText(en.modeExplanation)).toBeTruthy()
  view.rerender(<PluginEditPanel editor={{ ...editor, phase: 'submitting' }} t={t}/>)
  for (const name of [en.applyIfIdle, en.stopAndApply, en.closeEdit]) expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true)
  expect(screen.getByLabelText(en.literalValue)).toHaveProperty('disabled', true)
})
it.each(['applied', 'accepted-rebuild', 'busy', 'conflict', 'unknown', 'unavailable'] as const)(
  'shows the exact %s result and only permits closing the consumed intent', (outcome) => {
    const editor = fixture({ phase: 'result', outcome }); render(<PluginEditPanel editor={editor} t={t}/>)
    const copy = outcome === 'applied' ? en.changeApplied : outcome === 'accepted-rebuild' ? en.rebuildAccepted
      : outcome === 'busy' ? en.busy : outcome === 'conflict' ? en.editConflict : outcome === 'unknown' ? en.unknown : en.editUnavailable
    expect(screen.getByText(copy)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.applyIfIdle })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.stopAndApply })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.closeEdit })); expect(editor.close).toHaveBeenCalledOnce()
  },
)

it.each(['en', 'zh'] as const)('renders the explicit busy result in %s without a retry or implicit application', (locale) => {
  const editor = fixture({ phase: 'result', outcome: 'busy' }), dictionary = pluginManagementDictionaries[locale]
  render(<PluginEditPanel editor={editor} t={makeTranslate(dictionary)}/>)
  expect(screen.getByRole('alert').textContent).toBe(dictionary.busy)
  expect(editor.submit).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: dictionary.applyIfIdle })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: dictionary.stopAndApply })).toHaveProperty('disabled', true)
})

it('shows ordinary schema and omission limits without an unset or implicit Enter action', () => {
  const editor = fixture({ fields: [{ path: ['group', 'value'], schema: { type: 'integer' }, writable: true, secrets: [], acceptsMissing: 'unknown',
    limitations: ['Native runtime check'] }], path: ['group', 'value'], valueText: '', invalid: true })
  render(<PluginEditPanel editor={editor} t={t}/>)
  expect(screen.getByText(en.missingRuntime)).toBeTruthy()
  expect(screen.getByText(en.resetUnavailable)).toBeTruthy()
  expect(screen.getByText('Native runtime check')).toBeTruthy()
  expect(screen.getByText(en.nativeValidation)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.applyIfIdle })).toHaveProperty('disabled', true)
  fireEvent.keyDown(screen.getByLabelText(en.literalValue), { key: 'Enter' })
  expect(editor.submit).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /reset|restore/i })).toBeNull()
})
it('conceals native secret schema defaults and closes nested volatile ordinary fields', () => {
  const secret = fixture({ fields: [{ path: ['auth'], schema: { type: 'string', default: 'never-render', 'x-cordis': { role: 'secret' } },
    writable: true, secrets: [], acceptsMissing: true, limitations: [] }], path: ['auth'], valueText: '', invalid: true })
  const view = render(<PluginEditPanel editor={secret} t={t}/>)
  expect(screen.getByLabelText(en.literalValue).getAttribute('type')).toBe('password')
  expect(view.container.textContent).not.toContain('never-render')
  expect(screen.getByText(en.secretValue)).toBeTruthy()
  view.rerender(<PluginEditPanel editor={fixture({ fields: [{ path: ['group'], writable: true, secrets: [], acceptsMissing: false, limitations: [], value: {},
    schema: { type: 'object', properties: { live: { type: 'number', 'x-cordis': { volatile: true } } } } }],
  path: ['group'], valueText: '{}', invalid: false })} t={t}/>)
  expect(screen.getByText(en.volatileUnavailable)).toBeTruthy()
  expect(screen.getByLabelText(en.literalValue)).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.applyIfIdle })).toHaveProperty('disabled', true)
})

it('uses native field permissions and redacted set states when the protected schema itself is empty', () => {
  const editor = fixture({ fields: [{ path: ['auth'], schema: {}, writable: false, readOnlyReason: 'protected',
    secrets: [{ path: ['token'], set: true }, { path: ['other'], set: false }], acceptsMissing: 'unknown', limitations: [] }],
  path: ['auth'], valueText: '', invalid: false })
  render(<PluginEditPanel editor={editor} t={t}/>)
  expect(screen.getByLabelText(en.literalValue)).toHaveProperty('disabled', true)
  expect(screen.getByText(en.protectedField)).toBeTruthy()
  expect(screen.getByText(/Secret at \["token"\]: Configured/)).toBeTruthy()
  expect(screen.getByText(/Secret at \["other"\]: Not configured/)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.applyIfIdle })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: en.stopAndApply })).toHaveProperty('disabled', true)
  expect(editor.submit).not.toHaveBeenCalled()
})
