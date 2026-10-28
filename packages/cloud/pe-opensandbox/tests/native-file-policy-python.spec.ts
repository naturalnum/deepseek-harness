/** Host Python normalization and bwrap argv construction only; this does not execute a namespace or user command. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { makePrepared, digest } from '../src/agent-data/canonical.ts'
import { createForegroundIssuer } from '../src/agent-data/root-role-issuer.ts'

it('binds the real Python parser/hash to Root policy and chooses read-only mounts for all user-writable roots', () => {
  const directory = fileURLToPath(new URL('../runtime/agent', import.meta.url))
  const spec = { argv: ['/bin/cat', 'file'], cwd: '/srv/project', stdin: { mode: 'ignore' as const } }
  const prepared = makePrepared('1'.repeat(64), 'readonly', spec, undefined, { mode: 'read-only' })
  const request = createForegroundIssuer('2'.repeat(64), '1'.repeat(64), () => {})(prepared)
  const program = String.raw`
import ast, json, pathlib, sys, stat, types
root=pathlib.Path(sys.argv[1]);sys.path.insert(0,str(root))
from wire import canonical, prepared_digest, request, Refused, verify_role
value=json.loads(sys.stdin.read())
body={**value['ref'],'spec':value['spec'],'filePolicy':value['filePolicy']}
request('/prepare',body,'1'*64);verify_role(body,'2'*64)
assert prepared_digest(value['spec'],None,{'mode':'read-only'})==value['ref']['specHash']
bad={**body,'filePolicy':{'mode':'workspace-write'}}
try:
 request('/prepare',bad,'1'*64)
except Refused as error:
 assert error.code=='spec_hash_mismatch'
else:
 raise AssertionError('policy tamper was accepted')
tree=ast.parse((root/'launcher.py').read_text())
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='world_argv')
env={'PATH':'/opt/session-env/venv/bin:/usr/local/bin:/usr/bin:/bin','HOME':'/opt/session-env/home','TMPDIR':'/opt/session-env/tmp','LANG':'C.UTF-8'}
scope={'project_path':lambda path:path,'ENV':env,'ENV_ROOT':'/opt/session-env'}
exec(compile(ast.Module(body=[function],type_ignores=[]),str(root/'launcher.py'),'exec'),scope)
ro=scope['world_argv']('/srv/project','read-only');rw=scope['world_argv']('/srv/project','workspace-write')
assert '--bind' not in ro
assert rw.count('--bind')==5
for path in ['/srv/project','/opt/session-env/home','/opt/session-env/venv','/opt/session-env/tmp','/tmp']:
 matches=[i for i,x in enumerate(ro) if x==path and i>=2 and ro[i-2] in ['--bind','--ro-bind']]
 assert matches and all(ro[i-2]=='--ro-bind' for i in matches)
from paths import skill_world_argv
opened={'metadataFd':10,'copies':[{'fd':11,'version':'12345678-1234-4123-8123-123456789012'}]}
ro_skills=skill_world_argv(ro,'/srv/project',opened,'read-only')
rw_skills=skill_world_argv(rw,'/srv/project',opened,'workspace-write')
assert '--bind-fd' not in ro_skills and ro_skills.count('--ro-bind-fd')==2
assert rw_skills.count('--bind-fd')==1
# Execute the actual pure verification functions against explicit synthetic statvfs facts.
# Neither the mount source facts nor a bwrap namespace is supplied by this host unit.
paths_tree=ast.parse((root/'paths.py').read_text())
checks=[node for node in paths_tree.body if isinstance(node,ast.FunctionDef) and node.name in ['verify_file_policy','verify_skill_world']]
project='/srv/project';version=opened['copies'][0]['version'];flags={}
def info(inode): return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_dev=1,st_ino=inode,st_uid=0,st_gid=0)
facts={project:info(11),project+'/.pe':info(12),project+'/.pe/skills':info(13),project+'/.pe/skills/'+version:info(14)}
fake_os=types.SimpleNamespace(ST_RDONLY=1,statvfs=lambda path:types.SimpleNamespace(f_flag=flags[path]),lstat=lambda path:facts[path],listdir=lambda path:[version])
verification={'project_path':lambda path:path,'ENV_ROOT':'/opt/session-env','os':fake_os,'stat':stat}
exec(compile(ast.Module(body=checks,type_ignores=[]),str(root/'paths.py'),'exec'),verification)
writable=[project,'/opt/session-env/home','/opt/session-env/venv','/opt/session-env/tmp','/tmp']
for mode,flag in [('read-only',1),('workspace-write',0)]:
 flags.update({path:flag for path in writable})
 verification['verify_file_policy'](project,mode)
 for path in writable:
  flags[path]=1-flag
  try: verification['verify_file_policy'](project,mode)
  except ValueError: pass
  else: raise AssertionError('mismatched writable mount was accepted')
  flags[path]=flag
 grant={'metadata':{'device':'1','inode':'12'},'skills':{'device':'1','inode':'13'},'maxCopies':1,'copies':[{'version':version,'identity':{'device':'1','inode':'14'}}]}
 flags[project+'/.pe']=flags[project+'/.pe/skills']=1;flags[project+'/.pe/skills/'+version]=flag
 verification['verify_skill_world'](project,[1,11],grant,mode)
 flags[project+'/.pe/skills/'+version]=1-flag
 try: verification['verify_skill_world'](project,[1,11],grant,mode)
 except ValueError: pass
 else: raise AssertionError('mismatched skill-copy mount was accepted')
print(json.dumps({'hash':value['ref']['specHash'],'readonlyArgv':ro,'writableArgv':rw,'tamperDenied':True,'skillReadonly':True,'syntheticMountMismatchDenied':True,'kernelExecuted':False}))
`
  const raw = execFileSync('python3', ['-I', '-S', '-B', '-c', program, directory], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 10000,
  })
  const result = JSON.parse(raw) as {
    hash: string
    readonlyArgv: string[]
    writableArgv: string[]
    tamperDenied: boolean
    skillReadonly: boolean
    syntheticMountMismatchDenied: boolean
    kernelExecuted: false
  }
  expect(result.hash).not.toBe(digest(spec))
  expect(result.tamperDenied).toBe(true)
  expect(result.readonlyArgv).not.toContain('--bind')
  expect(result.writableArgv).toContain('--bind')
  expect(result.skillReadonly).toBe(true)
  expect(result.syntheticMountMismatchDenied).toBe(true)
  expect(result.kernelExecuted).toBe(false)
})
