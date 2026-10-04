/** Optional isolated Office parser deployment; private registry authentication is unsupported. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../application/package.json', import.meta.url))
const { officePreviewLimits } = require('@power-evolve/contracts/office-preview')
const resourceName = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u
const image = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/u
const digest = /^[a-f0-9]{64}$/u
const timerMaximum = 2_147_483_647
const positiveFields = ['maxConcurrentParsers', 'maxRetainedJobsPerUser', 'leaseMs', 'jobDeadlineMs',
  'pollMs', 'kubernetesTimeoutMs', 'cpuMilliCores', 'memoryMiB', 'temporaryMiB']
const timerFields = ['maxConcurrentParsers', 'leaseMs', 'jobDeadlineMs', 'pollMs', 'kubernetesTimeoutMs']
const configFields = ['image', 'fontPolicyDigest', 'limits', ...positiveFields, 'terminationGraceSeconds']
const protectedRoots = ['/data/workspaces', '/data/artifacts', '/data/homes', '/data/skill-packages']

/** Fixed JSON projection in the Platform's existing private volume; never mounted in Host. */
export const officePreviewConfigPath = '/run/power-evolve/private/office-preview.json'

function refuse() { throw new Error('Invalid Office preview deployment metadata') }
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !fields.includes(key))) refuse()
}
function name(value) {
  if (typeof value !== 'string' || !resourceName.test(value)) refuse()
  return value
}
function role(value) {
  if (!['host', 'platform'].includes(value)) refuse()
}
function references(env) {
  const path = env.PE_OFFICE_PREVIEW_CONFIG_FILE || ''
  const kubeconfig = env.PE_OFFICE_PREVIEW_KUBECONFIG_FILE || ''
  if (!path && !kubeconfig) return null
  if (path !== officePreviewConfigPath || kubeconfig !== 'in-cluster') refuse()
  return { officePreviewConfigFile: path, officePreviewKubeconfigFile: kubeconfig }
}

/**
 * Validate explicit budgets and derive placement from the existing runner PVC and namespace.
 * Public images need no pull credentials; preloaded images require a separate node import check.
 * Neither declaration verifies registry availability, and parser pull secrets are not supported.
 * @param input Optional officePreview values; omission or null leaves the deployment disabled.
 * @param values Application namespace, runner namespace and storage claim from deployment values.
 * @returns Detached configuration and ConfigMap/image-access metadata, or null.
 */
export function officePreviewValues(input, values) {
  if (input === undefined || input === null) return null
  object(input, ['configMapName', 'imageAccess', ...configFields])
  if (!['public', 'preloaded'].includes(input.imageAccess)) {
    throw new Error('Office preview requires public or preloaded images; private registry pulls are unsupported')
  }
  const configMapName = name(input.configMapName)
  const namespace = name(values?.runnerNamespace), app = name(values?.namespace)
  const volumeClaimName = name(values?.storage?.runnerClaim)
  if (namespace === app || ['power-evolve-host-config', 'power-evolve-platform-config',
    values.remoteMcp?.caConfigMapName].includes(configMapName)
    || typeof input.image !== 'string' || input.image.length > 512 || !image.test(input.image)
    || typeof input.fontPolicyDigest !== 'string' || !digest.test(input.fontPolicyDigest)) refuse()
  for (const field of positiveFields) {
    if (!Number.isSafeInteger(input[field]) || input[field] <= 0
      || timerFields.includes(field) && input[field] > timerMaximum) refuse()
  }
  if (!Number.isInteger(input.terminationGraceSeconds) || input.terminationGraceSeconds < 0
    || input.terminationGraceSeconds > timerMaximum) refuse()
  const parsed = officePreviewLimits.safeParse(input.limits)
  if (!parsed.success || input.leaseMs < 2 * input.kubernetesTimeoutMs || input.pollMs >= input.leaseMs
    || input.jobDeadlineMs < parsed.data.timeoutMs) refuse()
  const config = { namespace, image: input.image, volumeClaimName,
    volumeSubPath: 'office-previews', localRoot: '/data/office-previews',
    fontPolicyDigest: input.fontPolicyDigest, limits: parsed.data }
  for (const field of [...positiveFields, 'terminationGraceSeconds']) config[field] = input[field]
  return { configMapName, imageAccess: input.imageAccess, config }
}

/**
 * Produce only the nonsecret Platform configuration; existing runner isolation remains unchanged.
 * @param values Deployment values selecting the application namespace.
 * @param selected Validated optional Office preview settings.
 * @returns A single ConfigMap, or no resources when disabled.
 */
export function officePreviewManifests(values, selected) {
  return selected === null ? [] : [{ apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: selected.configMapName, namespace: values.namespace,
      labels: { 'app.kubernetes.io/part-of': 'power-evolve' } },
    data: { 'office-preview.json': JSON.stringify(selected.config) } }]
}

/**
 * Append the one fixed ConfigMap item to the existing Platform private projection.
 * @param selected Validated optional Office preview settings.
 * @param target Application role; Host receives no configuration projection.
 * @returns Additional projected-volume sources, without a Secret or PVC root mount.
 */
export function officePreviewSources(selected, target) {
  role(target)
  return selected === null || target === 'host' ? [] : [{ configMap: {
    name: selected.configMapName, items: [{ key: 'office-preview.json', path: 'office-preview.json' }],
  } }]
}

/**
 * Advertise the Host feature switch and give only Platform the fixed parser configuration reference.
 * @param selected Validated optional Office preview settings.
 * @param target Application role.
 * @returns Nonsecret environment additions; disabled deployment has no additions.
 */
export function officePreviewEnvironment(selected, target) {
  role(target)
  if (selected === null) return {}
  return target === 'host' ? { PE_OFFICE_PREVIEW_ENABLED: '1' } : {
    PE_OFFICE_PREVIEW_CONFIG_FILE: officePreviewConfigPath, PE_OFFICE_PREVIEW_KUBECONFIG_FILE: 'in-cluster',
  }
}

/**
 * Extend the existing runner Role's core pods rule for direct parser creation and UID-fenced deletion.
 * @param selected Validated optional Office preview settings.
 * @returns Exact verbs for the existing pods-only rule; no list, exec or additional resource authority.
 */
export function officePreviewPodVerbs(selected) {
  return selected === null ? ['get', 'patch'] : ['get', 'patch', 'create', 'delete']
}

/**
 * Map deployment references to existing Profile fields and reject references in the wrong role.
 * @param target Application role.
 * @param env Deployment environment; paths and Kubernetes provider are fixed by this adapter.
 * @returns Role-specific Profile settings, explicitly disabled when feature references are absent.
 */
export function officePreviewProfile(target, env) {
  role(target)
  if (target === 'host') {
    if (env.PE_OFFICE_PREVIEW_CONFIG_FILE || env.PE_OFFICE_PREVIEW_KUBECONFIG_FILE
      || ![undefined, '', '0', '1'].includes(env.PE_OFFICE_PREVIEW_ENABLED)) refuse()
    return { officePreviewEnabled: env.PE_OFFICE_PREVIEW_ENABLED === '1' }
  }
  if (env.PE_OFFICE_PREVIEW_ENABLED) refuse()
  return references(env) ?? { officePreviewConfigFile: '', officePreviewKubeconfigFile: '' }
}

/**
 * Run the actual built Platform loader before Profile writes or child launch, then check fixed placement.
 * @param env Platform environment, including the existing runner namespace and runner claim.
 * @param readText Reader for the one projected JSON file; disabled deployment reads nothing.
 * @returns Strict runtime settings, or null when both references are absent; errors contain no input bytes.
 */
export async function validateOfficePreviewStartup(env, readText = filename => readFile(filename, 'utf8')) {
  const selected = officePreviewProfile('platform', env)
  if (!selected.officePreviewConfigFile) return null
  try {
    const namespace = name(env.PE_SANDBOX_NAMESPACE), claim = name(env.PE_SANDBOX_VOLUME_CLAIM)
    const { loadOfficePreviewConfig } = await import('../application/lib/platform/office-preview-config.js')
    const config = await loadOfficePreviewConfig(selected.officePreviewConfigFile,
      selected.officePreviewKubeconfigFile, protectedRoots, readText)
    if (!config || config.namespace !== namespace || config.volumeClaimName !== claim
      || config.volumeSubPath !== 'office-previews' || config.localRoot !== '/data/office-previews') refuse()
    return config
  } catch {
    throw new Error('Invalid Office preview deployment configuration')
  }
}
