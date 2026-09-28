const STYLE_ID = '@power-evolve/dsh-client-workspace-files'

const CSS = `
.pe-workspace-file{display:flex;align-items:center;gap:6px;min-width:0}
.pe-workspace-file-button{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pe-workspace-file-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pe-workspace-file-button:disabled{cursor:not-allowed;opacity:.45}
.pe-workspace-file-status{max-width:150px;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.pe-workspace-file-status[data-error]{color:var(--dsw-alias-state-error-primary)}
.pe-workspace-file-input{display:none}
.pe-workspace-download{display:inline-flex;align-items:center;position:relative}
.pe-workspace-download-button{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pe-workspace-download-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pe-workspace-download-button:disabled{opacity:.45;cursor:not-allowed}
.pe-workspace-download-error{position:absolute;z-index:20;right:0;top:32px;width:220px;max-width:60vw;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-state-error-primary);box-shadow:0 2px 12px #0002;font-size:12px;white-space:normal}
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
