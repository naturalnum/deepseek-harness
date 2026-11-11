/** Stream local candidate data backups to private files while the application is stopped. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { list } from 'tar'
import { CANDIDATE_CONTAINER, CandidateError, execInNamespace } from './inspect.mjs'

export const DATABASE_CONTAINER = 'dsh-feature-integration-pg-20261107'

/** Copy a Docker command's binary stdout directly into a new private host file. */
export async function dockerToFile(args, filename) {
  const file = await open(filename, 'wx', 0o600)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', file.fd, 'ignore'] })
      child.once('error', () => reject(new CandidateError('无法启动候选数据备份。')))
      child.once('exit', (code, signal) => code === 0 && signal === null
        ? resolve() : reject(new CandidateError('候选数据备份未完成。', code)))
    })
    await file.sync()
  } finally { await file.close() }
}

/** Read only public storage paths and database names from the current generated configuration. */
export async function dataLayout(snapshot) {
  const code = String.raw`
const fs=require('node:fs'),home=process.argv[1];
const text=fs.readFileSync(home+'/profiles/cloud/cordis.patch.yml','utf8');
function values(key){const r=new RegExp('["\\\']?'+key+'["\\\']?\\s*:\\s*["\\\']?([^"\\\'\\s,}]+)','g');return [...new Set([...text.matchAll(r)].map(x=>x[1]))]}
const plans=values('planPath').filter(x=>x.startsWith('/'));
const databases=values('database').filter(x=>/^[a-zA-Z0-9_]+$/.test(x));
if(plans.length!==1||databases.length!==1)throw Error('ambiguous storage or database');
const plan=JSON.parse(fs.readFileSync(plans[0],'utf8'));
const roots=plan.slots.map(slot=>slot.accountRoot);
if(!roots.length||roots.some(x=>typeof x!=='string'||!x.startsWith('/srv/')))throw Error('invalid account roots');
console.log(JSON.stringify({database:databases[0],roots:[...new Set(roots)],planPath:plans[0]}));`
  return JSON.parse(await execInNamespace(snapshot, [snapshot.nodePath, '-e', code, snapshot.profileHome]))
}

/** Back up the database and mounted account files after a confirmed normal application exit. */
export async function backupData(snapshot, directory, layout) {
  if (!snapshot.namespacePid) throw new CandidateError('数据备份缺少保留的命名空间。')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await dockerToFile(['exec', DATABASE_CONTAINER, '/bin/sh', '-c',
    'exec pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "$1"', 'pe-cloud-backup', layout.database],
  join(directory, 'database.dump'))
  await dockerToFile(['exec', CANDIDATE_CONTAINER, 'nsenter', '-t', String(snapshot.namespacePid),
    '-m', '--root', '--wd=/', 'tar', '-czf', '-', '-C', '/', '--', ...layout.roots.map(root => root.slice(1))],
  join(directory, 'accounts.tar.gz'))
  console.log('备份：数据库和账号文件已写入权限为 0600 的本机文件')
}

async function fileToDocker(filename, args) {
  const file = await open(filename, 'r')
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: [file.fd, 'ignore', 'ignore'] })
      child.once('error', () => reject(new CandidateError('无法启动候选数据恢复。')))
      child.once('exit', (code, signal) => code === 0 && signal === null
        ? resolve() : reject(new CandidateError('候选数据恢复未完成。', code)))
    })
  } finally { await file.close() }
}

/**
 * Index only complete selected account trees; links never authorize archive descendants or outside hardlinks.
 * @param {object[]} members - Tar member paths, types and optional link targets.
 * @param {string[]} accountRoots - Absolute selected account roots.
 * @returns {{roots: string[], entries: object[]}} Validated absolute paths and their backup types.
 */
export function indexAccountArchive(members, accountRoots) {
  const roots = [...new Set(accountRoots)]
  if (!roots.length || roots.some(root => typeof root !== 'string' || !root.startsWith('/') || root === '/'
    || root.includes('\\') || root.includes('\0') || posix.normalize(root) !== root)
    || roots.some(root => roots.some(other => other !== root && root.startsWith(`${other}/`)))) {
    throw new Error('账号备份根目录必须是独立的绝对目录。')
  }
  function absolute(name) {
    if (typeof name !== 'string') throw new Error('账号备份成员路径无效。')
    const path = name.replace(/\/+$/, '')
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
      || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('账号备份成员不能越界。')
    const result = `/${path}`
    if (!roots.some(root => result === root || result.startsWith(`${root}/`))) throw new Error('账号备份包含未选定的目录。')
    return result
  }
  const indexed = new Map()
  for (const member of members) {
    const path = absolute(member.path)
    if (indexed.has(path) || !['Directory', 'File', 'SymbolicLink', 'Link'].includes(member.type)) {
      throw new Error('账号备份包含重复或不支持的成员。')
    }
    indexed.set(path, { path, type: member.type,
      ...(member.type === 'Link' ? { linkpath: absolute(member.linkpath) } : {}) })
  }
  for (const root of roots) if (indexed.get(root)?.type !== 'Directory') throw new Error('账号备份缺少完整的根目录。')
  for (const member of [...indexed.values()]) {
    const root = roots.find(value => member.path === value || member.path.startsWith(`${value}/`))
    for (let parent = posix.dirname(member.path); parent.startsWith(`${root}/`) || parent === root; parent = posix.dirname(parent)) {
      if (indexed.has(parent) && indexed.get(parent).type !== 'Directory') throw new Error('账号备份成员不能穿过文件或符号链接。')
      if (!indexed.has(parent)) indexed.set(parent, { path: parent, type: 'Directory' })
      if (parent === root) break
    }
    if (member.type === 'Link' && indexed.get(member.linkpath)?.type !== 'File') throw new Error('账号备份硬链接缺少选定目录内的文件。')
  }
  return { roots: roots.sort(), entries: [...indexed.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}

/** Read backup headers without extracting or exposing any account file contents. */
export async function readAccountArchiveIndex(filename, roots) {
  const members = []
  await list({ file: filename, strict: true, onReadEntry(entry) {
    members.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath })
  } })
  return indexAccountArchive(members, roots)
}

/**
 * Remove post-backup entries without following links or replacing retained roots and directories.
 * @param {object} index - Validated account backup index.
 * @param {string[]} mountPoints - Current namespace mount targets; never remove an unbacked mounted directory.
 * @returns {{removedFiles: number, removedDirectories: number}} Cleanup counts; paths and contents are not returned.
 */
export function pruneAccountDirectories(index, mountPoints = []) {
  const expected = new Map(index.entries.map(entry => [entry.path, entry.type]))
  const mounts = new Set(mountPoints)
  const removals = []
  function visit(path, parentDevice) {
    const info = fs.lstatSync(path)
    const type = expected.get(path)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if ((mounts.has(path) || info.dev !== parentDevice) && type !== 'Directory') {
        throw new Error('当前账号存在备份未覆盖的挂载目录，尚未清理文件。')
      }
      for (const child of fs.readdirSync(path)) visit(posix.join(path, child), info.dev)
      if (type !== 'Directory') removals.push({ path, directory: true })
    } else {
      const retained = info.isSymbolicLink() ? type === 'SymbolicLink' : info.isFile() && ['File', 'Link'].includes(type)
      if (!retained) removals.push({ path, directory: false })
    }
  }
  // Discover the complete plan before deleting anything, including failures in another selected root.
  for (const root of index.roots) {
    let current = '/'
    for (const part of root.slice(1).split('/')) {
      current = posix.join(current, part)
      const info = fs.lstatSync(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('账号根目录或其父目录不能是符号链接或普通文件。')
    }
    const info = fs.lstatSync(root)
    for (const child of fs.readdirSync(root)) visit(posix.join(root, child), info.dev)
  }
  let removedFiles = 0, removedDirectories = 0
  for (const entry of removals) {
    if (entry.directory) { fs.rmdirSync(entry.path); removedDirectories++ }
    else { fs.unlinkSync(entry.path); removedFiles++ }
  }
  return { removedFiles, removedDirectories }
}

const PRUNE = `const fs=require('node:fs'),posix=require('node:path').posix;
const prune=${pruneAccountDirectories.toString()};
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>raw+=chunk);
process.stdin.on('end',()=>{try{
 const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(line=>line.split(' ')[4].replace(/\\\\([0-7]{3})/g,(_match,octal)=>String.fromCharCode(parseInt(octal,8))));
 console.log(JSON.stringify(prune(JSON.parse(raw),mounts)));
}catch(_error){console.error('账号目录恢复清理未完成。');process.exitCode=1}});`

/** Restore the captured database and account contents only when rollback crosses a data-format change. */
export async function restoreData(snapshot, directory, layout, archivePath) {
  const accountsArchive = join(directory, 'accounts.tar.gz')
  const index = await readAccountArchiveIndex(accountsArchive, layout.roots)
  await execInNamespace(snapshot, ['/bin/sh', '-c', 'umask 077; cat > "$1"', 'pe-cloud-data', archivePath],
    { input: await readFile(accountsArchive) })
  await fileToDocker(join(directory, 'database.dump'), ['exec', '--interactive', DATABASE_CONTAINER,
    '/bin/sh', '-c', 'exec pg_restore --single-transaction --exit-on-error --clean --if-exists -U "${POSTGRES_USER:-postgres}" -d "$1"',
    'pe-cloud-restore', layout.database])
  await execInNamespace(snapshot, [snapshot.nodePath, '-e', PRUNE], { input: JSON.stringify(index) })
  await execInNamespace(snapshot, ['tar', '-xzf', archivePath, '-C', '/'])
  console.log('恢复：已恢复升级前的数据库与账号文件备份')
}
