import test from 'node:test';
import assert from 'node:assert/strict';
import {roundHistory} from '../plugins/workbench/round-history.mjs';
test('replays a persisted failed tool and interrupted turn without leaking manual turns',()=>{
 const events=[];const session=()=>({get seq(){return events.length},eventAt:i=>events[i]});
 const add=(type,data)=>events.push({type,data,time:123,seq:events.length});
 add('turn/start',{turn:1});add('tool/call',{turn:1,name:'private'});
 add('turn/start',{turn:2});add('user/message',{source:{kind:'goal',round:1,goalId:'g'}});
 add('tool/call',{turn:2,callId:'t',name:'compute',arguments:'{"x":3}'});
 const live=session();assert.equal(roundHistory(live).rows[0].status,'进行中');
 add('tool/result',{turn:2,message:{callId:'t',isError:true,content:[{type:'text',text:'invalid x'}]}});
 add('deliverables/presented',{turn:2,callId:'t',files:[{path:'plot.png'}]});
 add('turn/end',{turn:2,reason:{kind:'interrupted'}});
 const detail=roundHistory(live,{item:'3'});assert.equal(detail.status,'已中断');assert.equal(detail.operations.length,1);
 assert.equal(detail.operations[0].result,'invalid x');assert.equal(detail.failures,1);assert.deepEqual(detail.operations[0].files,['plot.png']);
 assert.deepEqual(roundHistory(session(),{item:'3'}),detail);
});
