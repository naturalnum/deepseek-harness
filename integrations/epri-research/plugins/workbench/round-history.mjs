// Index the durable host journal incrementally. Dropping the cache only causes replay.
const indexes = new WeakMap();
const labels = { completed:'已完成', error:'失败', blocked:'受阻', aborted:'已中断', interrupted:'已中断', forked:'已中断', 'max-tokens':'达到输出上限' };
function blockText(content) {
  return Array.isArray(content) ? content.filter(b=>b?.type==='text').map(b=>b.text).join('\n') : '';
}
function consume(state,event) {
  const {type,data:d}=event;
  if(type==='turn/start') { state.turn=d.turn; state.active=null; return; }
  if(type==='user/message' && d.source?.kind==='goal' && d.source.round>0 && !state.active) {
    const row={id:String(event.seq), goalId:d.source.goalId, round:d.source.round, time:event.time, status:'进行中', summary:'', operations:[], calls:new Map()};
    state.active=row; state.rows.push(row); state.byId.set(row.id,row); return;
  }
  const row=state.active;
  if(!row || (d.turn!==undefined && d.turn!==state.turn)) return;
  if(type==='turn/end') {
    row.status=labels[d.reason?.kind] || '已结束';
    if(d.reason?.error?.message) row.summary=d.reason.error.message;
    for(const op of row.operations) if(op.status==='执行中') op.status='未取得结果';
    state.active=null;
  } else if(type==='deliverables/presented') {
    const op=row.calls.get(d.callId);
    if(op)op.files=d.files.map(file=>file.path);
  } else if(type==='assistant/message') {
    const summary=blockText(d.message?.content);
    if(summary)row.summary=summary;
  } else if(type==='tool/call' || type==='tool/ptc-dispatch-start') {
    const op={name:d.name,args:d.arguments,status:'执行中',result:''};
    row.operations.push(op);row.calls.set(d.subCallId??d.callId,op);
  } else if(type==='tool/result' || type==='tool/ptc-dispatch') {
    const result=d.message??d, op=row.calls.get(d.subCallId??result.callId);
    if(op) {op.status=result.isError?'失败':'已完成';op.result=blockText(result.content)||d.error?.reason||'';}
  }
}
export function roundHistory(session,{item,before}={}) {
  let state=indexes.get(session);
  if(!state){state={offset:session.inheritedEventCount||0,rows:[],byId:new Map()};indexes.set(session,state);}
  while(state.offset<session.seq){consume(state,session.eventAt(state.offset));state.offset++;}
  const brief=r=>({id:r.id,round:r.round,goalId:r.goalId,time:r.time,status:r.status,summary:r.summary.slice(0,240),count:r.operations.length,failures:r.operations.filter(op=>op.status==='失败').length});
  if(item!==undefined){
    const r=state.byId.get(item);
    if(!r)throw Object.assign(new Error('本对话中找不到这一轮。'),{status:404});
    return {...brief(r),summary:r.summary,operations:r.operations};
  }
  const end=before===undefined?state.rows.length:state.rows.findIndex(r=>r.id===before);
  if(end<0)throw Object.assign(new Error('轮次位置无效。'),{status:400});
  const start=Math.max(0,end-25);
  return {rows:state.rows.slice(start,end).reverse().map(brief),more:start>0};
}
