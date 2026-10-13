/** Resolve the trusted Platform approval destination without carrying credentials. */
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Read the Host-declared fixed approval URL.
 * @param request Browser fetch carrier for the same-origin Host configuration.
 * @returns A credential-free HTTPS URL, or an explicitly local HTTP URL; other destinations reject.
 */
export async function approvalUrl(request: typeof fetch = (...args) => globalThis.fetch(...args)): Promise<string> {
  const response = await request('/config', { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Approval configuration request failed: ${response.status}`)
  const result: unknown = await response.json()
  if (!record(result) || typeof result.approvalUrl !== 'string') throw new Error('Invalid approval URL')
  const url = new URL(result.approvalUrl)
  if (url.username || url.password || url.pathname !== '/approval' || url.search || url.hash
    || url.origin !== result.approvalUrl.slice(0, -'/approval'.length)
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid approval URL')
  }
  return url.href
}
