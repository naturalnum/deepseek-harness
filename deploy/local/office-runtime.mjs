/** Validate and stage the Host manifest for the selected execution image before deployment. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const need = (condition, message) => { if (!condition) throw new Error(message) }

/**
 * Validate an extracted, digest-pinned image manifest with the actual installed Native parser.
 * The Root extracting the file owns the image/file association; this check never queries a Session.
 * @param reference Root-supplied path, sha256 and workloadImageDigest from image extraction.
 * @param selection Exact image digest and OCI platform from the protected Root deployment.
 * @param installAnchor Matching product package.json used to resolve the published parser.
 * @returns Original manifest bytes, normalized metadata and the image/file receipt.
 */
export async function prepareOfficeRuntime(reference, selection, installAnchor) {
  const selectedImage = selection.imageDigest
  need(reference && /^sha256:[a-f0-9]{64}$/.test(selectedImage)
    && reference.workloadImageDigest === selectedImage, 'Office runtime must belong to the selected workload image')
  need(typeof reference.path === 'string' && path.isAbsolute(reference.path)
    && path.basename(reference.path) === 'runtime.json'
    && /^[a-f0-9]{64}$/.test(reference.sha256), 'A pinned extracted runtime.json is required')
  const stat = fs.lstatSync(reference.path)
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1048576,
    'A bounded regular Office runtime manifest is required')
  const bytes = fs.readFileSync(reference.path)
  need(digest(bytes) === reference.sha256, 'Extracted Office runtime manifest changed')
  const require = createRequire(pathToFileURL(installAnchor))
  const { parsePrimaryRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-workspace-dependencies')).href)
  const manifest = parsePrimaryRuntime(JSON.parse(bytes))
  const arch = { amd64: 'x64', arm64: 'arm64' }[selection.platform]
  need(arch !== undefined && manifest.arch === arch && manifest.platform === 'linux',
    'Office runtime platform differs from the selected workload image')
  return { bytes, manifest, receipt: { schema: 'dsh-office-runtime/v1', workloadImageDigest: selectedImage,
    manifestSha256: reference.sha256, platform: manifest.platform, arch: manifest.arch } }
}

/**
 * Write only a fresh staging directory; the deployment installer owns the final read-only mount.
 * @param prepared Result of prepareOfficeRuntime for this deployment.
 * @param directory New directory to carry runtime.json and its image-binding receipt.
 */
export function stageOfficeRuntime(prepared, directory) {
  fs.mkdirSync(directory, { mode: 0o755 })
  for (const [name, bytes] of [['runtime.json', prepared.bytes], ['IMAGE.json', JSON.stringify(prepared.receipt, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o444 })
  }
}

/** Require every configured image-bound dependency tool to have a staged matching manifest.
 * @param entries Actual composed Native account entries.
 * @param prepared Validated selected-image manifest, or undefined for compositions without the tool.
 * @returns Final absolute Host manifest installation targets.
 */
export function officeRuntimeTargets(entries, prepared) {
  const targets = []
  for (const entry of entries.filter(row => row.name === '@deepseek-ai/dsh-tool-workspace-dependencies' && !row.disabled)) {
    const config = entry.config
    need(prepared && typeof config?.executionManifest === 'string' && path.isAbsolute(config.executionManifest)
      && typeof config.source === 'string' && path.isAbsolute(config.source) && config.root === undefined,
    'Image-bound workspace dependencies require a staged Office runtime manifest')
    targets.push(path.join(config.executionManifest, 'runtime.json'))
  }
  return [...new Set(targets)]
}

/**
 * Produce a complete fresh feature mount instead of copying only account-base.yml and node_modules.
 * @param prepared Validated manifest for the selected workload.
 * @param input Original account bytes, final guest targets, product location and fresh output directory.
 * @returns The directory to mount read-only at the existing guest feature root.
 */
export function stageOfficeFeatureAssets(prepared, input) {
  const relativeTargets = input.targets.map(target => {
    const relative = path.relative(path.dirname(input.nativeConfigPath), target)
    const first = relative.split(path.sep)[0]
    need(relative !== '' && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative),
      'Office manifest target must remain inside the feature mount')
    need(first !== 'node_modules' && first !== path.basename(input.nativeConfigPath),
      'Office manifest target must remain outside reserved feature mount entries')
    return relative
  })
  fs.mkdirSync(input.directory, { mode: 0o755 })
  fs.writeFileSync(path.join(input.directory, path.basename(input.nativeConfigPath)), input.accountBaseBytes,
    { flag: 'wx', mode: 0o444 })
  fs.symlinkSync(path.join(input.productRoot, 'node_modules'), path.join(input.directory, 'node_modules'), 'dir')
  for (const relative of relativeTargets) {
    const directory = path.join(input.directory, path.dirname(relative))
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o755 })
    stageOfficeRuntime(prepared, directory)
  }
  return input.directory
}
