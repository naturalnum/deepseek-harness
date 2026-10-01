/** Native artifact styling uses the active DSH theme variables. */
const id = 'power-evolve-artifact-style'
const css = `
.pe-produced{font-size:12px;color:var(--dsw-alias-label-secondary);margin:8px 0;overflow-wrap:anywhere}
.pe-produced-heading{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.pe-produced button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left}
.pe-produced button:disabled{cursor:default;opacity:.5}
.pe-produced-files{list-style:none;padding:0;margin:4px 0}
.pe-produced-files li{margin:5px 0}
.pe-produced-files button{display:flex;gap:12px;align-items:baseline;max-width:100%}
.pe-produced-path{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.pe-produced-reasons{margin:4px 0;padding-inline-start:18px}
.pe-produced [role=alert]{color:var(--dsw-alias-state-error-primary)}
.pe-artifact-publish{display:inline-flex;align-items:center;gap:5px}
.pe-artifact-publish button{border:0;background:transparent;color:inherit;cursor:pointer}
.pe-artifact-publish button:disabled{cursor:default;opacity:.5}
.pe-artifact-publish-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.pe-artifacts-tab{box-sizing:border-box;height:100%;overflow:auto;padding:12px;color:var(--dsw-alias-label-primary);font-size:13px}
.pe-artifacts-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.pe-artifacts-header strong{flex:1}
.pe-artifacts-list{list-style:none;margin:0;padding:0}
.pe-artifacts-item{border-bottom:1px solid var(--dsw-alias-border-l3);padding:10px 0}
.pe-artifacts-filename{overflow-wrap:anywhere}
.pe-artifacts-actions{display:flex;gap:12px;margin-top:5px}
.pe-artifacts-preview{white-space:pre-wrap;overflow-wrap:anywhere}
.pe-artifacts-image{max-width:100%}
`

/** Install styles for the owning plugin lifetime.
 * @returns a disposer removing the inserted stylesheet.
 */
export function installArtifactStyles(): () => void {
  if (document.getElementById(id)) return () => {}
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
