import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {buildAimdFieldOwnership,parseAimdProtocol} from '../reused/protocol/aimdProtocolModel.ts';
import {z} from 'zod';
export {stripCalculated} from '../reused/protocol/calculation-state.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const calculationHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function executeCalculation(engine,binding,action,params,actor,session,requestId,signal){
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
  const source=await engine.execute('engine_package_get',{id:binding.packageId,version:binding.version},actor,session);
  if(!source.approved || binding.sha256 && binding.sha256!==source.sha256)fail('FORBIDDEN','计算包已撤销批准或版本不一致，请重新审阅。');
  let result=await engine.execute('engine_run',{packageId:source.id,version:source.version,action,params,requestId:calculationHash({requestId,action,params}),attachments:{}},actor,session);
  try{
    while(result.status==='running'){
      await delay(80,undefined,{signal});
      result=await engine.execute('engine_run_get',{id:result.id},actor,session);
    }
    signal?.throwIfAborted();
  }catch(error){await engine.execute('engine_cancel',{id:result.id},actor,session);if(signal.reason?.name==='TimeoutError')fail('TIMEOUT','自动计算超过 45 秒，已停止；输入尚未保存，请缩小数据量后重试。');throw error;}
  if(result.status!=='succeeded' && !(action==='recalculate' && result.status==='validation_failed'))fail('CALCULATION',result.error || result.result?.message || '计算执行未成功，请检查执行环境和协议。');
  if(!(await engine.execute('engine_package_get',{id:source.id,version:source.version},actor,session)).approved)fail('FORBIDDEN','执行期间计算包已撤销批准，结果未写入记录。');
  return result;
}
export async function bindCalculation(engine,record,protocol,args,actor,session,signal){
  const source=await engine.execute('engine_package_get',{id:args.packageId,version:args.version},actor,session);
  if(source.kind!=='protocol' || source.files['protocol.aimd']!==protocol.content)fail('INVALID','计算包的 protocol.aimd 必须与这条记录的协议版本完全一致。');
  const binding={packageId:source.id,version:source.version,sha256:source.sha256};
  const parsed=await executeCalculation(engine,binding,'parse_protocol',{},actor,session,args.requestId,signal);
  const targets=Object.entries(parsed.result.data.assigners || {}).filter(([,rule])=>rule.mode==='auto').map(([key])=>key);
  if(!targets.length)fail('INVALID','此包没有 mode="auto" 的自动计算规则。');
  const model=parseAimdProtocol(protocol.content),owners=buildAimdFieldOwnership(model);
  for(const key of targets)if(!owners[key] || owners[key]==='human')fail('INVALID','自动计算字段 '+key+' 必须声明 owner="system" 或 owner="agent"。');
  const chartSchema=z.object({charts:z.array(z.object({id:z.string().regex(/^[\w-]{1,60}$/),title:z.string().min(1).max(100),table:z.string(),label:z.string(),value:z.string()}).strict()).max(6)}).strict();
  const charts=source.files['interaction.json']?chartSchema.parse(JSON.parse(source.files['interaction.json'])).charts:[];
  for(const chart of charts){const table=model.fields.var_table.find(t=>t.id===chart.table);if(!table || !table.subvars.some(c=>c.id===chart.label) || !table.subvars.some(c=>c.id===chart.value))fail('INVALID','图表引用了未定义的表格列。');}
  return {...binding,targets,charts,protocolSha256:protocol.sha256,parsedRunId:parsed.id};
}
