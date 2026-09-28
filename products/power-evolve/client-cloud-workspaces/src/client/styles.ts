const id = 'power-evolve-cloud-workspaces-style'
const css = `
.pe-cloud-workspace-field{display:grid;gap:8px}
.pe-cloud-workspace-input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-primary,#ccc);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);font:inherit}
.pe-cloud-workspace-input:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.pe-cloud-workspace-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
`

export function installCloudWorkspaceStyles(): () => void {
  if (document.getElementById(id)) return () => {}
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
