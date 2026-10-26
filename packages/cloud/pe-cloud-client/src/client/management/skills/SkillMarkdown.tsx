import type { ReactNode } from 'react'
import css from './SkillsPage.module.css'

type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }

/** Render basic Skill Markdown while keeping HTML and links as text.
 * @param props - the installed Skill document.
 * @returns headings, lists, code and paragraphs without raw HTML injection.
 */
export function SkillMarkdown({ document }: { readonly document: string }): ReactNode {
  const blocks = parseSkillMarkdown(document)
  return (
    <div className={css.markdown}>
      {blocks.map((block, index) => {
        const key = `${block.kind}:${String(index)}`
        if (block.kind === 'heading') {
          if (block.level === 1) return <h1 key={key}>{inlineMarkdown(block.text)}</h1>
          if (block.level === 2) return <h2 key={key}>{inlineMarkdown(block.text)}</h2>
          return <h3 key={key}>{inlineMarkdown(block.text)}</h3>
        }
        if (block.kind === 'code') {
          return <pre key={key} data-language={block.language || undefined}><code>{block.text}</code></pre>
        }
        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => <li key={`${key}:${String(itemIndex)}`}>{inlineMarkdown(item)}</li>)
          return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
        }
        return <p key={key}>{inlineMarkdown(block.text)}</p>
      })}
    </div>
  )
}

/** Parse headings, paragraphs, fenced code and ordered or unordered lists.
 * @param source - Skill document text, optionally prefixed by frontmatter.
 * @returns blocks preserving literal code content and incomplete fences.
 */
export function parseSkillMarkdown(source: string): readonly MarkdownBlock[] {
  const lines = withoutFrontmatter(source).replace(/\r\n?/gu, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let paragraph: string[] = []
  let list: { readonly ordered: boolean; readonly items: string[] } | undefined
  let code: { readonly language: string; readonly content: string[] } | undefined
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const flushList = (): void => {
    if (list === undefined) return
    blocks.push({ kind: 'list', ...list })
    list = undefined
  }
  for (const line of lines) {
    if (code !== undefined) {
      if (/^```\s*$/u.test(line)) {
        blocks.push({ kind: 'code', language: code.language, text: code.content.join('\n') })
        code = undefined
      } else code.content.push(line)
      continue
    }
    if (line.trim() === '') { flushParagraph(); flushList(); continue }
    const fence = /^```\s*([^\s`]*)\s*$/u.exec(line)
    if (fence !== null) {
      flushParagraph(); flushList()
      code = { language: fence[0].slice(3).trim(), content: [] }
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (heading !== null) {
      flushParagraph(); flushList()
      blocks.push({ kind: 'heading', level: line.startsWith('###') ? 3 : line.startsWith('##') ? 2 : 1,
        text: heading[0].replace(/^#{1,3}\s+/u, '').trim() })
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line)
    const unordered = /^\s*[-*]\s+(.+)$/u.exec(line)
    const match = ordered ?? unordered
    if (match !== null) {
      flushParagraph()
      const isOrdered = ordered !== null
      if (list === undefined || list.ordered !== isOrdered) {
        flushList()
        list = { ordered: isOrdered, items: [] }
      }
      list.items.push(match[0].replace(isOrdered ? /^\s*\d+[.)]\s+/u : /^\s*[-*]\s+/u, '').trim())
      continue
    }
    flushList()
    if (/^(#{1,3})\s+|^```|^\s*[-*]\s+|^\s*\d+[.)]\s+/u.test(line)) flushParagraph()
    paragraph.push(line.trim())
  }
  if (code !== undefined) blocks.push({ kind: 'code', language: code.language, text: code.content.join('\n') })
  flushParagraph(); flushList()
  return blocks
}

function withoutFrontmatter(source: string): string {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return source
  const normalized = source.replace(/\r\n?/gu, '\n')
  const end = normalized.indexOf('\n---\n', 4)
  return end < 0 ? normalized : normalized.slice(end + 5)
}

function inlineMarkdown(value: string): ReactNode {
  return value.split(/(`[^`]+`|\*\*[^*]+\*\*)/gu).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    return part
  })
}
