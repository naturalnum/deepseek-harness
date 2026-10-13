import type { ReactNode } from 'react'

/** The switch interaction carried over from the old Skills cards. */
export function SkillToggle({ label, checked, disabled, onChange }: {
  readonly label: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (enabled: boolean) => void
}): ReactNode {
  return <button type="button" className="pext-skill-toggle" role="switch"
    aria-label={label} aria-checked={checked} data-checked={checked || undefined}
    disabled={disabled} onClick={() => { onChange(!checked) }}><span /></button>
}
