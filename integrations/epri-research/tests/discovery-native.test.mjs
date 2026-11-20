import {roundHistory} from '../plugins/workbench/round-history.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '../harness-runtime/node_modules/@deepseek-ai/cordis/lib/index.js';
import {LlmAdapter,LlmRuntime} from '../harness-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import SessionStore,{SessionId} from '../harness-runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import SessionProjectionRegistry from '../harness-runtime/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js';
import SystemPrompt from '../harness-runtime/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js';
import ToolRuntime from '../harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import AgentRegistry from '../harness-runtime/node_modules/@deepseek-ai/dsh-agent/lib/index.js';
import AgentLoop from '../harness-runtime/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js';
import GoalService from '../harness-runtime/node_modules/@deepseek-ai/dsh-goal/lib/index.js';
import * as GoalRoundDriver from '../harness-runtime/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js';

class ScriptedAdapter extends LlmAdapter {
  requests=[];
  constructor(){super();}
  async *stream(options){
    this.requests.push(options);
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'block-end',index:0,block:{type:'text',text:'Synthetic research round '+this.requests.length}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}

async function waitFor(predicate,message) {
  const until=Date.now()+10000;
  while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.fail(message);
}

test('real Harness Goal driver continues multiple research rounds, stops at cap and resumes only after explicit extension',async()=>{
  const ctx=new Context();
  try {
    await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry);
    await ctx.plugin(GoalService);await ctx.plugin(GoalRoundDriver);await ctx.plugin(AgentLoop,{agents:[]});
    const adapter=new ScriptedAdapter();ctx.llm.registerAdapter(['synthetic'],adapter);
    const agent=await ctx.agentLoop.create(SessionId('synthetic-discovery-native'),{provider:'synthetic',model:'synthetic'});
    const goal=ctx.goals.create(agent,{objective:'Compare synthetic methods and verify the selected result',maxGoalRounds:2});
    await waitFor(()=>ctx.goals.get(agent)?.phase==='blocked','native Goal driver did not stop at its round cap');
    let stopped=ctx.goals.get(agent);
    assert.deepEqual({phase:stopped.phase,roundsStarted:stopped.roundsStarted,maxGoalRounds:stopped.maxGoalRounds},{phase:'blocked',roundsStarted:2,maxGoalRounds:2});
    assert.equal(stopped.blockedReason.code,'round-limit');
    const roundPrompts=agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='goal').map(event=>event.data.source.round);
    assert.deepEqual(roundPrompts,[1,2]);
    ctx.goals.edit(agent,{id:stopped.id,revision:stopped.revision},{maxGoalRounds:3});
    stopped=ctx.goals.get(agent);
    ctx.goals.resume(agent,{id:stopped.id,revision:stopped.revision});
    await waitFor(()=>ctx.goals.get(agent)?.phase==='blocked'&&ctx.goals.get(agent).roundsStarted===3,'explicitly resumed Goal did not continue');
    assert.equal(adapter.requests.length,3);
    const history=roundHistory(agent.session);
    assert.deepEqual(history.rows.map(r=>[r.round,r.status]),[[3,'已完成'],[2,'已完成'],[1,'已完成']]);
    assert.match(roundHistory(agent.session,{item:history.rows[0].id}).summary,/Synthetic research round/);
    assert.deepEqual(agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='goal').map(event=>event.data.source.round),[1,2,3]);
    assert.equal(ctx.goals.get(agent).id,goal.id);
  } finally {await ctx.fiber.dispose();}
});
