/** Static image policy and Dockerfile input verification with tiny SDK substitutes; never builds or runs an image. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const dockerfile = await readFile(new URL('../Dockerfile.office-preview', import.meta.url), 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const command = dockerfile.match(/RUN node --input-type=module -e '([\s\S]+?)'\n/u)?.[1].replace(/\\\n/gu, '')
assert.ok(command, 'Dockerfile must retain an executable inventory verification step')

async function fixture(t) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'pe-office-image-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'runtime')
  await mkdir(root, { mode: 0o755 }); await chmod(root, 0o755)
  const files = new Map([
    ['package.json', '{"private":true,"type":"module"}\n'],
    ['office-preview.mjs', await readFile(new URL('../office-preview.mjs', import.meta.url))],
    ['office-preview-docx.mjs', await readFile(new URL('../office-preview-docx.mjs', import.meta.url))],
    ['office-preview-contract.mjs', 'export const officePreviewJobSchema={parse(){throw Error("fixture only")}};export const officePreviewResultSchema=officePreviewJobSchema;export const officePreviewFailureSchema=officePreviewJobSchema;\n'],
    ['node_modules/@deepseek-ai/libreoffice-kit/package.json', JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.1.1', type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' } })],
    ['node_modules/@deepseek-ai/libreoffice-kit/index.js', 'export const ENGINE_VERSION="0.1.1";export const discoverRuntime=async()=>({version:"0.1.1",backend:"wasm"});export const createConverter=()=>{throw Error("conversion must not start during image verification")};\n'],
    ['node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json', JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.1' })],
    ['node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/engine.wasm', 'tiny physical WASM substitute'],
  ])
  const inventory = { protocolVersion: 1, sdkVersion: '0.1.1', backend: 'wasm', target: { platform: 'linux', arch: process.arch }, files: [] }
  const directories = new Set([root])
  for (const [path, bytes] of files) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    for (let directory = dirname(target); directory !== root; directory = dirname(directory)) directories.add(directory)
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 }); await chmod(target, 0o644)
    inventory.files.push({ path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes), mode: 0o644 })
  }
  for (const directory of directories) await chmod(directory, 0o755)
  const save = async () => {
    await writeFile(join(root, 'office-preview-closure.json'), JSON.stringify(inventory), { mode: 0o644 })
    await chmod(join(root, 'office-preview-closure.json'), 0o644)
  }
  await save()
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    command.replace('const root = "/opt/power-evolve";', `const root = ${JSON.stringify(root)};`)],
  { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
  return { root, inventory, save, run }
}

test('parser recipe pins the existing base and signed snapshots with only required apt packages', async () => {
  const original = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  assert.equal(dockerfile.split('\n')[0], original.split('\n')[0])
  assert.match(dockerfile, /^FROM node:22\.23\.2-bookworm-slim@sha256:[a-f0-9]{64}$/mu)
  assert.match(dockerfile, /http:\/\/snapshot\.debian\.org\/archive\/debian\/20260901T000000Z/u)
  assert.match(dockerfile, /http:\/\/snapshot\.debian\.org\/archive\/debian-security\/20260901T000000Z/u)
  assert.equal(dockerfile.match(/Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring\.gpg/gu)?.length, 2)
  const packages = dockerfile.match(/apt-get install -y --no-install-recommends([\s\S]+?)&& rm/u)[1]
    .replace(/\\\n/gu, ' ').trim().split(/\s+/u)
  assert.deepEqual(packages, ['poppler-utils', 'fontconfig', 'fonts-liberation', 'fonts-noto-cjk', 'fonts-wqy-zenhei', 'fonts-texgyre'])
  assert.doesNotMatch(dockerfile, /allow-unauthenticated|trusted=yes|Trusted: yes|Acquire::AllowInsecure/iu)
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\* \/var\/cache\/apt\/archives\/\*/u)
})

test('parser recipe accepts only copied runtime resources and keeps fixed nonroot one-task startup', () => {
  const directives = dockerfile.split('\n').filter(line => /^[A-Z]+\s/u.test(line))
  assert.deepEqual(directives.filter(line => /^(COPY|ADD) /u.test(line)), ['COPY --chown=0:0 runtime/ /opt/power-evolve/'])
  assert.deepEqual(directives.filter(line => /^ENV /u.test(line)), ['ENV HOME=/tmp TMPDIR=/tmp'])
  assert.deepEqual(directives.filter(line => /^USER /u.test(line)), ['USER 1000:1000'])
  assert.deepEqual(directives.filter(line => /^WORKDIR /u.test(line)), ['WORKDIR /'])
  assert.deepEqual(directives.filter(line => /^ENTRYPOINT /u.test(line)), ['ENTRYPOINT ["node", "/opt/power-evolve/office-preview.mjs"]'])
  assert.equal(dockerfile.includes('v22.23.2'), true)
  assert.ok(dockerfile.indexOf('USER 1000:1000') < dockerfile.indexOf('RUN node --input-type=module'))
  assert.doesNotMatch(dockerfile, /^\s*(?:ARG|CMD|EXPOSE|VOLUME|HEALTHCHECK|ADD) /mu)
  assert.doesNotMatch(dockerfile, /--mount=type=secret|\b(?:npm|pnpm|yarn|pip|curl|wget)\b/u)
  assert.doesNotMatch(dockerfile, /python|build-essential|libreoffice-(?:writer|calc|impress)|runner\.mjs|\/workspace|\/home\/agent/u)
})

test('Dockerfile verification reads exact prepared bytes and loads the SDK without conversion', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(JSON.parse(f.run()), { sdkVersion: '0.1.1', backend: 'wasm', files: f.inventory.files.length })
  assert.equal((await lstat(join(f.root, 'office-preview-closure.json'))).mode & 0o777, 0o644)
})

test('Dockerfile verification rejects incomplete, modified, alias and incompatible inputs', async (t) => {
  for (const kind of ['missing', 'docx-helper', 'bytes', 'extra', 'alias', 'mode', 'directory-mode', 'duplicate', 'traversal',
    'target', 'version', 'validator']) await t.test(kind, async (t) => {
    const f = await fixture(t), asset = join(f.root, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/engine.wasm')
    if (kind === 'missing') await rm(asset)
    if (kind === 'docx-helper') await rm(join(f.root, 'office-preview-docx.mjs'))
    if (kind === 'bytes') await writeFile(asset, 'changed physical asset')
    if (kind === 'extra') await writeFile(join(f.root, 'unexpected-file'), 'extra')
    if (kind === 'alias') { await rm(asset); await symlink(join(f.root, 'package.json'), asset) }
    if (kind === 'mode') await chmod(asset, 0o600)
    if (kind === 'directory-mode') await chmod(join(f.root, 'node_modules'), 0o700)
    if (kind === 'duplicate') f.inventory.files.push({ ...f.inventory.files[0] })
    if (kind === 'traversal') f.inventory.files[0].path = '../outside'
    if (kind === 'target') f.inventory.target.platform = 'darwin'
    if (kind === 'version') f.inventory.sdkVersion = '0.1.2'
    if (kind === 'validator') {
      const content = 'export const officePreviewJobSchema={parse(){}};export const officePreviewResultSchema=officePreviewJobSchema;\n'
      await writeFile(join(f.root, 'office-preview-contract.mjs'), content)
      Object.assign(f.inventory.files.find(file => file.path === 'office-preview-contract.mjs'), { bytes: Buffer.byteLength(content), sha256: sha(content) })
    }
    await f.save()
    assert.throws(f.run, error => error.status === 1)
  })
})
