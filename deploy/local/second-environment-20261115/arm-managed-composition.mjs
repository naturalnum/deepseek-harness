/** Remove the retired, unconfigured SSH command plugin from this managed Cloud composition. */
const retiredId = 'ssh-command', retiredPackage = '@deepseek-ai/dsh-ssh-command-plugin'
const need = (value, message) => { if (!value) throw new Error(message) }
/** Preserve the current Native providers and every other entry when retiring the obsolete external plugin.
 * @param rows Original public base or account patch entries.
 * @returns Entries for the current managed execution composition.
 */
export function managedAccountEntries(rows) {
  need(Array.isArray(rows), 'Public account entry array required')
  return rows.filter(row => {
    if (row.id !== retiredId && row.name !== retiredPackage) return true
    need(row.id === retiredId && row.name === retiredPackage, 'Unexpected retired SSH entry identity')
    return false
  })
}
/** Keep the exact approval and required-entry inventory aligned with the current public account entries.
 * @param original Public Root fragments or completed Root parameters.
 * @returns A new parameter object without the retired external plugin authority.
 */
export function managedRootParameters(original) {
  const result = structuredClone(original)
  need(Array.isArray(result.native?.requiredEntryIds) && Array.isArray(result.api?.approvedConfiguration?.plugins), 'Original Root policy required')
  result.native.requiredEntryIds = result.native.requiredEntryIds.filter(id => id !== retiredId)
  result.api.approvedConfiguration.plugins = result.api.approvedConfiguration.plugins.filter(row => {
    if (row.id !== retiredId && row.moduleName !== retiredPackage && row.packageName !== retiredPackage) return true
    need(row.id === retiredId && row.moduleName === retiredPackage && row.packageName === retiredPackage, 'Unexpected retired SSH approval identity')
    return false
  })
  return result
}
