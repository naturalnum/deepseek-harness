/** Shared inert artwork and note editor for both current MCP transports. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { mcpPresentation, type McpPresentation } from '@power-evolve/contracts/mcp-metadata'

/** Edit metadata that remains browser-local until the owning connection form commits it.
 * @param props Current fields, localized copy and owning form callback.
 * @returns Inert raster upload and note controls.
 */
export function McpMetadataFields({ value, onChange, t }: {
  readonly value: McpPresentation | undefined
  readonly onChange: (value: McpPresentation) => void
  readonly t: TranslateNS<'powerEvolve.extensionCenter'>
}): ReactNode {
  const reader = useRef<FileReader>()
  const [error, setError] = useState(false)
  useEffect(() => () => { reader.current?.abort() }, [])
  const current = value ?? { note: '', icon: null }
  const latest = useRef(current)
  useEffect(() => { latest.current = current }, [current])
  const upload = (file: File | undefined): void => {
    reader.current?.abort()
    if (!file) return
    if (file.size > 49_152 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError(true); return }
    const pending = new FileReader()
    reader.current = pending
    pending.onload = () => {
      if (reader.current !== pending) return
      const parsed = mcpPresentation.safeParse({ ...latest.current, icon: pending.result })
      if (parsed.success) { onChange(parsed.data); setError(false) } else setError(true)
    }
    pending.onerror = () => { if (reader.current === pending) setError(true) }
    pending.readAsDataURL(file)
  }
  return <div className="pext-mcp-metadata-fields">
    <label className="pext-mcp-form-field"><span>{t('mcpIcon')}</span>
      {current.icon && <img className="pext-mcp-uploaded-icon" src={current.icon} alt="" />}
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { upload(event.target.files?.[0]) }} />
    </label>
    {current.icon && <button type="button" className="pext-mcp-button" onClick={() => {
      reader.current?.abort(); onChange({ ...current, icon: null })
    }}>{t('mcpRemoveIcon')}</button>}
    {error && <p role="alert" className="pext-error">{t('mcpIconInvalid')}</p>}
    <label className="pext-mcp-form-field"><span>{t('mcpNote')}</span>
      <textarea value={current.note} maxLength={1000} onChange={(event) => { onChange({ ...current, note: event.target.value }) }} />
    </label>
  </div>
}
