import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {openStore} from '../dist/server/service.mjs';

test('upstream graph retains fork/merge edges and collapses only linear commit ancestry',async()=>{
  const result=await build({entryPoints:['src/reused/science/researchProgressGraph.ts'],bundle:true,platform:'node',format:'esm',write:false});
  const {layoutResearchProgressGraph,collapseLinearResearchCommits}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
  const nodes=[{id:'start'},{id:'a',parentId:'start'},{id:'b',parentId:'start'},{id:'merge',parentIds:['a','b']}];
  const graph=layoutResearchProgressGraph(nodes);
  assert.equal(graph.edges.length,4);
  assert.equal(graph.nodes.find(n=>n.id==='merge').depth,2);
  assert.notEqual(graph.nodes.find(n=>n.id==='a').y,graph.nodes.find(n=>n.id==='b').y);
  const commits=[{sha:'merge',parents:['a','b']},{sha:'b',parents:['start']},{sha:'a',parents:['extra']},{sha:'extra',parents:['start']},{sha:'start',parents:[]}].map(c=>({...c,subject:'work',refs:[]}));
  const groups=collapseLinearResearchCommits(commits,{maxBoundaries:2}).groups;
  assert.ok(groups.some(g=>g.boundary.sha==='merge'));
  assert.equal(groups.flatMap(g=>g.commits).length,5);
  assert.equal(groups.find(g=>g.commits.some(c=>c.sha==='extra')).commits.some(c=>c.sha==='b'),false);
});

test('Git progress reads actual branches, checkpoint basis, patches and persisted conversation association',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'research-graph-')),repository=join(directory,'project');
  execFileSync('git',['init','-b','main',repository],{stdio:'ignore',windowsHide:true});
  const git=(...args)=>execFileSync('git',['-C',repository,'-c','core.autocrlf=false','-c','user.name=Graph test','-c','user.email=graph@example.invalid',...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  let store=openStore(join(directory,'store'));
  const call=(op,args={},session='graph-test')=>store.execute(op,args,'human',undefined,session);
  try {
    assert.equal((await call('project_git_state')).bound,false);
    assert.equal((await call('project_git_bind',{path:repository})).commits.length,0);
    writeFileSync(join(repository,'input.txt'),'isolated synthetic engineering test\n');git('add','input.txt');git('commit','-m','[project] initialize managed project');
    git('checkout','-b','comparison');writeFileSync(join(repository,'comparison.txt'),'synthetic comparison\n');git('add','comparison.txt');git('commit','-m','[experiment] compare engineering methods');
    git('checkout','main');writeFileSync(join(repository,'analysis.txt'),'synthetic analysis\n');git('add','analysis.txt');
    const decision={schema:'deepscientist.direction.v1',choice:'advance',reason:'Isolated UI test only',basisRefs:[{kind:'artifact',ref:'analysis.txt',label:'synthetic file'}]};
    git('commit','-m','[analysis] inspect results','-m','DeepScientist-Checkpoint: true\nDeepScientist-Stage: analysis\nDeepScientist-Decision: '+JSON.stringify(decision)+'\nDeepScientist-Verification: fixture checked');
    git('merge','--no-ff','comparison','-m','[decision] merge comparison results');
    const state=await call('project_git_bind',{path:repository});
    assert.equal(state.commits.length,4);
    assert.equal(state.branch,'main');
    assert.equal(state.commits[0].parents.length,2);
    const checkpoint=state.commits.find(c=>c.checkpoint);
    assert.equal(checkpoint.checkpoint.directionDecision.basisRefs[0].label,'synthetic file');
    assert.equal(checkpoint.checkpoint.verification[0],'fixture checked');
    const detail=await call('project_git_commit',{sha:checkpoint.sha});assert.match(detail.patch,/synthetic analysis/);
    assert.equal((await call('project_git_state',{},'another-conversation')).bound,false);
    assert.equal(git('status','--porcelain').trim(),'');
    store.close();store=openStore(join(directory,'store'));
    assert.equal((await call('project_git_state')).commits[0].sha,state.commits[0].sha);
    git('checkout','--detach');writeFileSync(join(repository,'detached.txt'),'detached engineering fixture\n');
    assert.equal((await call('project_git_state')).dirty,true);
    git('add','detached.txt');git('commit','-m','[analysis] detached checkpoint');
    const detached=await call('project_git_state');assert.equal(detached.branch,'');assert.equal(detached.commits.length,5);
    assert.match((await call('project_git_commit',{sha:detached.commits[0].sha})).patch,/detached engineering fixture/);
  } finally {store.close();rmSync(directory,{recursive:true,force:true,maxRetries:5});}
});
