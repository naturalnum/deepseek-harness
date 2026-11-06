import { publicAddresses } from '../public-addresses.mjs';
// Transfer only the native visual tokens needed by the cross-origin workbench.
export const workbenchThemeTokens = {
  '--research-surface': '--dsw-alias-bg-layer-1',
  '--research-muted-surface': '--dsw-alias-bg-module-platform',
  '--research-text': '--dsw-alias-label-primary',
  '--research-secondary': '--dsw-alias-label-secondary',
  '--research-muted': '--dsw-alias-label-tertiary',
  '--research-border': '--dsw-alias-border-l2',
  '--research-hover': '--dsw-alias-interactive-bg-hover',
  '--research-active': '--dsw-alias-interactive-bg-active',
  '--research-accent': '--dsw-alias-link',
  '--research-primary': '--dsw-alias-button-primary-fill',
  '--research-on-primary': '--dsw-alias-label-primary-foreground',
  '--research-font': '--dsw-font-family',
};

export function applyWorkbenchTheme(event, browser = window) {
  const origin = publicAddresses(browser).harness.origin;
  if (browser.parent === browser || event.source !== browser.parent ||
      event.origin !== origin || event.data?.type !== 'research-theme') return;
  const style = browser.document.documentElement.style;
  for (const name of Object.keys(workbenchThemeTokens)) {
    const value = event.data.tokens?.[name];
    if (typeof value === 'string' && value.length < 1000 &&
        browser.CSS.supports(name === '--research-font' ? 'font-family' : 'color', value))
      style.setProperty(name, value);
  }
  style.colorScheme = event.data.dark === true ? 'dark' : 'light';
}
