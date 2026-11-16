/** Caller-owned public inputs and synthetic storage identities; no SDK, mount or existing credential is opened. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)

/** Create a fresh fixture using the real built parsers selected by the caller's install anchor.
 * @param sources Directory containing the explicitly supplied public SDK source files and Linux x64 rg bytes.
 * @param installAnchor Existing build's package.json; only dependency resolution and public package metadata are read.
 * @returns Isolated inputs, expected search output and cleanup for this fixture alone.
 */
export function producerFixture(sources, installAnchor) {
  if (!sources || !installAnchor || !path.isAbsolute(sources) || !path.isAbsolute(installAnchor)) {
    throw new Error('Set absolute DSH_DEPLOY_TEST_PUBLIC_INPUTS and DSH_DEPLOY_TEST_INSTALL_ANCHOR before running producer tests.')
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-public-producer-'))
  const created = []
  const write = (relative, value) => {
    const name = path.join(directory, relative)
    fs.mkdirSync(path.dirname(name), { recursive: true })
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n'
    fs.writeFileSync(name, bytes, { flag: 'wx', mode: 0o600 }); created.push(name)
    return name
  }
  const readPublic = name => {
    const file = path.join(sources, name), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('An ordinary caller-supplied public fixture is required: ' + name)
    return fs.readFileSync(file)
  }
  const ref = file => ({ path: file, sha256: digest(fs.readFileSync(file)) })
  try {
    const packageRoots = {}
    for (const [name, relative] of Object.entries({ 'dsh-pe-cloud-files': 'packages/cloud/pe-cloud-files',
      'dsh-pe-opensandbox': 'packages/cloud/pe-opensandbox', 'dsh-app-boot': 'packages/boot/app-boot' })) {
      const packageName = '@deepseek-ai/' + name
      packageRoots[name] = path.join(path.dirname(installAnchor), relative)
      const metadata = JSON.parse(fs.readFileSync(path.join(packageRoots[name], 'package.json')))
      if (metadata.name !== packageName || !fs.existsSync(path.join(packageRoots[name], 'lib/index.js'))) {
        throw new Error('Build the matching checkout before the producer artifact tests: ' + packageName)
      }
      const target = path.join(directory, 'install/node_modules', packageName)
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(packageRoots[name], target, 'dir')
    }
    const anchor = write('install/package.json', { name: 'owned-producer-fixture', private: true, type: 'module' })
    write('install/packages/fs/tool-fs-search/package.json', { name: 'owned-search-resolution-fixture', private: true })
    const rg = readPublic('ripgrep-linux-x64-1.18.0.public')
    const rgPath = write('public/ripgrep-linux-x64', rg)
    // Only the platform-specific path lookup is replaced; the exact real Linux bytes still pass the producer's SHA/ELF checks.
    write('install/node_modules/@vscode/ripgrep/package.json', { name: '@vscode/ripgrep', main: 'index.cjs' })
    write('install/node_modules/@vscode/ripgrep/index.cjs', 'exports.rgPath=' + JSON.stringify(rgPath) + '\n')
    const publicSources = {}
    for (const [key, file] of Object.entries({ config: 'config.py', dockerService: 'dockerService.py', containerOps: 'containerOps.py',
      deletionCompletion: 'deletionCompletion.py', originalCompletion: 'originalCompletion.py', nativeSeccomp: 'nativeSeccomp.json' })) {
      publicSources[key] = ref(write('public/' + file, readPublic('public-sdk/' + file)))
    }
    const supplierSource = fs.readFileSync(path.join(packageRoots['dsh-pe-opensandbox'], 'runtime/server/completion_view.py'))
    const supplierCompletionSource = ref(write('public/supplier-completion.py', supplierSource))
    const verifier = ref(write('public/verify-science-sdk-v2.py', readPublic('public-sdk/verify-science-sdk-v2.py')))
    let sequence = 0
    const domain = rootPath => {
      const index = ++sequence
      return { rootPath, rootDevice: String(index), rootInode: '2', rootMountId: String(index + 100),
        minimumBytes: '4096', maximumBytes: '8192', minimumInodes: '100', maximumInodes: '200',
        backing: { path: '/fixture-backing-' + index, device: index === 1 ? '900' : '1', inode: String(index + 1000), bytes: '8192' } }
    }
    const arena = domain('/fixture-arena'); arena.minimumBytes = arena.maximumBytes = arena.backing.bytes = '262144'
    const plan = { version: 3, recipeVersion: 'synthetic-producer-input', appUid: 2000, appGid: 2000, arenaReserveBytes: '8192',
      arena, control: domain('/fixture-control'), baseConfigPath: '/opt/dsh-features/account-base.yml',
      installAnchor: anchor, auxiliary: [], maxAccounts: 3, slots: [1, 2, 3].map(index => {
        const storageKey = 'v1-' + String(index).repeat(64), accountRoot = '/fixture-accounts/' + storageKey
        return { slotId: 'account-slot-' + index, templateId: 'standard', storageKey, accountRoot,
          private: domain(accountRoot + '/private'), projects: domain(accountRoot + '/projects'),
          environmentBank: { bankId: 'bank-' + index, mode: 'session-directories',
            slots: [{ slotId: 'slot-0', domain: domain(accountRoot + '/environments/slot-0') }] } }
      }) }
    const planReference = { ...ref(write('storage-plan.json', plan)), finalPath: '/run/dsh-feature-root/storage-plan.json' }
    const sdk = JSON.parse(readPublic('science-sdk-v2.parameters.public-template.json'))
    const manifest = fs.readFileSync(path.join(packageRoots['dsh-pe-opensandbox'], 'src/bootstrap/asset-manifest.ts'), 'utf8')
    const payload = manifest.match(/export const SOURCE_DIGEST = '([a-f0-9]{64})'/)?.[1]
    if (!payload) throw new Error('The supplied build requires its matching declared bootstrap source digest.')
    Object.assign(sdk, { installAnchor: anchor, publicSources, supplierCompletionSource, verifier, plan: planReference,
      images: { workload: 'sha256:32c17c742af43a6d9c89c69441fbc543751af41b0f61bf8294ed00ac3a4df62f',
        server: 'sha256:e4fc713db05339d41b70215f2ffdbc1c37f8948b92c949eb4cd2c164ce90038a',
        execd: 'sha256:ca4ff631193b68ba0a47622773389b054994c77971cf2859c6beacf6cb9314de' },
      payloadSha256: payload,
      backend: { containerId: 'b'.repeat(64), dataRoot: '/backend-store',
        generation: { backendId: 'b'.repeat(64), pid: 7, startTicks: '12345', mountNamespace: 'mnt:[12345]' },
        socket: { path: '/run/backend/docker.sock', device: 1, inode: 2 }, engineEndpoint: 'unix:///run/backend/docker.sock' } })
    Object.assign(sdk.sdk, { backendIpv4: '192.0.2.25', lifecycleBaseUrl: 'http://192.0.2.25:18100/v1',
      backendWorkPath: '/fixture-sdk-work', backendIsolationPath: '/fixture-sdk-work/isolation.toml' })
    const searchConfig = { id: 'fixture-search', plugins: [{ id: 'search', name: '@deepseek-ai/dsh-tool-fs-search',
      config: { rawOutputMaxBytes: 8192, stderrMaxBytes: 8192, retained: 'same-setting' } }] }
    const otherConfig = { id: 'fixture-unchanged', plugins: [] }
    const base = [{ id: 'fixture-search', name: 'cordis:agent-preset', config: searchConfig },
      { id: 'fixture-unchanged', name: 'cordis:agent-preset', config: otherConfig }]
    const baseRef = ref(write('search-base.json', base)), skeleton = ref(write('search-skeleton.json', []))
    const search = { schema: 'dsh-combined-root-profile/v3', installAnchor: anchor, accountSkeleton: skeleton,
      paths: { nativeConfigPath: baseRef.path }, nativeBaseSha256: baseRef.sha256,
      runtime: { accountPolicy: { presets: base.map(row => ({ entryId: row.id, configSha256: digest(canonical(row.config)) })) } },
      execution: { managed: { commands: { allowedTools: ['bash', 'retained-tool'], additionalTools: ['retained-tool'], unchangedLimit: 17 } } },
      untouched: { publicFixture: true } }
    return { directory, created, sdk, search, plan,
      sdkInput: write('sdk-input.json', sdk), searchInput: write('search-input.json', search),
      expectedSearchSkeleton: [{ id: 'fixture-search', config: { ...searchConfig, plugins: [{ ...searchConfig.plugins[0],
        config: { rawOutputMaxBytes: 4096, stderrMaxBytes: 4096, retained: 'same-setting' } }] } }],
      declarationDigest: value => digest(canonical(value)),
      output: path.join(directory, 'new-output'), write, ref,
      cleanup: () => { fs.rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true }); throw error
  }
}
