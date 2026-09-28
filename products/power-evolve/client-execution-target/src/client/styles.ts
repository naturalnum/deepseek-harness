const STYLE_ID = '@power-evolve/dsh-client-execution-target'
const CSS = `
.pe-execution-target{display:flex;align-items:center;gap:4px;min-width:0;position:relative}
.pe-execution-target-label{display:flex;align-items:center;gap:5px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.pe-execution-target-caption{white-space:nowrap}
.pe-execution-target select{box-sizing:border-box;max-width:min(250px,28vw);min-width:95px;height:27px;padding:2px 6px;border:1px solid var(--dsw-alias-border-primary,#ccc);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);font:inherit;text-overflow:ellipsis}
.pe-execution-target select:focus-visible,.pe-execution-target-refresh:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.pe-execution-target-refresh{width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer}
.pe-execution-target-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pe-execution-target-refresh:disabled,.pe-execution-target select:disabled{opacity:.5;cursor:not-allowed}
.pe-execution-target-pair{padding:4px 6px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.pe-execution-target-pair:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pe-execution-target-pair:disabled{opacity:.5;cursor:not-allowed}
.pe-execution-target-error{position:absolute;right:0;top:29px;z-index:5;width:220px;padding:7px 9px;border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-state-error-primary);box-shadow:0 2px 12px #0002;font-size:12px}
.pe-execution-target-pairing{display:flex;flex-direction:column;gap:8px}
.pe-execution-target-pairing input{width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--dsw-alias-border-primary,#ccc);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.pe-execution-target-pairing span{color:var(--dsw-alias-label-secondary);font-size:12px}
`

export function installExecutionTargetStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  return () => { style.remove() }
}
