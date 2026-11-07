/** Real process checks for the Git child used below the original managed Python range. */
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {expect,it,onTestFinished,vi} from 'vitest'

async function runGit(script:string,maxPayloadBytes:number){
  const root=await mkdtemp(join(tmpdir(),'research-git-pipe-'))
  onTestFinished(()=>rm(root,{recursive:true,force:true}))
  const id='.research-'+randomUUID(),path=join(root,id+'.py'),wrapper=join(root,'fixed-git')
  await writeFile(path,await readFile(new URL('../plugins/cloud/git-runner.py',import.meta.url)))
  await writeFile(join(root,id+'-bootstrap.py'),'# exact paired loader\n')
  await writeFile(wrapper,'#!/usr/bin/python3\n'+script,{mode:0o700})
  const child=spawn('/usr/bin/python3',['-I','-c',"import resource,runpy,sys; resource.setrlimit(resource.RLIMIT_NOFILE,(128,128)); runpy.run_path(sys.argv[1],run_name='__main__')",path],{cwd:root,detached:true,stdio:['pipe','pipe','pipe']})
  const stdout:Buffer[]=[],stderr:Buffer[]=[]
  child.stdout.on('data',(chunk:Buffer)=>stdout.push(chunk));child.stderr.on('data',(chunk:Buffer)=>stderr.push(chunk))
  const closed=once(child,'close').then(([code])=>({code,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString()}))
  child.stdin.end(JSON.stringify({gitPath:wrapper,path:root,args:[],maxPayloadBytes,graceMs:1000}))
  onTestFinished(async()=>{if(child.exitCode===null&&child.signalCode===null&&child.pid!==undefined){process.kill(-child.pid,'SIGKILL');await closed}})
  return {root,child,closed}
}

it('collects both Git pipes above the original command tail and preserves nonzero outcomes without truncation',async()=>{
  const a=await runGit("import os,sys\nfor _ in range(100):\n os.write(1,b'o'*1000)\n os.write(2,b'e'*1000)\nsys.exit(7)\n",300000)
  const result=await a.closed
  expect(result.code,result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({exitCode:7,stdout:'o'.repeat(100000),stderr:'e'.repeat(100000)})
})

it('fails a combined pipe or encoded JSON overflow and waits for the direct Git child',async()=>{
  const a=await runGit("import os,pathlib,time\npathlib.Path('child.pid').write_text(str(os.getpid()))\nos.write(1,b'x'*1025)\ntime.sleep(30)\n",1024)
  const result=await a.closed,pid=Number(await readFile(join(a.root,'child.pid'),'utf8'))
  expect(result.code).not.toBe(0);expect(result.stderr).toContain('Git output exceeds configured payload capacity')
  expect(()=>process.kill(pid,0)).toThrow()
  const b=await runGit("import os\nos.write(1,b'\\0'*250)\n",1024)
  expect((await b.closed).stderr).toContain('Git result exceeds configured payload capacity')
})

it('inherits the managed Python process group and limits, with no detached Git child after group cancellation',async()=>{
  const a=await runGit("import os,json,pathlib,resource,time\npathlib.Path('ready.json').write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),'parent':os.getppid(),'limits':list(resource.getrlimit(resource.RLIMIT_NOFILE))}))\ntime.sleep(30)\n",4096)
  let ready:{pid:number;pgid:number;parent:number;limits:number[]}|undefined
  await vi.waitFor(async()=>{ready=JSON.parse(await readFile(join(a.root,'ready.json'),'utf8'));expect(ready).toBeDefined()})
  if(ready===undefined||a.child.pid===undefined)throw new Error('Child readiness absent')
  expect(ready.pgid).toBe(a.child.pid);expect(ready.parent).toBe(a.child.pid);expect(ready.limits).toEqual([128,128])
  process.kill(-a.child.pid,'SIGTERM')
  expect((await a.closed).code).not.toBe(0)
  const pid=ready.pid
  await vi.waitFor(()=>expect(()=>process.kill(pid,0)).toThrow())
})
