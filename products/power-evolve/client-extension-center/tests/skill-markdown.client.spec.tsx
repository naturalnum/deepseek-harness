// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SkillMarkdown } from '../src/client/SkillMarkdown.tsx'

afterEach(cleanup)
it('renders skill instructions with headings, code, lists and inline emphasis as readable literal content', () => {
  const document = '---\r\nname: Example\r\n---\r\n# Guide\r\n## Inputs\r\n### Notes\r\nParagraph one\r\ncontinues with **emphasis** and `inline`.\r\n\r\n- First\r\n* Second\r\n\r\n1. One\r\n2) Two\r\n\r\n```sh\r\nprintf "literal"\r\n```\r\n```\r\nuntyped\r\n```\r\n<script>unsafe()</script>'
  const root = render(<SkillMarkdown document={document} />)
  for (const name of ['Guide', 'Inputs', 'Notes']) expect(screen.getByRole('heading', { name })).toBeTruthy()
  expect(root.container.querySelector('ul')?.textContent).toBe('FirstSecond')
  expect(root.container.querySelector('ol')?.textContent).toBe('OneTwo')
  expect(root.container.querySelector('strong')?.textContent).toBe('emphasis')
  expect(root.container.querySelector('pre[data-language="sh"]')?.textContent).toBe('printf "literal"')
  expect(root.container.querySelector('pre:not([data-language])')?.textContent).toBe('untyped')
  expect(root.container.querySelector('script')).toBeNull()
  expect(screen.getByText('<script>unsafe()</script>')).toBeTruthy()
  expect(root.container.textContent).not.toContain('name: Example')
})

it.each(['---\nunfinished frontmatter', '---\r\nunfinished frontmatter', '```js\nunterminated code', '- end of file', '1. end of file', ''])('keeps incomplete author content readable: %s', (document) => {
  const root = render(<SkillMarkdown document={document} />)
  if (document) expect(root.container.textContent).toContain(document.split(/\r?\n/u).at(-1)?.replace(/^(?:- |1\. )/u, ''))
  else expect(root.container.textContent).toBe('')
})

it('keeps a malformed code fence separate from the preceding paragraph without interpreting its contents', () => {
  const root = render(<SkillMarkdown document={'Before the example\n```sh extra\nprintf "literal"\n\nAfter the example'} />)
  expect(Array.from(root.container.querySelectorAll('p'), node => node.textContent)).toEqual([
    'Before the example', '```sh extra printf "literal"', 'After the example',
  ])
  expect(root.container.querySelector('pre')).toBeNull()
})
