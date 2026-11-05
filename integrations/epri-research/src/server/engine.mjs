import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {engineContracts} from './engine-contracts.mjs';
import {engineStatus,runDockerExecutor} from './engine-runtime.mjs';
import {runWorkflow,runWorkflowTransition} from '../reused/engine/index.ts';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const now=()=>new Date().toISOString();
export function engineStore(db,directory,runtime={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS engine_packages(session TEXT NOT NULL,id TEXT NOT NULL,version TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,id,version));
    CREATE TABLE IF NOT EXISTS engine_runs(session TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,id),UNIQUE(session,request));`);
  const active=new Map(),pending=new Set();let closed=false;
  const saveRun=run=>db.prepare('UPDATE engine_runs SET body=? WHERE session=? AND id=?').run(JSON.stringify(run),run.sessionId,run.id);
  for(const row of db.prepare('SELECT body FROM engine_runs').all()){const run=JSON.parse(row.body);if(run.status==='running'){run.status='interrupted';run.finishedAt=now();run.error='服务曾停止，未自动重跑。';saveRun(run);}}
  const getPackage=(session,id,version)=>{const row=db.prepare('SELECT body FROM engine_packages WHERE session=? AND id=? AND version=?').get(session,id,version);return row?JSON.parse(row.body):fail('NOT_FOUND','协议包不属于本对话。');};
  const getRun=(session,id)=>{const row=db.prepare('SELECT body FROM engine_runs WHERE session=? AND id=?').get(session,id);return row?JSON.parse(row.body):fail('NOT_FOUND','运行记录不存在。');};
  const brief=p=>{const {files,...rest}=p;return {...rest,fileNames:Object.keys(files)};};
  function checkFiles(files,kind){
    const entries=Object.entries(files);if(!entries.length || entries.length>100 || Buffer.byteLength(JSON.stringify(files))>2*1024*1024)fail('LIMIT','协议包最多 100 个文件、2 MiB 文本。');
    const seen=new Set();for(const [name,content] of entries){if(!/^[\w.\-/]+$/.test(name) || name.split('/').some(p=>!p || p==='.' || p==='..' || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p) || p.endsWith('.')) || seen.has(name.toLowerCase()))fail('INVALID','协议包路径不合法或重名：'+name);seen.add(name.toLowerCase());if(typeof content!=='string' && Buffer.from(content.contentBase64,'base64').toString('base64')!==content.contentBase64)fail('INVALID','二进制文件编码无效。');}
    if(kind==='protocol' && (!files['protocol.aimd'] || !files['protocol.toml']))fail('INVALID','协议包需要 protocol.aimd 和 protocol.toml。');
    if(kind==='workflow' && !files['workflow.aimd'])fail('INVALID','工作流包需要 workflow.aimd。');
  }
  async function runInBackground(run,p,controller,attachments){
    let dir;
    try {
      const parent=join(directory,'engine-tmp');mkdirSync(parent,{recursive:true});dir=mkdtempSync(join(parent,'run-'));
      for(const [name,content] of Object.entries(p.files)){const target=join(dir,name);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,typeof content==='string'?content:Buffer.from(content.contentBase64,'base64'));}
      const options={signal:controller.signal,timeout:120,attachments,
        ...(runtime.executeProtocol ? {executor:(payload,options)=>runtime.executeProtocol(payload,options,run.sessionId)} : {})};
      const params=run.params;
      let result;
      if(run.action.startsWith('workflow')) {
        const opts=z.object({records:z.record(z.unknown()).default({}),workflowId:z.string().optional(),transitionId:z.string().optional(),transitionIds:z.array(z.string()).max(100).optional(),maxPasses:z.number().int().min(1).max(10).default(1)}).strict().parse(params);
        const {records,transitionId,...rest}=opts;
        if(run.action==='workflow_transition' && !transitionId)fail('INVALID','单步执行需要 transitionId。');
        result=run.action==='workflow'?await runWorkflow(dir,records,{...options,...rest}):await runWorkflowTransition(dir,transitionId,records,{...options,...rest});
      }else result=await runDockerExecutor(run.action,dir,params,options);
      controller.signal.throwIfAborted();
      runtime.assertCurrent?.();
      run.result=result;run.status=!result.success || result.data?.success===false?'failed':result.data?.status==='needs_review'?'needs_review':result.data?.errors && Object.keys(result.data.errors).length?'validation_failed':'succeeded';
    }catch(error){run.status=controller.signal.aborted?(controller.signal.reason?.code==='TIMEOUT'?'timed_out':'cancelled'):error.code==='TIMEOUT'?'timed_out':'failed';run.error=String(error.message).slice(0,4000);}
    finally {run.finishedAt=now();try{if(!closed){runtime.assertCurrent?.();saveRun(run);}}finally{active.delete(run.id);clearTimeout(controller.runTimer);if(dir)rmSync(dir,{recursive:true,force:true});}}
  }
  async function execute(op,args,actor,session){
    if(!session)fail('INVALID','请从科研对话进入协议执行页面。');
    const a=z.object(engineContracts[op].shape).strict().parse(args);
    if(op==='engine_status')return (runtime.engineStatus || engineStatus)(session);
    if(op==='engine_packages')return db.prepare('SELECT body FROM engine_packages WHERE session=? ORDER BY rowid DESC').all(session).map(r=>brief(JSON.parse(r.body)));
    if(op==='engine_package_get')return getPackage(session,a.id,a.version);
    if(op==='engine_package_put'){
      if(actor!=='human')fail('FORBIDDEN','可执行协议包必须由用户导入并审阅。');
      checkFiles(a.files,a.kind);const files=Object.fromEntries(Object.entries(a.files).sort(([a],[b])=>a.localeCompare(b)));
      const sha256=hash({kind:a.kind,files});const existing=db.prepare('SELECT body FROM engine_packages WHERE session=? AND id=? AND version=?').get(session,a.id,a.version);
      if(existing){const p=JSON.parse(existing.body);if(p.sha256===sha256 && p.title===a.title)return brief(p);fail('CONFLICT','相同版本已存在；修改后请使用新版本号。');}
      const p={id:a.id,version:a.version,title:a.title,kind:a.kind,files,sha256,createdAt:now(),approved:false,reviews:[]};db.prepare('INSERT INTO engine_packages VALUES(?,?,?,?)').run(session,a.id,a.version,JSON.stringify(p));return brief(p);
    }
    if(op==='engine_package_review'){
      if(actor!=='human')fail('FORBIDDEN','仅用户可以批准运行。');const p=getPackage(session,a.id,a.version);if(p.sha256!==a.sha256)fail('CONFLICT','协议包指纹不符。');p.approved=a.approved;p.reviews.push({approved:a.approved,reason:a.reason,at:now(),actor});db.prepare('UPDATE engine_packages SET body=? WHERE session=? AND id=? AND version=?').run(JSON.stringify(p),session,a.id,a.version);return brief(p);
    }
    if(op==='engine_runs')return db.prepare('SELECT body FROM engine_runs WHERE session=? ORDER BY rowid DESC LIMIT 100').all(session).map(r=>{const {result,...run}=JSON.parse(r.body);return run;});
    if(op==='engine_run_get')return getRun(session,a.id);
    if(op==='engine_cancel'){const run=getRun(session,a.id);active.get(run.id)?.abort();return {id:run.id,status:run.status==='running'?'cancelling':run.status};}
    if(op==='engine_run'){
      const request=actor+':'+a.requestId,requestHash=hash(a);const prior=db.prepare('SELECT body,hash FROM engine_runs WHERE session=? AND request=?').get(session,request);
      if(prior){if(prior.hash!==requestHash)fail('CONFLICT','运行重试标识已用于其他输入。');return JSON.parse(prior.body);}
      const p=getPackage(session,a.packageId,a.version);if(!p.approved)fail('FORBIDDEN','请先审阅并批准此版本的执行。');
      if(a.action.startsWith('workflow')!==(p.kind==='workflow'))fail('INVALID','操作与协议包类型不匹配。');
      if(active.size>=2)fail('BUSY','已有两个任务正在运行，请稍后重试。');
      const attachments={};let size=0;
      for(const [id,reference] of Object.entries(a.attachments)){const row=db.prepare('SELECT a.name,a.body FROM attachments a JOIN attachment_scopes s ON a.reference=s.reference WHERE s.session=? AND a.reference=?').get(session,reference);if(!row)fail('NOT_FOUND','输入附件不属于本对话。');size+=row.body.length;if(size>2*1024*1024)fail('LIMIT','运行附件合计最多 2 MiB。');attachments[id]={name:row.name,contentBase64:Buffer.from(row.body).toString('base64')};}
      const run={id:randomUUID(),sessionId:session,packageId:p.id,version:p.version,packageSha256:p.sha256,actor,action:a.action,params:a.params,attachments:a.attachments,status:'running',startedAt:now()};
      runtime.assertCurrent?.();
      db.prepare('INSERT INTO engine_runs VALUES(?,?,?,?,?)').run(session,run.id,request,requestHash,JSON.stringify(run));const controller=new AbortController();controller.runTimer=setTimeout(()=>controller.abort(Object.assign(new Error('运行超过 120 秒'),{code:'TIMEOUT'})),120000);active.set(run.id,controller);const work=runInBackground(run,p,controller,attachments);pending.add(work);void work.finally(()=>pending.delete(work)).catch(()=>{});return getRun(session,run.id);
    }
  }
  return {execute,close(){closed=true;for(const controller of active.values())controller.abort();return pending.size ? Promise.allSettled([...pending]) : undefined;}};
}
