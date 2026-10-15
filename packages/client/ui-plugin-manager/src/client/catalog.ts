/** Classify stable module identities independently of translated display names.
 * @param identity Original module or contribution identity.
 * @returns The matching purpose category, or other when no supported purpose matches.
 */
export function pluginCategory(identity: string): 'execution' | 'agents' | 'search' | 'integrations' | 'other' {
  if (/(?:terminal|shell|bash|sandbox)/u.test(identity)) return 'execution'
  if (/(?:agent|loop|plan|goal)/u.test(identity)) return 'agents'
  if (/(?:search|browser|fetch)/u.test(identity)) return 'search'
  if (/(?:mcp|connector|integration|power-evolve\/host)/u.test(identity)) return 'integrations'
  return 'other'
}
