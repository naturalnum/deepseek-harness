import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { openStore } from './service.mjs';
import { validateDocumentInput } from './document-runtime.mjs';

const failure = (code,message) => Object.assign(new Error(message),{code});
const engineSource = name => readFileSync(new URL('./engine/'+name,import.meta.url),'utf8');

// The account plugin owns this instance. None of these ports or actor choices
// are decoded from browser/model JSON, and no process-wide environment changes.
export function openCloudStore({ directory, lifetime, assertCurrent, authorizeSession, python }) {
  const requests = new AsyncLocalStorage(), pending = new Set(), stopped=new AbortController();
  let store, closing, closed=false;
  const check = () => {
    if(closed)throw failure('CLOSED','科研账号实例正在关闭。');
    lifetime.throwIfAborted();assertCurrent();requests.getStore()?.check();
  };
  const scope = () => {
    check();
    const current = requests.getStore();
    if(!current)throw failure('FORBIDDEN','科研操作必须绑定平台当前会话。');
    return current;
  };
  const run = async(argv,input,signal,timeout=120000,background=false) => {
    const current=scope();
    const result=await current.run(argv,input,AbortSignal.any([lifetime,stopped.signal,...background?[]:[current.signal],...signal?[signal]:[]]),timeout);
    check();
    if(result.exitCode!==0)throw failure('EXECUTION_FAILED',result.stderr.slice(-3000)||'云端计算进程未完成。');
    return result.stdout;
  };
  const jsonPython = async(source,input,signal,timeout,background=false) => {
    const output=await run([python,'-I','-X','utf8','-c',source],JSON.stringify(input),signal,timeout,background);
    try{return JSON.parse(output);}catch{throw failure('INVALID','云端执行器未返回有效 JSON。');}
  };
  const runtime = {
    assertCurrent:check,
    async engineStatus() {
      try {
        const versions=await jsonPython('import json,sys; from importlib.metadata import version; import airalogy; print(json.dumps({"python":sys.version.split()[0],"airalogy":version("airalogy")}))',null,undefined,15000);
        return {ready:true,...versions,runtime:'OpenSandbox',execution:'cloud',limits:{seconds:120,concurrency:2}};
      }catch(error){check();return {ready:false,execution:'cloud',message:'云端科研镜像缺少 Airalogy 运行环境。',detail:error.message};}
    },
    async executeProtocol(payload,options) {
      const source='import tempfile,os,pathlib\nwith tempfile.TemporaryDirectory(prefix="epri-engine-") as directory:\n    os.environ["EPRI_EXECUTION_ROOT"]=str(pathlib.Path(directory)/"run")\n    exec(compile('+JSON.stringify(engineSource('runner.py'))+',"research-runner","exec"))';
      const result=await jsonPython(source,{...payload,executors:Object.fromEntries(['protocol_executor.py','workflow_executor.py'].map(name=>[name,engineSource(name)]))},options.signal,options.timeout*1000,true);
      if(typeof result?.success!=='boolean')throw failure('INVALID','科研执行结果缺少 success。');
      return result;
    },
    async documentStatus() {
      try {
        const result=await jsonPython('import shutil,json; tools=["pdfinfo","pdftotext","pdftoppm","tesseract"]; print(json.dumps({"available":all(shutil.which(tool) for tool in tools)}))',null,undefined,15000);
        return {...result,execution:'cloud',engine:'poppler+tesseract',maxPages:80};
      }catch(error){check();return {available:false,execution:'cloud',message:error.message,maxPages:80};}
    },
    async extractDocument(input,signal) {
      const source='import sys\nsys.argv=["document-extract","--stdin"]\n'+readFileSync(new URL('./document-extract.py',import.meta.url),'utf8');
      const result=await jsonPython(source,validateDocumentInput(input),signal,180000);
      if(!Array.isArray(result?.pages))throw failure('INVALID','文档执行器未返回页面。');
      return result;
    },
    git: {
      path:posix,
      async git(path,args,signal,allowMissing=false) {
        const current=scope();
        const result=await current.run(['git','--no-pager','-c','core.quotepath=false','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','credential.helper=','-C',path,...args],'',AbortSignal.any([current.signal,lifetime,stopped.signal,...signal?[signal]:[]]),15000);
        check();
        if(allowMissing&&result.exitCode===1)return '';
        if(result.exitCode!==0)throw failure('CONFLICT','Git 操作未完成，工作区已保留。'+result.stderr.slice(-1500));
        return result.stdout;
      },
      async realpath(path) {
        const current=scope();
        const result=await jsonPython('import json,pathlib,sys\np=json.load(sys.stdin)\nroot=pathlib.Path(p["root"]).resolve(strict=True)\ntarget=pathlib.Path(p["path"]).resolve(strict=True)\nif not target.is_relative_to(root): raise ValueError("Path is outside the session workspace")\nprint(json.dumps(str(target)))',{root:current.workspaceRoot,path},current.signal,15000);
        return result;
      },
      async mkdir(path) {
        const current=scope();
        await jsonPython('import json,pathlib,sys\np=json.load(sys.stdin)\nroot=pathlib.Path(p["root"]).resolve(strict=True)\ntarget=pathlib.Path(p["path"]).resolve()\nif not target.is_relative_to(root): raise ValueError("Path is outside the session workspace")\ntarget.mkdir(parents=True,exist_ok=True)\nprint("null")',{root:current.workspaceRoot,path},current.signal,15000);
      },
      async readFile(path) {const current=scope();return Buffer.from(await current.readBytes(path,current.signal,16*1024*1024));},
      async stat(path) {const current=scope();return current.stat(path,current.signal);},
      async worktreeDirectory() {const current=scope();return posix.join(current.workspaceRoot,'.epri-worktrees');},
    },
  };
  return {
    execute(op,args,actor,sessionId,signal) {
      const work=(async()=>{
        check();
        if(!['human','agent'].includes(actor)||typeof sessionId!=='string'||!sessionId.trim())throw failure('FORBIDDEN','科研操作缺少当前平台会话。');
        const control=AbortSignal.any([lifetime,stopped.signal,...signal?[signal]:[]]);
        control.throwIfAborted();
        const current=await authorizeSession(sessionId,control);
        check();current.check();control.throwIfAborted();
        return requests.run({...current,signal:control},async()=>{
          check();store ||= openStore(directory,runtime);
          const result=await store.execute(op,args,actor,control,sessionId);
          check();control.throwIfAborted();return result;
        });
      })();
      pending.add(work);void work.finally(()=>pending.delete(work)).catch(()=>{});
      return work;
    },
    close() {
      if(closing)return closing;
      closed=true;stopped.abort(failure('CLOSED','科研账号实例正在关闭。'));
      closing=(async()=>{await store?.close();await Promise.allSettled([...pending]);})();
      return closing;
    },
  };
}
