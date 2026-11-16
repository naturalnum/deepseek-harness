/** Exact public settings and same-account credential naming for this local ARM target. */
export const ARM_MODEL_REFERENCE = 'DEEPSEEK_API_KEY'
const originalReference = 'DSH_SDK_ARM_MODEL_REFERENCE'
const need = (value, message) => { if (!value) throw new Error(message) }
/** Keep the original protected Web policy and explicit three-lane Files capacities. */
export function armValidationParameters(value) {
  const result = structuredClone(value)
  need(result.model && [originalReference, ARM_MODEL_REFERENCE, 'REQUIRED_NEW_MODEL_API_KEY_REF'].includes(result.model.apiKeyRef), 'Exact local model reference required')
  result.model.apiKeyRef = ARM_MODEL_REFERENCE
  need(result.files?.maxResidentBytes === 536870912 || result.files?.maxResidentBytes === 671088640, 'Exact original Files global budget required')
  result.files.maxResidentBytes = 671088640
  for (const binding of result.api?.approvedConfiguration?.modelKey?.bindings ?? []) {
    if (binding.ref === originalReference) binding.ref = ARM_MODEL_REFERENCE
  }
  return result
}
/** Add only an alias of this same new account's supplied reference; never import another credential. */
export function armValidationCredentials(value) {
  need(value?.version === 1 && value.refs && !Array.isArray(value.refs) && value.records && !Array.isArray(value.records), 'Original credential document required')
  const key = value.refs[originalReference]
  need(typeof key === 'string' && key.length > 0, 'This target own model reference required')
  need(!Object.hasOwn(value.refs, ARM_MODEL_REFERENCE) || value.refs[ARM_MODEL_REFERENCE] === key, 'Conflicting canonical reference retained')
  need(!Object.hasOwn(value.records, ARM_MODEL_REFERENCE), 'Canonical credential record already owned')
  return { ...value, refs: { ...value.refs, [ARM_MODEL_REFERENCE]: key } }
}
