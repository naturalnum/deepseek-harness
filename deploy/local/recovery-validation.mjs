/** Validate the preserved candidate through the same installed parsers and Loader schemas as the Root generator. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { CandidateError } from './inspect.mjs'

const HOME = '/run/dsh-feature-root'
const SCHEMAS = ['runtime-root', 'api-root', 'files-root', 'execution-root', 'access-root', 'connection']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw new CandidateError('恢复候选未通过原产品解析器或Loader校验；不发布ready，保留原件和旁路文件。') }

/**
 * Validate actual candidate buffers before the original FD4 ready publication; never rewrite their bytes.
 * @param {object} prepared Exact six-file rebuild result; credentials remain secret-bearing owned buffers.
 * @param {object} settings Actual captured installAnchor and optional installed-module loader for focused tests.
 * The normal caller omits load and resolves the existing qualified product, never the host source worktree.
 * @returns {Promise<object>} Nonsecret validation facts. Any original refusal stops publication and emits no
 * parser message, credential content, or synthesized replacement input.
 */
export async function validateRecoveryInputs(prepared, { installAnchor, load } = {}) {
  try {
    const require = createRequire(installAnchor)
    const installed = load ?? (name => import(pathToFileURL(require.resolve(name)).href))
    const file = name => {
      const found = prepared.files.filter(row => row.relativePath === name)
      if (found.length !== 1 || !Buffer.isBuffer(found[0].bytes)) fail()
      return found[0].bytes
    }
    const json = name => JSON.parse(file(name).toString('utf8').replace(/^\uFEFF/, ''))
    const rows = json('profiles/cloud/cordis.patch.yml').flatMap(operation => operation.insert ?? [])
    const row = id => { const found = rows.filter(value => value.id === id); if (found.length !== 1) fail(); return found[0] }
    for (const id of SCHEMAS) {
      const value = row(id), namespace = await installed(value.name)
      const schema = namespace.Config ?? namespace.default?.Config
      if (typeof schema !== 'function') fail()
      schema(value.config)
    }
    const { parseRootDeploymentInput } = await installed('@deepseek-ai/dsh-pe-opensandbox')
    const { parseStorageDeploymentPlan } = await installed('@deepseek-ai/dsh-pe-cloud-files/root')
    const { parseCredentialsDocument } = await installed('@deepseek-ai/dsh-credentials-local')
    const deployment = parseRootDeploymentInput(json('rootDeployment.json'))
    const runtime = row('runtime-root').config, execution = row('execution-root').config
    const planBytes = file('storage-plan.json'), measured = parseStorageDeploymentPlan(planBytes, runtime.paths.maxPathBytes)
    parseCredentialsDocument(file('credentials.json').toString('utf8'), HOME + '/credentials.json')
    if (deployment.schema !== 'pe-opensandbox-root-deployment-v2' || measured.version !== 3 || measured.slots.length !== 3 || measured.maxAccounts !== 3
      || deployment.storage.plan.path !== HOME + '/storage-plan.json' || deployment.storage.plan.sha256 !== hash(planBytes)
      || row('files-root').config.staticStorage.planPath !== deployment.storage.plan.path
      || row('files-root').config.staticStorage.planSha256 !== deployment.storage.plan.sha256
      || execution.rootDeployment.path !== HOME + '/rootDeployment.json' || execution.rootDeployment.sha256 !== hash(file('rootDeployment.json'))
      || measured.installAnchor !== installAnchor || measured.baseConfigPath !== runtime.native.configPath
      || row('credentials').config.path !== HOME + '/credentials.json'
      || deployment.lifecycle.environmentVersion !== execution.managed.allocations.environmentVersion
      || deployment.lifecycle.provider !== execution.managed.allocations.provider) fail()
    return { validatedLoaderSchemas: [...SCHEMAS], protectedDeploymentParsed: true, planParsed: true, credentialsParsed: true }
  } catch (_error) { fail() }
}
