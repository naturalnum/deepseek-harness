/** Research execution uses the current original native tool's FS, confinement and managed subprocess. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join,dirname,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readNativeFile} from './read-file.mjs';

const sourceRoot=dirname(fileURLToPath(import.meta.url));
const engineRoot=join(sourceRoot,'../../src/reused/engine');
const resourceScript=join(sourceRoot,'../../plugins/cloud/resource-materializer.py');
const documentScript=join(sourceRoot,'../../src/server/document-native.py');
const unavailable=message=>{throw Object.assign(new Error(message),{code:'UNAVAILABLE'});};
const bootstrap=`import sys,os,runpy,shutil,io,contextlib,json,hashlib,base64
p,r,w,o,m,n,b,h,s=sys.argv[1:]
os.environ['EPRI_EXECUTION_ROOT']=w
parts=[p+'.'+str(i) for i in range(int(n))]
try:
 data=bytearray()
 for name in parts:
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd,'rb') as f:
   raw=f.read(int(s)+1)
  if len(raw)>int(s): raise ValueError('Scientific input part exceeds configured capacity')
  part=base64.b64decode(raw,validate=True)
  if len(data)+len(part)>int(b): raise ValueError('Scientific input exceeds its manifest')
  data.extend(part)
 if len(data)!=int(b) or hashlib.sha256(data).hexdigest()!=h: raise ValueError('Scientific input manifest does not match')
 sys.stdin=io.StringIO(data.decode('utf8'))
 del data,part,raw
 sys.argv=[r]
 capture=io.StringIO()
 with contextlib.redirect_stdout(capture):
  try: runpy.run_path(r,run_name='__main__')
  except SystemExit as result:
   if result.code not in (None,0): raise
 data=capture.getvalue().encode('utf8')
 if len(data)>int(m): raise ValueError('Scientific result exceeds configured capacity')
 with open(o,'xb') as f: f.write(data)
 print(json.dumps({'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}))
finally:
 for f in [r]+parts:
  if os.path.lexists(f): os.unlink(f)
 if os.path.isdir(w): shutil.rmtree(w)
`;

/** Keep one actual native tool execution available through asynchronous scientific calculations. */
export function createNativeResearchRuntime(config,assertToolCurrent,projectPath) {
  const executions=new AsyncLocalStorage(),closing=new AbortController();
  let transfers=0;
  async function withTransfer(work){
    if(transfers>=config.maxConcurrentFileTransfers)unavailable('科研文件传输达到配置并发容量，请稍后重试。');
    transfers++;try{return await work();}finally{transfers--;}
  }
  let engineObservation={ready:false,execution:'managed-native',message:'尚未通过当前科研对话检查计算环境。'};
  let documentObservation={available:false,execution:'managed-native',message:'尚未通过当前科研对话检查识别环境。'};
  const current=()=>{
    const exec=executions.getStore();
    if(!exec?.agent)unavailable('请在当前原生对话中执行科研工具。');
    assertToolCurrent(exec);exec.signal.throwIfAborted();return exec;
  };
  function python(script,payload,signal){return withTransfer(()=>pythonActual(script,payload,signal));}
  async function pythonActual(script,payload,signal) {
    const exec=current(),agent=exec.agent,ctx=agent.ctx;
    const control=AbortSignal.any([exec.signal,closing.signal,signal ?? exec.signal,AbortSignal.timeout(config.executionTimeoutMs)]);
    const cwd=await ctx.get('workingDirectory').ensure(agent,control);
    current();
    const id='.research-'+randomUUID(),root=posix.join(cwd,id+'-work');
    const policy=ctx.get('sandboxPolicy').resolve({session:agent.session});
    let input=Buffer.from(JSON.stringify(payload));
    if(input.length>config.maxPayloadBytes||Buffer.byteLength(script)>config.fileChunkBytes)unavailable('科研输入或执行脚本超过配置容量。');
    const inputBytes=input.length,inputSha256=createHash('sha256').update(input).digest('hex');
    const partBytes=Math.floor(config.fileChunkBytes/4)*3,parts=Math.ceil(input.length/partBytes);
    const prefix=await ctx.get('fs').resolve(id+'.json',{cwd,signal:control});
    const inputPath=ctx.get('fs').processPath(prefix);
    for(let index=0;index<parts;index++){
      const part=await ctx.get('fs').resolve(id+'.json.'+index,{cwd,signal:control});current();
      await ctx.get('fs').writeText(part,input.subarray(index*partBytes,(index+1)*partBytes).toString('base64'),{kind:'createIfAbsent'},control,policy);current();
    }
    input=undefined;
    const scriptTarget=await ctx.get('fs').resolve(id+'.py',{cwd,signal:control});current();
    await ctx.get('fs').writeText(scriptTarget,script,{kind:'createIfAbsent'},control,policy);current();
    const scriptPath=ctx.get('fs').processPath(scriptTarget);
    const resultTarget=await ctx.get('fs').resolve(id+'.result.json',{cwd,signal:control});
    const resultPath=ctx.get('fs').processPath(resultTarget);
    const output=await command([config.pythonPath,'-I','-X','utf8','-c',bootstrap,inputPath,scriptPath,root,resultPath,String(config.maxPayloadBytes),String(parts),String(inputBytes),inputSha256,String(config.fileChunkBytes)],cwd,control);
    const manifest=JSON.parse(output);
    if(!Number.isSafeInteger(manifest.bytes)||manifest.bytes<0||manifest.bytes>config.maxPayloadBytes||typeof manifest.sha256!=='string')unavailable('计算结果回执无效。');
    const bytes=await readNativeFile(ctx.get('fs'),resultTarget,{maxBytes:config.maxPayloadBytes,chunkBytes:config.fileChunkBytes,signal:control,check:current,expectedBytes:manifest.bytes,expectedSha256:manifest.sha256});
    await command([config.pythonPath,'-I','-c',"import os,sys; os.unlink(sys.argv[1])",resultPath],cwd,control);
    return JSON.parse(bytes.toString('utf8'));
  }
  async function command(argv,cwd,signal,allowMissing=false) {
    const exec=current(),ctx=exec.agent.ctx,control=AbortSignal.any([exec.signal,closing.signal,signal ?? exec.signal,AbortSignal.timeout(config.executionTimeoutMs)]);
    const policy=ctx.get('sandboxPolicy').resolve({session:exec.agent.session});
    const confined=await ctx.get('sandbox').confine(argv,policy,control);
    current();
    const handle=ctx.get('subprocess').spawn({argv:confined.argv,cwd,stdio:{stdin:'ignore',stdout:{maxBytes:config.maxOutputBytes},stderr:{maxBytes:config.maxOutputBytes}},graceMs:config.graceMs,signal:control,sandboxPolicy:policy});
    let rangeConfirmed=false;
    try {
    const outcome=await handle.done;
    if(!await handle.waitForExit(control))unavailable('计算执行范围尚未确认结束。');
    rangeConfirmed=true;
    current();control.throwIfAborted();
    const stdout=handle.collected.stdout?.readFrom(0),stderr=handle.collected.stderr?.readFrom(0);
    if(stdout?.lossy||stderr?.lossy)unavailable('计算输出超过已配置的保留容量；结果未确认。');
    if(allowMissing && outcome.exitCode===1)return '';
    if(outcome.exitCode!==0)unavailable((stderr?.text || '科研计算未成功退出。').slice(0,3000));
    return stdout?.text || '';
    } catch(error) {
      if(!rangeConfirmed){
        try{rangeConfirmed=await handle.waitForExit(AbortSignal.timeout(config.graceMs));}
        catch(_observationError){ /* The original managed owner retains unconfirmed cleanup. */ }
      }
      if(!rangeConfirmed)throw Object.assign(new Error('科研执行范围尚未确认结束，请查看执行记录后重试。'),{executionUnconfirmed:true,cause:error});
      throw error;
    } finally {handle.releaseCollected?.();}
  }
  async function target(path) {
    const exec=current(),root=projectPath(exec);
    const normalized=posix.resolve(root,path),relative=posix.relative(root,normalized);
    if(relative==='..'||relative.startsWith('../')||path.includes('\\'))unavailable('Git 目录必须属于当前原生会话项目。');
    const value=await exec.agent.ctx.get('fs').resolve(normalized,{cwd:root,signal:exec.signal});current();return value;
  }
  function readProjectFile(path,maxBytes){return withTransfer(async()=>{
    const exec=current(),value=await target(path);
    return readNativeFile(exec.agent.ctx.get('fs'),value,{maxBytes:Math.min(maxBytes,config.maxPayloadBytes),chunkBytes:config.fileChunkBytes,signal:exec.signal,check:current});
  });}
  const git={
    async run(path,args,signal,allowMissing=false){await target(path);return command([config.gitPath,'--no-pager','-c','core.quotepath=false','-c','core.fsmonitor=false','-C',path,...args],projectPath(current()),signal,allowMissing);},
    async realpath(path){const exec=current(),value=await target(path);const info=await exec.agent.ctx.get('fs').stat(value,exec.signal);if(info?.type!=='directory')unavailable('项目目录不存在。');return exec.agent.ctx.get('fs').processPath(value);},
    readFile(path){return readProjectFile(path,config.maxPayloadBytes);},
    async stat(path){const exec=current(),value=await target(path);const info=await exec.agent.ctx.get('fs').stat(value,exec.signal);if(!info)throw Object.assign(new Error('File missing'),{code:'ENOENT'});return info;},
    async mkdir(path){await target(path);await python("import os,json,sys; os.makedirs(json.load(sys.stdin)['path'],exist_ok=True); print('null')",{path});},
    worktreeParent(){return posix.join(projectPath(current()),'.research-worktrees');},
  };
  const runtime={
    git,readProjectFile,
    execution(){return executions.getStore();},
    resources(payload){return python(readFileSync(resourceScript,'utf8'),payload);},
    close(){closing.abort(new Error('科研账号作用域已关闭。'));},
    async fetch(input,init){
      const exec=current();
      if(init?.method && init.method!=='GET')unavailable('文献检索仅支持原生只读网络访问。');
      const result=await exec.agent.ctx.get('web').fetch({url:String(input)},init?.signal ?? exec.signal);
      current();if(result.truncated)unavailable('文献来源响应超过原生网络读取容量。');
      return new Response(result.body.content,{status:result.statusCode,headers:{'Content-Type':result.body.kind==='html'?'text/html':'application/json'}});
    },
    withExecution(exec,work){assertToolCurrent(exec);return executions.run(exec,work);},
    engine:{
      async status(){
        if(!executions.getStore())return engineObservation;
        try{const observed=await python("import json,sys; from importlib.metadata import version; import airalogy; print(json.dumps({'python':sys.version.split()[0],'airalogy':version('airalogy')}))",{});
          if(!observed.python.startsWith(config.expectedPythonVersion+'.')||observed.airalogy!==config.expectedAiralogyVersion)unavailable('计算环境版本与批准配置不符。');
          engineObservation={ready:true,execution:'managed-native',...observed,observedAt:new Date().toISOString()};}
        catch(error){engineObservation={ready:false,execution:'managed-native',message:error.message,observedAt:new Date().toISOString()};}
        return engineObservation;
      },
      async run(action,root,params,options={}){
        current();const files={};
        function collect(directory,prefix=''){for(const entry of readdirSync(directory,{withFileTypes:true})){
          const name=prefix+entry.name;if(entry.isDirectory())collect(join(directory,entry.name),name+'/');
          else if(entry.isFile())files[name]=readFileSync(join(directory,entry.name)).toString('base64');
          else unavailable('协议包不允许符号链接。');
        }}
        collect(root);
        const payload={action,params,files,attachments:options.attachments||{},executors:Object.fromEntries(['protocol_executor.py','workflow_executor.py'].map(name=>[name,readFileSync(join(engineRoot,name),'utf8')]))};
        if(Buffer.byteLength(JSON.stringify(payload))>config.maxPayloadBytes)unavailable('科研计算输入超过已配置容量。');
        const versionGate="import sys\nfrom importlib.metadata import version\nif '.'.join(map(str,sys.version_info[:2]))!="+JSON.stringify(config.expectedPythonVersion)+" or version('airalogy')!="+JSON.stringify(config.expectedAiralogyVersion)+": raise RuntimeError('Research engine version does not match approved configuration')\n";
        const result=await python(versionGate+readFileSync(join(engineRoot,'runner.py'),'utf8'),payload,options.signal);
        if(typeof result?.success!=='boolean')unavailable('执行引擎未返回有效 JSON 结果。');return result;
      },
    },
    documents:{
      async status(){
        if(!executions.getStore())return documentObservation;
        try{await python("import sys; sys.argv.append('--status')\n"+readFileSync(documentScript,'utf8'),{});
          documentObservation={available:true,execution:'managed-native',maxPages:80,observedAt:new Date().toISOString()};}
        catch(error){documentObservation={available:false,execution:'managed-native',message:error.message,observedAt:new Date().toISOString()};}
        return documentObservation;
      },
      async extract(payload,signal){const data=await python(readFileSync(documentScript,'utf8'),payload,signal);
        if(!Array.isArray(data?.pages))unavailable('提取器未返回页面文字。');return data;},
    },
  };
  return runtime;
}
