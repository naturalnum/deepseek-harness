// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '../src/index.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

describe('Markdown file links', () => {
  it('offers scoped opens for standalone assistant file list items only after settlement', () => {
    const openFile = vi.fn()
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
  it.each([
    ['src/index.ts', 'src/index.ts', undefined],
    ['/workspace/src/index.ts#L24', '/workspace/src/index.ts', { line: 24 }],
    ['../docs/My%20Notes.md#L24-L30', '../docs/My Notes.md', { line: 24 }],
    ['C:/work/file.ts#L2', 'C:/work/file.ts', { line: 2 }],
    ['C:%5Cwork%5Cfile.ts', 'C:\\work\\file.ts', undefined],
    ['docs/%E4%B8%AD%E6%96%87.md', 'docs/中文.md', undefined],
    ['file%23name%3F.txt', 'file#name?.txt', undefined],
  ])('opens %s through the preview callback', (target, path, options) => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={`[source](${target})`} />
      </MarkdownDelegateProvider>,
    )
    const link = view.getByRole('button', { name: 'source' })
    expect(link.getAttribute('title')).toBe(path)
    fireEvent.click(link)
    expect(openFile).toHaveBeenCalledWith(path, options)
    expect(view.container.querySelector('a')).toBeNull()
  })

  it.each(['/workspace/chart.png', 'C:/work/chart.png'])('keeps %s accessible when inline images are unavailable', (path) => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText
          text={`![Preview](${path}) [Open image](${path})`}
          pathImages={{ resolve: () => undefined }}
        />
      </MarkdownDelegateProvider>,
    )
    expect(view.container.querySelector('img')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Open image' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith(path, undefined)
  })

  it.each(['', '![](https://example.com/image.png)'])('names an empty label %s with the decoded path', (label) => {
    const view = render(
      <MarkdownDelegateProvider openFile={vi.fn()}>
        <MarkdownText text={`[${label}](docs/My%20Notes.md)`} />
      </MarkdownDelegateProvider>,
    )
    expect(view.getByRole('button', { name: 'docs/My Notes.md' })).toBeTruthy()
  })

  it('preserves an image label’s alternative text as the accessible name', () => {
    const view = render(
      <MarkdownDelegateProvider openFile={vi.fn()}>
        <MarkdownText text={'[![diagram](https://example.com/image.png)](src/a.ts)'} />
      </MarkdownDelegateProvider>,
    )
    expect(view.getByRole('button', { name: 'diagram' })).toBeTruthy()
  })

  it('handles reference links and code labels without nesting file-mention buttons', () => {
    const openFile = vi.fn()
    const resolve = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText
          text={'[see `index.ts`][source]\n\n[source]: src/index.ts#L3-L3'}
          fileMentions={{ resolve }}
        />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'see index.ts' }))
    expect(openFile).toHaveBeenCalledWith('src/index.ts', { line: 3 })
    expect(resolve).not.toHaveBeenCalled()
    expect(view.container.querySelector('button button')).toBeNull()
  })

  it.each([
    '//example.com/file', '%2F%2Fexample.com/file', '%5C%5Cserver%5Cfile',
    'javascript:alert', 'data:text/plain,hi', 'file:///etc/passwd', 'vscode:open',
    '%6Aavascript:alert', '#L2', 'file.ts?raw=1', 'file%ZZ.ts', 'file%00.ts',
    'file.ts#heading', 'file.ts#L0', 'file.ts#L3-L2',
    'file.ts#L9007199254740992', 'file.ts#L1-L9007199254740992',
  ])('keeps unsupported destination %s inert', (target) => {
    const openFile = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile}>
        <MarkdownText text={`[source](${target})`} />
      </MarkdownDelegateProvider>,
    )
    expect(view.getByText('source')).toBeTruthy()
    expect(view.container.querySelector('button, a')).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })

  it('preserves external links and leaves local links inert without an opener', () => {
    const view = render(<MarkdownText text={'[web](https://example.com/a#L1) [mail](mailto:a@example.com) [file](src/a.ts)'} />)
    expect(view.getByRole('link', { name: 'web' }).getAttribute('target')).toBe('_blank')
    expect(view.getByRole('link', { name: 'mail' }).getAttribute('href')).toBe('mailto:a@example.com')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('enables links after streaming and uses a replaced opener', () => {
    const first = vi.fn()
    const second = vi.fn()
    const text = '[source](src/a.ts)\n\nmore\n\n'
    const view = render(
      <MarkdownDelegateProvider openFile={first}>
        <MarkdownText text={text} streaming />
      </MarkdownDelegateProvider>,
    )
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(
      <MarkdownDelegateProvider openFile={first}>
        <MarkdownText text={text} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(first).toHaveBeenCalledOnce()
    view.rerender(
      <MarkdownDelegateProvider openFile={second}>
        <MarkdownText text={text} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(second).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
  })

  it('routes file and HTTP(S) links through the same provider', () => {
    const openFile = vi.fn()
    const openExternalLink = vi.fn()
    const view = render(
      <MarkdownDelegateProvider openFile={openFile} openExternalLink={openExternalLink}>
        <MarkdownText text={'[source](src/a.ts#L4) [web](https://example.com)'} />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('src/a.ts', { line: 4 })
    expect(openExternalLink).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('link', { name: 'web' }))
    expect(openExternalLink).toHaveBeenCalledExactlyOnceWith('https://example.com')
    expect(openFile).toHaveBeenCalledOnce()
  })

  it('updates cached links when the nearest provider gains, replaces, or removes its file handler', () => {
    const outer = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const markdown = <MarkdownText text="[source](src/a.ts)" />
    const scope = (openFile?: (path: string) => void) => (
      <MarkdownDelegateProvider openFile={outer}>
        <MarkdownDelegateProvider openFile={openFile}>{markdown}</MarkdownDelegateProvider>
      </MarkdownDelegateProvider>
    )
    const view = render(scope())
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(scope(first))
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(first).toHaveBeenCalledExactlyOnceWith('src/a.ts', undefined)
    view.rerender(scope(second))
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(second).toHaveBeenCalledExactlyOnceWith('src/a.ts', undefined)
    expect(first).toHaveBeenCalledOnce()
    view.rerender(scope())
    expect(view.queryByRole('button')).toBeNull()
    expect(view.getByText('source')).toBeTruthy()
    expect(outer).not.toHaveBeenCalled()
  })
})
