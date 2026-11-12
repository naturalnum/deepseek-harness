/** Read-only compatibility checks for dependencies already installed in the local candidate. */
import { createHash } from 'node:crypto'
import { externalDependencyHash } from '../bundle.mjs'
import { CandidateError, execInNamespace } from './inspect.mjs'

const PRODUCT_ROOT = '/opt/dsh-installed-products'
const checksum = bytes => createHash('sha256').update(bytes).digest('hex')
const PROBE = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const root=process.argv[1],hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let sshCommandPluginReady=false,rgPath=null,rgRealPath=null,rgRegularFile=false;
try{sshCommandPluginReady=fs.statSync(path.join(root,'node_modules/@deepseek-ai/dsh-ssh-command-plugin/package.json')).isFile();}
catch(_error){/* A missing or unreadable addon remains unavailable; no installation is attempted. */}
try{
 const fromSearch=createRequire(path.join(root,'packages/fs/tool-fs-search/package.json'));
 rgPath=fromSearch('@vscode/ripgrep').rgPath;
 if(typeof rgPath==='string'){rgRegularFile=fs.lstatSync(rgPath).isFile();rgRealPath=fs.realpathSync(rgPath);}
}catch(_error){/* Keep the actual resolver result; an unresolved or unreadable binary fails preflight. */}
console.log(JSON.stringify({architecture:process.arch,nodeVersion:process.versions.node,sshCommandPluginReady,rgPath,rgRealPath,rgRegularFile,
 pnpmLock:fs.readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8'),
 researchLockHash:hash(fs.readFileSync(path.join(root,'integrations/epri-research/package-lock.json')))}));
`

/**
 * Refuse updates with different external dependencies or unavailable installed command tools.
 * @param {object} snapshot - Candidate namespace and Node executable discovered by inspectCandidate.
 * @param {object} manifest - Product bundle metadata containing externalDependencyHash and researchLockHash.
 * @param {object} adapters - Optional read-only namespace executor for fixture tests.
 * @returns {Promise<object>} Whitelisted compatibility facts, without lockfile contents or environment values.
 */
export async function preflight(snapshot, manifest, { execute = execInNamespace } = {}) {
  if (snapshot.productRoot !== PRODUCT_ROOT || !snapshot.nodePath) throw new CandidateError('候选产品目录或 Node 路径尚未确认。')
  let observed
  let installedExternalHash
  try {
    observed = JSON.parse(await execute(snapshot, [snapshot.nodePath, '-e', PROBE, PRODUCT_ROOT]))
    installedExternalHash = externalDependencyHash(observed.pnpmLock)
  } catch (_error) {
    throw new CandidateError('无法读取或解析候选环境已安装的依赖清单；没有进行更新。')
  }
  if (installedExternalHash !== manifest.externalDependencyHash || observed.researchLockHash !== manifest.researchLockHash) {
    throw new CandidateError('产品包与候选环境的外部依赖不一致；需要先准备对应的 Linux 依赖，没有进行更新。')
  }
  if (observed.sshCommandPluginReady !== true) throw new CandidateError('候选环境缺少已要求的 SSH 命令插件；没有进行更新。')
  const expectedRgPath = `${PRODUCT_ROOT}/node_modules/@vscode/ripgrep-linux-${observed.architecture}/bin/rg`
  if (!['arm64', 'x64'].includes(observed.architecture) || observed.rgPath !== expectedRgPath
    || observed.rgRealPath !== expectedRgPath || observed.rgRegularFile !== true) {
    throw new CandidateError('文件搜索程序的解析路径或实体文件与沙箱挂载路径不一致；没有进行更新。')
  }
  return {
    compatible: true, nodeVersion: observed.nodeVersion, pnpmLockHash: checksum(observed.pnpmLock),
    externalDependencyHash: installedExternalHash, researchLockHash: observed.researchLockHash,
    sshCommandPluginReady: true, rgPath: expectedRgPath,
  }
}
