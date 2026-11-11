/** Stream local candidate data backups to private files while the application is stopped. */
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
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
