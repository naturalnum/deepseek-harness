import {createHash} from 'node:crypto';
import {call,connection} from '../../src/server/client.mjs';
import {parseAimdProtocol} from '../../dist/server/service.mjs';
import {cloudResearch} from '../cloud/client-for.mjs';

export const conversationReviewOps = new Set(['task_open','evidence_review','roadmap_select','lab_skill_publish','engine_package_review','record_submit','record_reopen','record_archive','record_restore']);

// Render saved content as literal text; source text cannot introduce approval controls or links.
const literal = value => String(value).replace(/[\\`*_{}\[\]()#+.!<>|~-]/g,'\\$&').replace(/\r?\n/g,'  \n');
const line = (label,value) => `**${label}**：${literal(value)}`;
const snapshot = value => '```json\n'+JSON.stringify(value,null,2).replaceAll('`','\\u0060')+'\n```';
function reviewDetail(op, args, before, checks, name) {
  const data = before?.data || before || {};
  const lines = [
    line('本次操作',name),
    line('对象',data.title || before?.title || args.id),
  ];
  const version = before.revision ?? args.version;
  if (version !== undefined) lines.push(line('版本',version));
  if (op === 'task_open') {
    lines.push(line('研究任务',before.task.objective),line('数据性质',before.task.basis),line('方法',before.method.title+' / '+before.method.version),line('方法源码 SHA-256',before.method.sha256),line('适用范围',before.method.metadata.limitations),'本次确认会批准这份精确源码并准备实验记录；不会代替结果复核。','待启用源码：\n'+snapshot(before.method.files));
  } else if (op === 'evidence_review') {
    const source=data.source || {};
    lines.push(line('证据性质',({measured:'实际测量',synthetic:'合成测试数据',literature:'文献报告',estimated:'估计值'})[data.basis] || data.basis),line('观察结果',data.observation));
    lines.push(line('来源',source.name || source.title || source.url || source.id || source.reference));
    if(source.excerpt)lines.push(line('原文摘录',source.excerpt));
    if(source.spec)lines.push('图表数据：\n'+snapshot(source.spec));
    if(source.snapshot)lines.push('来源记录：\n'+snapshot(source.snapshot.run));
    lines.push(line('拟记录结论',args.result==='accepted'?'复核通过':'复核不通过'));
  } else if (op === 'roadmap_select') {
    const route = data.route || {};
    lines.push(line('研究目标',route.objective));
    const node = route.nodes?.find(item => item.id === args.nodeId);
    lines.push(line('选择路线',node?.title || args.nodeId));
    if(node?.summary)lines.push(line('路线说明',node.summary));
    if(node?.execution)lines.push('执行约定：\n'+snapshot(node.execution));
    lines.push('确认只保存此路线选择，不会自行启动模型任务或 Git 操作。');
  } else if (op === 'lab_skill_publish') {
    lines.push(line('拟执行结果',args.published?'发布到本机技能库':'撤回已发布技能'),line('方法内容',data.markdown),line('关联证据',(data.evidence || []).map(item=>item.id+' / 修订 '+item.revision).join('、') || '无'));
  } else if (op === 'engine_package_review') {
    lines.push(line('拟执行结果',args.approved?'批准此版本执行':'撤销此版本执行'),line('包指纹',args.sha256),line('文件',Object.keys(before.files || {}).join('、')),'请在右侧工作台核对该执行包的完整源代码；确认仅对上述包指纹有效。');
  } else if (op.startsWith('record_')) {
    lines.push(line('协议',before.protocolId+' / '+before.protocolVersion),'当前记录内容：\n'+snapshot(before.run));
    if(checks.length)lines.push('**请逐项核对**\n',...checks.map(item=>'- '+literal(item.message)+'（'+literal(item.id)+'）'));
  }
  if(args.reason)lines.push(line('拟保存的意见',args.reason));
  if(op==='record_submit' && checks.length)lines.push('确认表示你已核对全部上述检查项，随后尝试提交；必填字段和结构检查仍会执行。');
  lines.push('附件、协议和完整详情可在右侧工作台查看。暂不执行、关闭或跳过均不会批准本次操作。');
  return lines.join('\n\n');
}

// Only this trusted Host continuation can use the human credential, after its own exact question settles.
export async function reviewInConversation(ctx,op,args,exec,sessionId) {
  if (!exec.agent) throw new Error('科研审批需要当前原生会话。');
  const cloud=cloudResearch(exec.agent.ctx);
  const questions=exec.agent.ctx.get('userQuestions',false) || ctx.get('userQuestions',false);
  if (!questions) throw new Error('当前对话的人工问答服务未启用，审批尚未执行。');
  const read=(name,input)=>cloud?cloud.agentCall(name,input,exec):call(name,input,exec.signal,sessionId);
  const selectedConnection=cloud?cloud.binding:connection();
  let before,protocol;
  if(op==='task_open') {
    const task=await read('task_get',{id:args.id});
    if(!task.methodId)throw new Error('请先选择方法，再请求准备实验。');
    before={task,method:await read('method_get',{id:task.methodId,version:task.methodVersion})};
  } else if(op.startsWith('record_')) {
    before=await read('record_get',{id:args.id});
    if(before.revision!==args.expectedRevision)throw new Error('记录已更新，请读取最新版本后再请求审批。');
    if(op==='record_submit')protocol=await read('protocol_get',{id:before.protocolId,version:before.protocolVersion});
  } else if(op==='engine_package_review') {
    before=await read('engine_package_get',{id:args.id,version:args.version});
    if(before.sha256!==args.sha256)throw new Error('执行包指纹已变化，请重新审阅。');
  } else {
    const state=await read('science_state',{});
    const group={evidence_review:'evidence',roadmap_select:'roadmap',lab_skill_publish:'labskill'}[op];
    before=state[group]?.find(x=>x.id===args.id);
    if(!before||before.revision!==args.expectedRevision)throw new Error('科研条目已更新或不存在，请重新读取再请求审批。');
  }
  const fingerprint=createHash('sha256').update(JSON.stringify({op,args,before})).digest('hex');
  const name={task_open:'启用研究方法并准备实验',evidence_review:'复核研究证据',roadmap_select:'选择研究路线',lab_skill_publish:'发布或撤回研究方法',engine_package_review:'批准或撤销协议执行',record_submit:'确认检查项并提交记录',record_reopen:'重新打开记录',record_archive:'归档记录',record_restore:'恢复记录'}[op];
  const approval=name.startsWith('确认')?name:'确认'+name;
  const checks=protocol?parseAimdProtocol(protocol.content).checks.map(x=>({id:x.id,message:x.checked_message || x.id})):[];
  const detail=reviewDetail(op,args,before,checks,name);
  if(detail.length>60000)throw new Error('待审内容较大，请先在右侧栏审阅并缩小本次操作；未执行审批。');
  exec.signal?.throwIfAborted();
  const result=await questions.ask({agent:exec.agent,signal:exec.signal,wait:{callId:exec.callId},questions:[{id:'research-review-'+fingerprint,header:'科研审批',question:'是否'+name+'？',detail,options:[{label:'暂不执行',description:'保留现有内容，继续讨论或修改。'},{label:approval,description:'已核对当前版本，仅执行此项操作。'}]}]});
  exec.signal?.throwIfAborted();
  const answer=result.answers?.find(x=>x.id==='research-review-'+fingerprint);
  if(answer?.selected?.length!==1||answer.selected[0]!==approval||answer.custom)return {executed:false,status:'declined',message:'用户未明确确认，本次审批未执行。'};
  // Ask() verifies the exact live root and an authenticated UI answer; do not accept a model-supplied answer field.
  const c=cloud?cloud.binding:connection();
  if(cloud?c!==selectedConnection:JSON.stringify(c)!==JSON.stringify(selectedConnection))throw new Error('科研服务连接已变化，请重新请求审批。');
  const human=async(name,input)=>{
    exec.signal?.throwIfAborted();
    if(cloud)return cloud.reviewedCall(name,input,exec);
    const response=await fetch(c.url+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+c.humanToken},body:JSON.stringify({op:name,args:input,sessionId}),signal:exec.signal?AbortSignal.any([exec.signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
    const data=await response.json();if(!response.ok)throw new Error((data.code||response.status)+': '+data.error);return data.result;
  };
  // Re-read after the answer. A stale question never approves later edits, even on an otherwise idempotent endpoint.
  const latest=op==='task_open'?{task:await read('task_get',{id:args.id}),method:await read('method_get',{id:before.method.id,version:before.method.version})}:op.startsWith('record_')?await read('record_get',{id:args.id}):op==='engine_package_review'?await read('engine_package_get',{id:args.id,version:args.version}):(await read('science_state',{}))[{evidence_review:'evidence',roadmap_select:'roadmap',lab_skill_publish:'labskill'}[op]]?.find(x=>x.id===args.id);
  if(JSON.stringify(latest)!==JSON.stringify(before))throw new Error('审批期间内容已变化，本次回答没有应用，请重新核对最新版本。');
  let input=op==='task_open'?{...args,expectedTaskRevision:before.task.revision,expectedMethodId:before.method.id,expectedMethodVersion:before.method.version,expectedMethodSha256:before.method.sha256}:args;
  if(op==='record_submit' && checks.some(x=>before.run.checks[x.id]!==true)) {
    const updated=await human('record_update',{id:before.id,expectedRevision:before.revision,requestId:args.requestId+':human-checks',run:{...before.run,checks:Object.fromEntries(checks.map(x=>[x.id,true]))}});
    input={...args,expectedRevision:updated.revision};
  }
  return human(op,input);
}
