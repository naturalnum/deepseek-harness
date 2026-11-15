// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarkdownText } from './file-presentation-markdown.client.tsx'

afterEach(cleanup)

describe('Markdown file links', () => {
  it('retains uncommon artifact extensions and explicit relative filenames without promoting bare web or version tokens', () => {
    const openFile = vi.fn()
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={'- dataset.dat\n- build.custom\n- notes/example.com\n- example.com\n- v1.2.3'} standaloneFileLinks/>
    </MarkdownDelegateProvider>)
    for (const path of ['dataset.dat', 'build.custom', 'notes/example.com']) {
      fireEvent.click(view.getByRole('button', { name: path }))
    }
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(['dataset.dat', 'build.custom', 'notes/example.com'])
    expect(view.queryByRole('button', { name: 'example.com' })).toBeNull()
    expect(view.queryByRole('button', { name: 'v1.2.3' })).toBeNull()
  })

  it('opens sandbox destinations through the scoped closing-reply file callback', () => {
    const openFile = vi.fn<(path: string) => void>()
    const text = '[验收文件](sandbox:/srv/project/PowerEvolve-%E7%AC%AC%E4%BA%8C%E8%BD%AEPDF%E9%AA%8C%E6%94%B6.pdf)'
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} standaloneFileLinks streaming />
    </MarkdownDelegateProvider>)
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} standaloneFileLinks />
    </MarkdownDelegateProvider>)
    fireEvent.click(view.getByRole('button', { name: '验收文件' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('/srv/project/PowerEvolve-第二轮PDF验收.pdf', undefined)
    view.rerender(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} />
    </MarkdownDelegateProvider>)
    expect(view.container.querySelector('button, a')).toBeNull()
  })

  it('opens simple inline filenames in closing prose without changing recorded-file resolution', () => {
    const openFile = vi.fn<(path: string) => void>()
    const text = '已交付 `round2-resource-proof.txt` 和 `第二轮验收.xlsx`。\n\n- 中文目录/报告.pdf\n\n`cat report.txt`、`../outside.csv`、`example.com` 保持原样。'
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} standaloneFileLinks />
    </MarkdownDelegateProvider>)
    for (const path of ['round2-resource-proof.txt', '第二轮验收.xlsx', '中文目录/报告.pdf']) {
      fireEvent.click(view.getByRole('button', { name: path }))
    }
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(['round2-resource-proof.txt', '第二轮验收.xlsx', '中文目录/报告.pdf'])
    expect(view.queryByRole('button', { name: 'cat report.txt' })).toBeNull()
    expect(view.queryByRole('button', { name: '../outside.csv' })).toBeNull()
    expect(view.queryByRole('button', { name: 'example.com' })).toBeNull()
    const resolve = vi.fn(() => undefined)
    view.rerender(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} standaloneFileLinks fileMentions={{ resolve }} />
    </MarkdownDelegateProvider>)
    expect(view.queryByRole('button', { name: 'round2-resource-proof.txt' })).toBeNull()
    expect(resolve).toHaveBeenCalledWith('round2-resource-proof.txt')
  })

  it('offers scoped opens for standalone assistant file list items only after settlement', () => {
    const openFile = vi.fn<(path: string, options?: { line?: number }) => void>()
    const text = '- csv24-model.json\n- csv24-predictions.csv\n- notes/report.txt\n- ../outside.csv\n- https://example.com/a.csv\n- example.com\n- v1.2.3\n- `train.py`\n- prose with a file.csv\n'
    const renderView = (streaming: boolean) => (
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={text} streaming={streaming} standaloneFileLinks />
      </MarkdownDelegateProvider>
    )
    const view = render(renderView(true))
    expect(view.queryByRole('button', { name: 'csv24-model.json' })).toBeNull()
    view.rerender(renderView(false))
    fireEvent.click(view.getByRole('button', { name: 'csv24-model.json' }))
    fireEvent.click(view.getByRole('button', { name: 'csv24-predictions.csv' }))
    fireEvent.click(view.getByRole('button', { name: 'notes/report.txt' }))
    fireEvent.click(view.getByRole('button', { name: 'train.py' }))
    expect(openFile.mock.calls.map(([path]) => path)).toEqual(['csv24-model.json', 'csv24-predictions.csv', 'notes/report.txt', 'train.py'])
    expect(view.queryByRole('button', { name: '../outside.csv' })).toBeNull()
    expect(view.queryByRole('button', { name: 'example.com' })).toBeNull()
    expect(view.queryByRole('button', { name: 'v1.2.3' })).toBeNull()
    expect(view.queryByRole('button', { name: 'prose with a file.csv' })).toBeNull()
    expect(view.getByRole('link', { name: 'https://example.com/a.csv' })).toBeTruthy()
  })

  it('keeps existing recorded-file mention disambiguation in charge', () => {
    const openFile = vi.fn()
    const resolve = vi.fn(() => undefined)
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={'- `report.txt`'} standaloneFileLinks fileMentions={{ resolve }} />
      </MarkdownDelegateProvider>,
    )
    expect(view.queryByRole('button')).toBeNull()
    expect(resolve).toHaveBeenCalledWith('report.txt')
  })

  it('opens plain list filenames when recorded-file mentions are present without bypassing code disambiguation', () => {
    const openFile = vi.fn()
    const knownOpen = vi.fn()
    const resolve = vi.fn((value: string) => value === 'known.csv'
      ? { open: knownOpen, label: 'recorded file', title: 'nested/known.csv' }
      : undefined)
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={'- report.txt\n- `known.csv`\n- `unknown.csv`\n- ../outside.csv'}
          standaloneFileLinks fileMentions={{ resolve }} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'report.txt' }))
    fireEvent.click(view.getByRole('button', { name: 'recorded file' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('report.txt', undefined)
    expect(knownOpen).toHaveBeenCalledOnce()
    expect(view.queryByRole('button', { name: 'unknown.csv' })).toBeNull()
    expect(view.queryByRole('button', { name: '../outside.csv' })).toBeNull()
  })

  it('routes an authority-free file URI in a settled closing reply through the scoped opener', () => {
    const openFile = vi.fn()
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={'- [predictions.csv](file:///srv/dsh/projects/abc/predictions.csv)\n- [report][file]\n\n[file]: file:///srv/dsh/projects/abc/hello%20world.csv#L2'} standaloneFileLinks />
    </MarkdownDelegateProvider>)
    fireEvent.click(view.getByRole('button', { name: 'predictions.csv' }))
    fireEvent.click(view.getByRole('button', { name: 'report' }))
    expect(openFile.mock.calls).toEqual([
      ['/srv/dsh/projects/abc/predictions.csv', undefined],
      ['/srv/dsh/projects/abc/hello world.csv', { line: 2 }],
    ])
    expect(view.container.querySelector('a')).toBeNull()
  })

  it.each([
    'sandbox://host/private.csv', 'sandbox:///server/private.csv', 'sandbox:relative.csv',
    'sandbox:/project/%2e%2e/private.csv', 'sandbox:/project/../private.csv',
    'sandbox:/project%2fprivate.csv', 'sandbox:/project/%5cprivate.csv',
    'sandbox:/project/%00private.csv', 'sandbox:/project/a.csv?raw=1',
    'file://host/private.csv', 'file://localhost/private.csv', 'file:////server/private.csv',
    'file:///%2fserver/private.csv', 'file:///project%2fprivate.csv', 'file:///project/%2e%2e/private.csv', 'file:///project/../private.csv',
    'file:///project/%5cprivate.csv', 'file:///project/%00private.csv', 'file:///project/a.csv?raw=1',
    'file:%2F%2F%2Fproject/a.csv', 'javascript:alert', 'data:text/plain,hi',
  ])('keeps unsafe scoped URI %s inert', (target) => {
    const openFile = vi.fn()
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={`[file](${target})`} standaloneFileLinks />
    </MarkdownDelegateProvider>)
    expect(view.container.querySelector('button, a')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('keeps file URIs inert before settlement and outside an enabled closing reply', () => {
    const openFile = vi.fn()
    const text = '[file](file:///srv/project/a.csv)'
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} standaloneFileLinks streaming />
    </MarkdownDelegateProvider>)
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={text} />
    </MarkdownDelegateProvider>)
    expect(view.queryByRole('button')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not turn a file URI written as inline or fenced code into a link', () => {
    const openFile = vi.fn()
    const view = render(<MarkdownDelegateProvider openFile={openFile}>
      <MarkdownText text={'`file:///srv/project/a.csv`\n\n```text\nfile:///srv/project/a.csv\n```'} standaloneFileLinks />
    </MarkdownDelegateProvider>)
    expect(view.queryByRole('button', { name: /file:\/\// })).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })
})
