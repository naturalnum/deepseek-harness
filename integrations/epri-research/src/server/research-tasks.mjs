import {createHash} from 'node:crypto';
import {z} from 'zod';
import {powerMethods} from '../power-methods.mjs';
import {taskContracts} from './task-contracts.mjs';
import {parseAimdProtocol,buildAimdFieldOwnership} from '../reused/protocol/aimdProtocolModel.ts';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const metadata=z.object({description:z.string().max(2000).default(''),keywords:z.array(z.string().min(1).max(100)).max(40).default([]),limitations:z.string().max(4000).default('请核对方法适用范围、数据单位和质控规则。'),qcField:z.string().max(120).optional()}).strict();
const basisLabels={measured:'实际测量',synthetic:'合成测试数据',literature:'文献数据',estimated:'估计数据'};
const cell=x=>String(x??'').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
const markdownTable=(headers,rows)=>'| '+headers.map(cell).join(' | ')+' |\n| '+headers.map(()=>'---').join(' | ')+' |\n'+rows.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n');

// UTF-8 CSV, including quoted commas/newlines and escaped quotes. No spreadsheet formulas execute.
export function parseTaskCsv(text){
  const rows=[];let row=[],field='',quoted=false,closed=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<=text.length;i++){
    const c=text[i];
    if(quoted){if(c===undefined)fail('INVALID','CSV 引号没有闭合。');if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c==='"'){if(field||closed)fail('INVALID','CSV 引号位置不正确。');quoted=true;continue;}
    if(c===','||c==='\n'||c==='\r'||c===undefined){row.push(field);field='';closed=false;if(c!==','){if(row.some(x=>x.trim()))rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}if(rows.length>501)fail('LIMIT','一次最多导入 500 行。');continue;}
    if(closed)fail('INVALID','CSV 引号后存在多余内容。');field+=c;
  }
  if(rows.length<2)fail('INVALID','CSV 需要一行表头和至少一行数据。');
  const headers=rows.shift().map(x=>x.trim());
  if(new Set(headers).size!==headers.length||headers.some(x=>!x))fail('INVALID','CSV 表头不能为空或重复。');
  if(rows.some(row=>row.length!==headers.length))fail('INVALID','CSV 列数与表头不一致。');
  return {headers,rows};
}

export function researchTaskStore({db,read,mutate,execute,science,engine}){
  const belongs=(x,session)=>x.sessionId===session;
  const find=(id,session)=>read().tasks?.find(x=>x.id===id&&belongs(x,session))||fail('NOT_FOUND','研究任务不属于当前对话。');
  async function method(id,version,session){
    const builtin=powerMethods.find(x=>x.id===id&&x.version===version);
    let installed;try{installed=await engine.execute('engine_package_get',{id,version},'agent',session);}catch(error){if(error.code!=='NOT_FOUND')throw error;}
    const p=builtin||installed||fail('NOT_FOUND','没有找到该方法版本，请导入方法包。');
    if(p.kind!=='protocol')fail('INVALID','此任务需要可填写的协议方法；多节点工作流请从高级执行入口运行。');
    const files=Object.fromEntries(Object.entries(p.files).sort(([a],[b])=>a.localeCompare(b)));
    const sha256=hash({kind:p.kind,files});
    if(builtin&&installed&&installed.sha256!==sha256)fail('CONFLICT','同名方法版本的源码不同，请更换方法标识或版本。');
    return {...p,files,sha256,builtin:Boolean(builtin),installed:Boolean(installed),approved:installed?.approved===true,metadata:metadata.parse(files['method.json']?JSON.parse(files['method.json']):p.metadata||{})};
  }
  const brief=p=>{const {files,...rest}=p;return {...rest,fileNames:Object.keys(files)};};
  const catalog=async(query,session)=>{
    const refs=[...powerMethods,...(await engine.execute('engine_packages',{},'agent',session)).filter(x=>x.kind==='protocol')];
    const unique=new Map(refs.map(x=>[x.id+'@'+x.version,x]));
    const results=await Promise.allSettled([...unique.values()].map(async x=>brief(await method(x.id,x.version,session))));
    const warnings=results.flatMap((r,i)=>r.status==='rejected'?[{id:[...unique.values()][i].id,version:[...unique.values()][i].version,message:r.reason.message}]:[]);
    const methods=results.filter(r=>r.status==='fulfilled').map(r=>r.value).map(p=>({...p,matchScore:!query?0:[p.title,...p.metadata.keywords].reduce((n,k)=>n+(query.toLowerCase().includes(k.toLowerCase())?k.length:0),0)})).filter(p=>!query||p.matchScore>0).sort((a,b)=>b.matchScore-a.matchScore);
    return {methods,warnings};
  };
  async function view(task,session){
    const workspace=read(),record=workspace.records.find(x=>belongs(x,session)&&x.id===task.recordId),state=science.execute('science_state',{},'agent',session);
    const evidence=state.evidence.find(x=>x.id===task.evidenceId),report=state.report.find(x=>x.id===task.reportId);
    let selectedMethod,methodError,model;if(task.methodId)try{const source=await method(task.methodId,task.methodVersion,session);selectedMethod=brief(source);model=parseAimdProtocol(source.files['protocol.aimd']);}catch(error){methodError=error.message;}
    const evidenceCurrent=Boolean(record&&evidence?.data.source.id===record.id&&evidence.data.source.revision===record.revision&&evidence.data.source.sha256===hash(record));
    const reportCurrent=Boolean(evidenceCurrent&&evidence?.data.review.status==='accepted'&&report?.data.evidence.some(x=>x.id===evidence.id&&x.sha256===evidence.sha256));
    const qc=selectedMethod?.metadata.qcField,quality=qc&&record?.run.values[qc];
    let stage='method',next='选择适用的方法，或补充需要开发的方法及外部工具。';
    if(selectedMethod){stage='open';next='在当前对话确认方法源码并准备实验表。';}
    if(record){stage='input';next='填写表格或导入 CSV，检查单位和数据来源。';
      if(record.calculation?.errors.length){stage='calculation';next=record.calculation.errors[0].message;}
      else if(record.calculation?.pending.length){stage='input';next='补齐输入后系统会重新计算。';}
      else if(record.calculation){stage='review';next=quality===false?'质控未通过。核对数据和限值，或在对话中确认并保留本次失败结果。':'核对计算结果，在当前对话请求人工确认并提交记录。';}
      if(record.status==='submitted'){stage='evidence';next='将已提交记录保存为待复核研究证据。';
        if(evidenceCurrent){stage='evidence_review';next=evidence.data.review.status==='rejected'?'证据未通过人工复核，请根据意见修订实验。':'在当前对话复核这份固定版本的研究证据。';
          if(evidence.data.review.status==='accepted'){stage='report';next='证据已复核，可汇入包含来源和局限的报告。';if(reportCurrent){stage='complete';next='报告已保存；可查看报告或基于新数据开展另一次实验。';}}
        }
      }
      if(record.archived){stage='archived';next='记录已归档，请先恢复记录。';}
      else if(!record.calculationBinding){stage='open';next='记录保留为草稿；请在对话中重新确认方法并连接计算，归档不会自动恢复执行批准。';}
    }
    if(methodError){stage='method';next='方法尚不可用：'+methodError+' 请导入对应方法源码；已保存的历史结果保留。';}
    const steps=['任务','方法','数据','计算与绘图','人工确认','研究证据','报告'];
    const active={method:1,open:1,input:2,calculation:3,review:4,evidence:5,evidence_review:5,report:6,complete:7,archived:2}[stage];
    const metrics=(model?.variables||[]).filter(f=>['number','boolean'].includes(typeof record?.run.values[f.id])).map(f=>({id:f.id,title:f.definition?.kwargs?.title||f.id,value:record.run.values[f.id]}));
    const charts=record?workspace.artifacts.filter(x=>belongs(x,session)&&x.kind==='chart'&&x.sourceRecordId===record.id):[];
    return {...task,selectedMethod,record,metrics,charts,evidence:evidenceCurrent?evidence:null,previousEvidence:evidenceCurrent?null:evidence,report,reportCurrent,stage,next,quality:quality===true?'passed':quality===false?'failed':'not-defined',steps:steps.map((title,i)=>({title,status:i<active?'done':i===active?'current':'pending'})),target:{tab:'engine',task:task.id},recordTarget:record?{tab:'engine',task:task.id,record:record.id}:null};
  }
  async function run(op,args,actor,signal,session){
    if(!session)fail('INVALID','请从科研对话进入研究任务。');
    const a=z.object(taskContracts[op].shape).strict().parse(args),call=(name,input)=>execute(name,input,actor,signal,session);
    if(op==='method_catalog'){const {methods,warnings}=await catalog(a.query,session);return {methods,warnings,query:a.query,unmatched:Boolean(a.query&&!methods.length),message:'候选方法需要核对适用范围；未匹配时可记录任务并导入新方法。'};}
    if(op==='method_get')return method(a.id,a.version,session);
    if(op==='tasks')return Promise.all((read().tasks||[]).filter(x=>belongs(x,session)).map(x=>view(x,session)));
    if(op==='task_create'){
      if(Boolean(a.methodId)!==Boolean(a.methodVersion))fail('INVALID','方法标识和版本必须同时提供。');
      if(a.methodId)await method(a.methodId,a.methodVersion,session);
      if(Boolean(a.roadmapId)!==Boolean(a.nodeId))fail('INVALID','路线和阶段必须同时指定。');
      if(a.roadmapId&&!science.execute('science_state',{},actor,session).roadmap.find(x=>x.id===a.roadmapId)?.data.route.nodes.some(x=>x.id===a.nodeId))fail('NOT_FOUND','研究路线阶段不属于当前对话。');
      const task=mutate(op,a,actor,s=>{const id='task-'+hash([session,actor,a.requestId]).slice(0,24),item={...a,id,revision:1,sessionId:session,createdAt:new Date().toISOString(),evidenceId:'evidence-'+id,reportId:'report-'+id};delete item.requestId;(s.tasks??=[]).unshift(item);return item;},session);
      return view(task,session);
    }
    const task=find(a.id,session);
    if(op==='task_get')return view(task,session);
    if(op==='task_select_method'){
      await method(a.methodId,a.methodVersion,session);
      const chosen=mutate(op,a,actor,s=>{const t=s.tasks.find(x=>belongs(x,session)&&x.id===task.id);if(t.recordId||t.revision!==a.expectedRevision)fail('CONFLICT','任务已开始或已被更新，请重新载入；更换已运行方法需建立新任务。');t.methodId=a.methodId;t.methodVersion=a.methodVersion;t.revision++;return t;},session);
      return view(chosen,session);
    }
    if(['task_open','task_import_csv'].includes(op)&&actor!=='human')fail('FORBIDDEN','准备实验和导入人工数据需要用户操作或对话确认。');
    if(['task_open','task_import_csv'].includes(op)){
      const cached=db.prepare('SELECT hash FROM requests WHERE id=?').get(JSON.stringify([session,actor])+':'+a.requestId);
      if(cached){if(cached.hash!==hash({op,a,actor}))fail('CONFLICT','重试标识已用于其他请求。');return view(task,session);}
    }
    if(op==='task_open'){
      if(!task.methodId)fail('INCOMPLETE','尚未选择方法，请使用明确的方法建立新任务，原任务保留。');
      const pin=[a.expectedTaskRevision,a.expectedMethodId,a.expectedMethodVersion,a.expectedMethodSha256];
      if(pin.some(value=>value!==undefined)) {
        if(pin.some(value=>value===undefined)||task.revision!==a.expectedTaskRevision||task.methodId!==a.expectedMethodId||task.methodVersion!==a.expectedMethodVersion)fail('CONFLICT','已批准的任务版本或方法已变化，请重新核对。');
      }
      const ready=await engine.execute('engine_status',{},actor,session);if(!ready.ready)fail('ENGINE_UNAVAILABLE',ready.message);
      const source=await method(task.methodId,task.methodVersion,session);
      if(a.expectedMethodSha256!==undefined&&source.sha256!==a.expectedMethodSha256)fail('CONFLICT','已批准的方法源码已变化，请重新核对。');
      const latest=find(task.id,session);
      if(latest.revision!==task.revision||latest.methodId!==task.methodId||latest.methodVersion!==task.methodVersion)fail('CONFLICT','任务方法在准备期间已变化，未执行方法准备。');
      // Each reviewed task revision and exact source owns its preparation retries.
      const preparationKey=kind=>'prepare-'+hash([task.id,task.revision,source.sha256,kind]);
      if(source.builtin&&!source.installed)await engine.execute('engine_package_put',{id:source.id,version:source.version,title:source.title,kind:'protocol',files:source.files,requestId:preparationKey('package')},actor,session);
      if(!source.approved)await engine.execute('engine_package_review',{id:source.id,version:source.version,sha256:source.sha256,approved:true,reason:a.reason},actor,session);
      let protocol;try{protocol=await call('protocol_get',{id:source.id,version:source.version});}catch(error){if(error.code!=='NOT_FOUND')throw error;}
      if(!protocol)protocol=await call('protocol_put',{id:source.id,version:source.version,content:source.files['protocol.aimd'],requestId:preparationKey('protocol')});
      if(protocol.content!==source.files['protocol.aimd'])fail('CONFLICT','已有协议源码不同，请更换方法版本。');
      let record=task.recordId?await call('record_get',{id:task.recordId}):await call('record_create',{protocolId:source.id,protocolVersion:source.version,requestId:preparationKey('record')});
      record=await call('record_get',{id:record.id});
      if(!record.calculationBinding)record=await call('record_bind_engine',{id:record.id,expectedRevision:record.revision,packageId:source.id,version:source.version,requestId:preparationKey('binding')});
      mutate(op,a,actor,s=>{const t=s.tasks.find(x=>belongs(x,session)&&x.id===task.id);if(!t||t.revision!==task.revision||t.methodId!==task.methodId||t.methodVersion!==task.methodVersion)fail('CONFLICT','任务方法在准备期间已变化，未绑定实验记录。');t.recordId=record.id;return t;},session);
      return view(find(task.id,session),session);
    }
    const current=await view(task,session),record=current.record;
    if(!record||record.archived)fail('INCOMPLETE','请先准备并打开本任务的实验记录。');
    if(op==='task_import_csv'){
      if(record.revision!==a.expectedRecordRevision)fail('CONFLICT','记录已更新，请重新载入后导入。');
      const p=await call('protocol_get',{id:record.protocolId,version:record.protocolVersion}),model=parseAimdProtocol(p.content),owners=buildAimdFieldOwnership(model);
      const table=model.fields.var_table.find(t=>t.id===a.table);if(!table||owners[table.id]!=='human')fail('INVALID','请选择可由用户填写的表格。');
      const file=await call('attachment_get',{reference:a.reference}),parsed=parseTaskCsv(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(file.contentBase64,'base64')));
      const columns=table.subvars.filter(c=>(owners[table.id+'.'+c.id]||owners[table.id])==='human');
      const mapping=parsed.headers.map(h=>columns.find(c=>c.id===h||c.definition?.kwargs?.title===h||c.kwargs?.title===h));
      if(mapping.some(x=>!x)||new Set(mapping.map(x=>x.id)).size!==mapping.length||columns.some(c=>!mapping.includes(c)))fail('INVALID','CSV 表头必须恰好对应输入列：'+columns.map(c=>c.id).join(', ')+'；请勿导入自动计算列。');
      const rows=parsed.rows.map((row,index)=>Object.fromEntries(row.map((raw,i)=>{const col=mapping[i],type=String(col.definition?.type||col.type||'str').toLowerCase(),value=raw.trim();if(!value)fail('INVALID','第 '+(index+2)+' 行 '+col.id+' 为空。');if(['int','float','number'].includes(type)){if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)||!Number.isFinite(Number(value)))fail('INVALID','第 '+(index+2)+' 行 '+col.id+' 不是有效数值。');return [col.id,Number(value)];}if(type==='bool'){if(!['true','false'].includes(value.toLowerCase()))fail('INVALID','布尔值请填写 true 或 false。');return [col.id,value.toLowerCase()==='true'];}return [col.id,raw];})));
      const updated=await call('record_update',{id:record.id,expectedRevision:record.revision,requestId:a.requestId+':data',run:{...record.run,status:'running',tables:{...record.run.tables,[table.id]:rows}}});
      mutate(op,a,actor,s=>{const t=s.tasks.find(x=>belongs(x,session)&&x.id===task.id);t.sourceFiles=[...(t.sourceFiles||[]).filter(x=>x.reference!==a.reference),{reference:a.reference,name:file.name,recordRevision:updated.revision}];return t;},session);
      return view(find(task.id,session),session);
    }
    if(record.status!=='submitted')fail('INCOMPLETE','请先在对话中完成人工确认并提交当前记录。');
    if(op==='task_evidence'){
      if(current.evidence)return current;
      const previous=current.previousEvidence;
      await call('evidence_put',{id:task.evidenceId,expectedRevision:previous?.revision||0,requestId:a.requestId+':evidence',title:task.objective.slice(0,180)+' · 实验记录',observation:'任务：'+task.objective+'\n数据性质：'+basisLabels[task.basis]+'\n计算结果：'+JSON.stringify(record.run.values)+'\n自动质控：'+current.quality+'；人工提交不代表所有工程适用性已获验证。',basis:task.basis,source:{kind:'record',id:record.id,revision:record.revision}});
      return view(task,session);
    }
    if(!current.evidence||current.evidence.data.review.status!=='accepted')fail('INCOMPLETE','当前记录版本尚无人工复核通过的证据。');
    if(current.reportCurrent)return current;
    const source=await method(task.methodId,task.methodVersion,session),model=parseAimdProtocol(source.files['protocol.aimd']);
    const metrics=model.variables.filter(f=>record.run.values[f.id]!==undefined).map(f=>[f.definition?.kwargs?.title||f.id,record.run.values[f.id]]);
    const charts=read().artifacts.filter(x=>belongs(x,session)&&x.sourceRecordId===record.id);
    const markdown=['# '+task.objective,'## 任务与方法','- 数据性质：'+basisLabels[task.basis],'- 方法：'+source.title+' / '+source.version,'- 试验要求：'+(task.requirements||'未额外提供；方法默认值需结合试验要求人工核对。'),'## 本次结果',markdownTable(['指标或参数','保存值'],metrics),'自动质控：'+({passed:'满足本次设定的自动判据',failed:'未满足本次设定的自动判据；本报告保留失败结果','not-defined':'本方法未定义自动通过判据，需人工判断'})[current.quality],...model.fields.var_table.map(t=>'## 输入与逐行结果：'+(t.title||t.id)+'\n\n'+markdownTable(t.subvars.map(c=>c.kwargs?.title||c.definition?.kwargs?.title||c.id),(record.run.tables[t.id]||[]).slice(0,50).map(row=>t.subvars.map(c=>row[c.id])))+'\n\n共 '+(record.run.tables[t.id]?.length||0)+' 行；完整数据保存在引用的记录快照中。'),...charts.map(c=>'## 图表数据：'+c.title+'\n\n'+markdownTable(['项目','值'],c.spec.data.map(d=>[d.label,d.value]))),'## 来源与复核','- 记录：'+record.id+' / 修订 '+record.revision,'- 计算运行：'+record.calculation.runId,'- 方法源码 SHA-256：'+record.calculation.packageSha256,'- 输入 SHA-256：'+record.calculation.inputSha256,'- 证据：'+current.evidence.id+' / 修订 '+current.evidence.revision,'- 人工复核意见：'+current.evidence.data.review.reason,...(task.sourceFiles||[]).map(f=>'- 原始文件：'+f.name+' / '+f.reference+' / 导入记录修订 '+f.recordRevision),'## 适用范围与局限',source.metadata.limitations,'本报告按已保存记录编排，没有生成额外实验数据或推断未计算的工程结论。'].join('\n\n');
    await call('report_put',{id:task.reportId,expectedRevision:current.report?.revision||0,requestId:a.requestId+':report',title:task.objective.slice(0,180)+' · 研究报告',markdown,evidenceIds:[current.evidence.id],claimIds:[]});
    return view(task,session);
  }
  return {execute:run,list:session=>(read().tasks||[]).filter(x=>belongs(x,session))};
}
