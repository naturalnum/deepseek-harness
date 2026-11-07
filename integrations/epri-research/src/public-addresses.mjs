// Public browser addresses only. Authentication and account selection belong to the host.
export function normalizePublicAddress(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') ||
      (!value.startsWith('/') && !/^https?:\/\//.test(value)) || value.startsWith('//'))
    throw new Error('Public address must be an HTTP(S) URL or a site-relative path');
  const url = new URL(value, 'https://deployment.invalid');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Public address cannot contain credentials, query parameters or a fragment');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return value.startsWith('/') ? url.pathname : url.href;
}

export function publicConfiguration(env = {}) {
  const values = {};
  for (const [key, name] of [['workbenchUrl', 'DS_RESEARCH_PUBLIC_URL'], ['harnessUrl', 'DS_HARNESS_PUBLIC_URL']])
    if (env[name]) values[key] = normalizePublicAddress(env[name]);
  return Object.freeze(values);
}

export function configuredOrigins(config) {
  return [...new Set(Object.values(config).filter(value => /^https?:\/\//.test(value)).map(value => new URL(value).origin))];
}

export function publicAddresses(browser = window, page = 'workbench') {
  const here = new URL(browser.location.href);
  const config = browser.__DS_RESEARCH_PUBLIC__ || {};
  const legacy = port => { const url = new URL('/', here); url.port = port; return url.href; };
  const address = (key, fallback) => new URL(config[key] === undefined ? fallback : normalizePublicAddress(config[key]), here);
  return {
    workbench: address('workbenchUrl', page === 'workbench' ? new URL('./', here).href : new URL('./research/', here).href),
    harness: address('harnessUrl', page === 'harness' ? new URL('./', here).href : legacy('43128')),
  };
}
