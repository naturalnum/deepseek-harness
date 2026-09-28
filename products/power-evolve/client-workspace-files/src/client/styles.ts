const STYLE_ID = '@power-evolve/dsh-client-workspace-files'

const CSS = `
.pe-workspace-file{display:flex;align-items:center;gap:6px;min-width:0}
.pe-workspace-file-button{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pe-workspace-file-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pe-workspace-file-button:disabled{cursor:not-allowed;opacity:.45}
.pe-workspace-file-status{max-width:150px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.pe-workspace-file-status[data-error]{color:var(--dsw-alias-state-error-primary)}
.pe-workspace-file-input{display:none}
`

export function installWorkspaceFileStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  return () => { style.remove() }
}
