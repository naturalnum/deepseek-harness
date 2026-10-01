const id = 'power-evolve-cloud-workspaces-style'
const css = `
.pe-cloud-workspace-body{display:grid;gap:16px}
.pe-cloud-workspace-field{display:grid;gap:8px}
.pe-cloud-workspace-input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-primary);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.pe-cloud-workspace-input:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.pe-cloud-workspace-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.pe-cloud-workspace-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;overflow-wrap:anywhere}
.pe-cloud-workspace-directories{display:grid;gap:8px;list-style:none;margin:0;padding:0;max-height:240px;overflow:auto}
.pe-cloud-workspace-body p{margin:0;overflow-wrap:anywhere}
`

/** Install modal styles for the plugin lifetime.
 * @returns the disposer for the owned stylesheet, or a no-op when already installed.
 */
export function installCloudWorkspaceStyles(): () => void {
  if (document.getElementById(id)) return () => {}
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
