import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../plugins/deepscientist/index.mjs';

test('cloud skill catalog hides host paths and loads complete resources through the account files owner',async()=>{
  let provider,loaded;
  const agent={session:{id:'s'}};
  const cloud={labSkills:async scope=>{assert.equal(scope,agent);return [];},
    async materializeSkill(input,options){
      assert.equal(options.scope,agent);loaded=input;
      return {path:'/workspace/.pe/skills/version/SKILL.md',resourceBase:{kind:'directory',path:'/workspace/.pe/skills/version/'}};
    }};
  apply({get:()=>cloud,skills:{registerProvider:factory=>{provider=factory();}}});
  const options={scope:agent,signal:new AbortController().signal},catalog=await provider.list(options);
  assert.ok(catalog.length>10);
  for(const item of catalog){assert.equal(item.path,undefined);assert.ok(item.locator.startsWith('bundled:'));assert.equal(item.resourceBase.kind,'opaque');}
  const candidate=catalog.find(item=>item.name==='research-protocol'),skill=await provider.get(candidate,options);
  assert.equal(skill.resourceBase.path,'/workspace/.pe/skills/version/');
  assert.ok(loaded.files.some(file=>file.relativePath==='SKILL.md'));
  assert.ok(loaded.files.length>1);
  assert.match(Buffer.from(loaded.files.find(file=>file.relativePath==='SKILL.md').dataBase64,'base64').toString(),/research-protocol/);
});
