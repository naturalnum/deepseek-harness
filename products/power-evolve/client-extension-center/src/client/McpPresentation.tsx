/** Original MCP page and dialog presentation with caller-owned state. */
import {
  IconApiOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconSearchOutlineRegular,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import {
  CONNECTION_MODAL_CONTENT_CLASS_NAME,
  connectionModalClassName,
} from './connection-modal-layout.ts'

/** Original list-page labels, search, and caller-owned content. */
export interface McpPageFrameProps {
  readonly title: string
  readonly subtitle: string
  readonly tabLabel: string
  readonly tabMeta?: ReactNode
  readonly searchLabel: string
  readonly searchPlaceholder: string
  readonly searchValue: string
  readonly toolbar?: ReactNode
  readonly notice?: ReactNode
  readonly children: ReactNode
  readonly onSearchChange: (value: string) => void
}

/** Render original MCP page chrome with caller-owned state.
 * @param props - localized labels, search state, and content. @returns the list page.
 */
export function McpPageFrame(props: McpPageFrameProps): ReactNode {
  return (
    <main className="pext-mcp-page" data-power-evolve-mcp-page>
      <header className="pext-mcp-page-header">
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
      </header>
      <div className="pext-mcp-primary-toolbar">
        <nav className="pext-mcp-tabs" aria-label={props.tabLabel}>
          <span data-active>
            <IconApiOutlineRegular size={16} />
            {props.tabLabel}
            {props.tabMeta === undefined ? null : <small>{props.tabMeta}</small>}
          </span>
        </nav>
        <label className="pext-mcp-search">
          <span className="pext-visually-hidden">{props.searchLabel}</span>
          <IconSearchOutlineRegular size={16} />
          <input
            type="search"
            value={props.searchValue}
            placeholder={props.searchPlaceholder}
            onChange={(event) => { props.onSearchChange(event.target.value) }}
          />
        </label>
      </div>
      {props.toolbar === undefined
        ? null
        : <div className="pext-mcp-management-toolbar">{props.toolbar}</div>}
      {props.notice === undefined ? null : <div className="pext-mcp-notice">{props.notice}</div>}
      {props.children}
    </main>
  )
}

/** Render original connection rows. @param props - row children. @returns the list container. */
export function McpList({ children }: { readonly children: ReactNode }): ReactNode {
  return <div className="pext-mcp-list">{children}</div>
}

/** One original connection row with independently interactive enablement. */
export interface McpListRowProps {
  readonly icon?: string
  readonly openLabel: string
  readonly title: string
  readonly badge?: ReactNode
  readonly description: ReactNode
  readonly meta?: ReactNode
  readonly status?: ReactNode
  readonly action?: ReactNode
  readonly onOpen: () => void
}

/** Render one saved metadata row. @param props - row labels and actions. @returns the original row layout. */
export function McpListRow(props: McpListRowProps): ReactNode {
  return (
    <article className="pext-mcp-row">
      <button
        type="button"
        className="pext-mcp-row-primary"
        aria-label={props.openLabel}
        onClick={props.onOpen}
      >
        <span className="pext-mcp-glyph" aria-hidden="true">{props.icon ? <img src={props.icon} alt="" /> : <IconApiOutlineRegular size={18} />}</span>
        <span className="pext-mcp-row-copy">
          <span className="pext-mcp-row-title">
            <strong>{props.title}</strong>
            {props.badge === undefined ? null : <span>{props.badge}</span>}
          </span>
          <span className="pext-mcp-row-description">{props.description}</span>
          {props.meta === undefined ? null : <small>{props.meta}</small>}
        </span>
        <IconChevronRightOutlineRegular size={15} className="pext-mcp-row-chevron" />
      </button>
      {props.status === undefined && props.action === undefined
        ? null
        : <div className="pext-mcp-row-actions">{props.status}{props.action}</div>}
    </article>
  )
}

/** Original detail hero, back action, and caller-owned cards. */
export interface McpDetailFrameProps {
  readonly icon?: string
  readonly label: string
  readonly backLabel: string
  readonly name: string
  readonly description: ReactNode
  readonly meta?: ReactNode
  readonly status?: ReactNode
  readonly action?: ReactNode
  readonly children: ReactNode
  readonly onBack: () => void
}

/** Render original detail layout. @param props - labels, hero metadata, and cards. @returns detail content. */
export function McpDetailFrame(props: McpDetailFrameProps): ReactNode {
  return (
    <section className="pext-mcp-detail" aria-label={props.label}>
      <button type="button" className="pext-mcp-detail-back" onClick={props.onBack}>
        <IconChevronLeftOutlineRegular size={15} />{props.backLabel}
      </button>
      <header className="pext-mcp-detail-hero">
        <span className="pext-mcp-glyph pext-mcp-glyph-large" aria-hidden="true">
          {props.icon ? <img src={props.icon} alt="" /> : <IconApiOutlineRegular size={22} />}
        </span>
        <div className="pext-mcp-detail-hero-copy">
          <div className="pext-mcp-detail-title"><h2>{props.name}</h2>{props.status}</div>
          <p>{props.description}</p>
          {props.meta === undefined ? null : <small>{props.meta}</small>}
        </div>
        {props.action === undefined ? null : <div className="pext-mcp-detail-action">{props.action}</div>}
      </header>
      <div className="pext-mcp-detail-stack">{props.children}</div>
    </section>
  )
}

/** Render an original detail card. @param props - title and card content. @returns the card. */
export function McpDetailCard({
  title,
  description,
  children,
}: {
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <section className="pext-mcp-detail-card">
      <header>
        <h3>{title}</h3>
        {description === undefined ? null : <p>{description}</p>}
      </header>
      <div className="pext-mcp-detail-card-body">{children}</div>
    </section>
  )
}

/** Render saved metadata definitions. @param props - entries and URL formatting. @returns definition rows. */
export function McpDefinitionGrid({
  entries,
  monoFirst = false,
}: {
  readonly entries: readonly {
    readonly key: string
    readonly term: ReactNode
    readonly value: ReactNode
  }[]
  readonly monoFirst?: boolean
}): ReactNode {
  return (
    <dl className="pext-mcp-detail-definitions">
      {entries.map((entry, index) => (
        <div key={entry.key}>
          <dt>{entry.term}</dt>
          <dd className={monoFirst && index === 0 ? 'pext-mcp-detail-mono' : undefined}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Controlled original create/edit dialog with a fixed footer. */
export interface McpDialogFrameProps {
  readonly open: boolean
  readonly title: string
  readonly closeLabel: string
  readonly description?: string
  readonly footer?: ReactNode
  readonly children: ReactNode
  readonly onClose: () => void
}

/** Render the controlled connection dialog with caller-owned validation.
 * @param props - localized labels, open state, and form content. @returns the dialog.
 */
export function McpDialogFrame(props: McpDialogFrameProps): ReactNode {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      closeLabel={props.closeLabel}
      className={connectionModalClassName('pext-mcp-modal')}
      contentClassName={CONNECTION_MODAL_CONTENT_CLASS_NAME}
      {...(props.description === undefined ? {} : { description: props.description })}
      {...(props.footer === undefined ? {} : { footer: props.footer })}
    >
      <div className="pext-mcp-form">{props.children}</div>
    </Modal>
  )
}

/** Render one original labeled field. @param props - localized label and control. @returns the field. */
export function McpDialogField({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return <label className="pext-mcp-form-field"><span>{label}</span>{children}</label>
}
