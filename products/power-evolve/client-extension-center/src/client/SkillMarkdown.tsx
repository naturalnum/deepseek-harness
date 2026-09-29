import type { ReactNode } from 'react'

type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }

export function SkillMarkdown({ document }: { readonly document: string }): ReactNode {
  const blocks = parseSkillMarkdown(document)
  return (
    <div className="pext-skill-markdown">
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

export function parseSkillMarkdown(source: string): readonly MarkdownBlock[] {
  const lines = withoutFrontmatter(source).replace(/\r\n?/gu, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') { index += 1; continue }
    const fence = /^```\s*([^\s`]*)\s*$/u.exec(line)
    if (fence !== null) {
      const content: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/u.test(lines[index] ?? '')) content.push(lines[index++] ?? '')
      if (index < lines.length) index += 1
      blocks.push({ kind: 'code', language: fence[1] ?? '', text: content.join('\n') })
      continue
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      index += 1
      continue
    }
    const unordered = /^\s*[-*]\s+(.+)$/u.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line)
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null
      const items: string[] = []
      while (index < lines.length) {
        const match = isOrdered
          ? /^\s*\d+[.)]\s+(.+)$/u.exec(lines[index] ?? '')
          : /^\s*[-*]\s+(.+)$/u.exec(lines[index] ?? '')
        if (match === null) break
        items.push(match[1]!.trim())
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }
    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && lines[index]!.trim() !== ''
      && !/^(#{1,3})\s+|^```|^\s*[-*]\s+|^\s*\d+[.)]\s+/u.test(lines[index]!)) {
      paragraph.push(lines[index]!.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
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
