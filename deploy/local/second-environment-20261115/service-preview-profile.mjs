/** Explicit service-preview inputs for the normal Root generator; no profile file, credential or process is opened. */
const need = (value, message) => { if (!value) throw new Error(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => structuredClone(value)
const inertRoute = { method: 'GET', path: '/cloud/service-preview', handlerId: 'cloud:servicePreview', guard: 'account-session' }
const applicationRoute = { method: 'POST', path: '/cloud/service-application', handlerId: 'cloud:serviceApplication', guard: 'account-session' }
const browserName = '@deepseek-ai/dsh-client-ui-sidebar-browser'

function exact(value, keys) {
  need(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    'Complete explicit service-preview inputs required')
}
function positive(value) {
  need(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'Explicit finite service-preview limit required')
}
function approved(api, expected) {
  const matches = api.exactFetchRoutes.filter(row => row.path === expected.path)
  need(matches.length === 1 && Object.keys(expected).every(key => matches[0][key] === expected[key]),
    'Exact approved service-preview route required')
}
function transport(value) {
  need(object(value) && object(value.transportLimits) && value.compression === 'none', 'Explicit uncompressed Native listener limits required')
  exact(value.transportLimits, ['maxHeaderPairs', 'maxHeaderBytes', 'highWaterMark', 'maxConnections'])
  for (const number of Object.values(value.transportLimits)) positive(number)
}

/**
 * Enumerate original Root entries and explicitly composed cordis:group children for package/schema discovery.
 * @param rows Original Root entry array.
 * @returns Entries in those groups; it does not inspect arbitrary account/preset configuration objects.
 */
export function rootEntryRows(rows) {
  const entries = []
  for (const row of rows) {
    entries.push(row)
    if (row.name === 'cordis:group' && row.group === true) {
      need(Array.isArray(row.config), 'Original Cordis group entry array required')
      entries.push(...rootEntryRows(row.config))
    }
  }
  return entries
}

/**
 * Consume the one explicit preview selection after ordinary Root assembly and before actual Loader validation.
 * @param input Original pinned generator parameters; server fields own management transport coordinates.
 * @param rows Original candidate Root entries; only owning Access/API/Client and new Native entries change.
 * @returns Nonsecret mode observation for GENERATION; no readiness or execution authority is issued.
 */
export function applyServicePreview(input, rows) {
  const find = id => {
    const matches = rows.filter(row => row.id === id)
    need(matches.length === 1 && object(matches[0].config), 'Unique original Root preview owner required')
    return matches[0]
  }
  const access = find('access-root').config, api = find('api-root').config
  const client = find('connection').config.web.client, web = find('webserver').config
  const selected = input.servicePreview
  delete access.servicePreview; delete access.applications; delete access.ingress.servicePreview
  delete client.servicePreview; delete client.serviceApplications
  const full = selected?.mode === 'service-application-v1'
  if (selected === undefined) {
    need(!api.exactFetchRoutes.some(row => [inertRoute.path, applicationRoute.path].includes(row.path)),
      'Service-preview approval requires explicit generator inputs')
    return undefined
  }
  exact(selected, ['mode', 'cookieDomain', 'inertOrigin', 'inert', ...(full ? ['applications', 'client', 'listener'] : [])])
  need(full || selected.mode === 'inert-text-v1', 'Only explicit inert-text-v1 or service-application-v1 is supported')
  approved(api, inertRoute)
  need(typeof selected.cookieDomain === 'string' && typeof selected.inertOrigin === 'string' && object(selected.inert),
    'Original inert origin, Cookie domain and complete budgets required')
  transport(input.server)
  need((input.server.tls == null ? 'http:' : 'https:') === new URL(input.server.publicOrigin).protocol,
    'Management origin must match the actual Native listener protocol')
  web.compression = input.server.compression; web.transportLimits = copy(input.server.transportLimits)
  if (input.server.tls !== undefined) web.tls = copy(input.server.tls)
  access.servicePreview = { origin: selected.inertOrigin, cookieDomain: selected.cookieDomain }
  access.ingress.servicePreview = copy(selected.inert)
  client.servicePreview = { managementOrigin: input.server.publicOrigin, previewOrigin: selected.inertOrigin,
    routePath: inertRoute.path, maxFieldBytes: selected.inert.maxFieldBytes, maxUrlBytes: selected.inert.maxUrlBytes }
  if (!full) {
    need(!api.exactFetchRoutes.some(row => row.path === applicationRoute.path), 'Application approval requires the complete service mode')
    return { mode: selected.mode, managementOrigin: input.server.publicOrigin, inertOrigin: selected.inertOrigin }
  }
  approved(api, applicationRoute)
  need(object(selected.applications), 'Complete application limits required')
  exact(selected.client, ['requestTimeoutMs', 'maxRequestBytes', 'maxResponseBytes', 'maxFieldBytes'])
  for (const number of Object.values(selected.client)) positive(number)
  need(selected.client.maxRequestBytes <= selected.applications.maxRequestBodyBytes
    && selected.client.maxResponseBytes <= access.ingress.maxBootstrapResponseBytes
    && selected.client.maxFieldBytes <= selected.applications.views?.maxFieldBytes,
    'Client handoff limits must fit the original Root limits')
  transport(selected.listener)
  need((selected.listener.tls == null ? 'http:' : 'https:') === new URL(selected.applications.origin).protocol,
    'Content origin must match the actual Native listener protocol')
  positive(selected.listener.port)
  need(selected.listener.port <= 65535 && typeof selected.listener.host === 'string'
    && !(selected.listener.host === web.host && selected.listener.port === web.port), 'Distinct explicit content listener required')
  access.applications = copy(selected.applications)
  client.serviceApplications = { managementOrigin: input.server.publicOrigin,
    contentOrigin: selected.applications.origin, ...copy(selected.client) }
  const ids = ['service-content', 'service-content-webserver', 'service-content-access']
  const existing = rootEntryRows(rows)
  need(!existing.some(row => ids.includes(row.id) || row.name === '@deepseek-ai/dsh-pe-cloud-access/applications'),
    'The original generator alone assembles the dedicated content listener')
  const browsers = existing.filter(row => row.name === browserName || row.id === 'ui-sidebar-browser')
  need(browsers.length <= 1 && browsers.every(row => row.id === 'ui-sidebar-browser' && row.name === browserName),
    'Unique original Native Sidebar Browser required')
  if (browsers.length === 0) rows.push({ id: 'ui-sidebar-browser', name: browserName, disabled: false, config: {} })
  else browsers[0].disabled = false
  rows.push({ id: ids[0], name: 'cordis:group', group: true, isolate: { webServer: true }, config: [
    { id: ids[1], name: '@deepseek-ai/dsh-host-webserver', config: copy(selected.listener) },
    { id: ids[2], name: '@deepseek-ai/dsh-pe-cloud-access/applications', config: {} },
  ] })
  return { mode: selected.mode, managementOrigin: input.server.publicOrigin, inertOrigin: selected.inertOrigin,
    contentOrigin: selected.applications.origin, browserEntryId: 'ui-sidebar-browser', contentEntryId: ids[0] }
}
