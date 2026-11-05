import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,mkdir,readFile,stat} from 'node:fs/promises';
import {isAbsolute,join,resolve,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {normalizeProjectGitDirectionDecision,normalizeResearchStrategy} from '../reused/science/researchStrategy.ts';
const localFiles={realpath,mkdir,readFile,stat};
const localPath={isAbsolute,join,resolve,relative};
const exec = promisify(execFile);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const target={worktreeId:z.string().optional()};
const write={expectedToken:z.string().min(1),requestId:z.string().min(1).max(200)};
const paths=z.array(z.string().min(1).max(1000)).min(1).max(100);
export const gitContracts = {
  project_git_bind:{description:'Human-only: associate an existing local Git repository with this conversation for read-only history viewing. Shows the repository history, including other conversations; does not create commits or change files.',shape:{path:z.string().trim().min(1).max(2000)}},
  project_git_state:{description:'Read up to 200 recent commits across branches of the repository explicitly associated by the user, including DeepScientist checkpoint metadata. Does not run Git hooks or change files.',shape:{}},
  project_git_commit:{description:'Read the message and patch of a commit reachable from the associated repository references. No checkout or rollback.',shape:{sha}},
  project_git_working:{description:'Read working changes, exact state token and managed branch workspaces. Refresh before a Git write.',shape:target},
  project_git_checkpoint:{description:'Commit only explicitly selected files. Requires preview token. Humans may commit; agents need a human-enabled policy for this managed worktree and exact file list.',shape:{...target,...write,files:paths,message:z.string().trim().min(1).max(500),stage:z.string().max(60).default('analysis'),routeNodeId:z.string().max(120).optional()}},
  project_git_branch:{description:'Human-only: create a separate Git worktree/branch at the reviewed HEAD, preserving the main working directory. Native Harness tools can execute work at the returned path.',shape:{...write,name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,45}$/)}},
  project_git_merge:{description:'Human-only: merge a reviewed managed branch into a clean main worktree. Conflicts are retained for resolution, never overwritten.',shape:{...write,worktreeId:z.string(),sourceSha:sha}},
  project_git_revert:{description:'Human-only: undo a reviewed commit with a new revert commit; keeps history. Requires a clean worktree.',shape:{...write,sha,mainline:z.number().int().min(1).max(8).optional()}},
  project_git_policy:{description:'Human-only: enable/disable automatic checkpoints for exact files in an existing managed worktree. Triggers when saved research stages finish.',shape:{enabled:z.boolean(),worktreeId:z.string(),files:paths}},
};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
async function localGit(path,args,signal,allowMissing=false) {
  try {
    return (await exec('git',['--no-pager','-c','core.quotepath=false','-c','core.fsmonitor=false','-C',path,...args],{
      windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024,signal,
      env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat'},
    })).stdout;
  } catch(error) {
    if(error.name==='AbortError')throw error;
    if(allowMissing && error.code===1)return '';
    if(error.code==='ENOENT')fail('UNAVAILABLE','本机尚未安装 Git，暂时无法读取版本历史。');
    if(args.includes('commit'))fail('CONFLICT','Git 提交未完成，所选文件可能仍在暂存区。请检查仓库状态和本机 Git 日志后重试；没有清理或丢弃文件。');
    if(args.includes('merge')||args.includes('revert'))fail('CONFLICT','Git 合并或撤销未完成，可能存在冲突。工作区已保留，请用 Git 查看状态并完成或取消当前操作，再刷新本页。');
    fail('INVALID','无法读取 Git 仓库：请确认目录存在、可访问，且提交内容未超过 8 MiB。');
  }
}
export function parseGitHistory(text) {
  const fields=text.split('\0'), commits=[];
  for(let i=0;i+6<fields.length;i+=7) {
    const [id,parents,authorName,authoredAt,refs,subject,bodyPreview]=fields.slice(i,i+7);
    if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))continue;
    const trailer=name=>bodyPreview.match(new RegExp('^DeepScientist-'+name+': (.*)$','m'))?.[1]?.trim();
    const json=name=>{try{return JSON.parse(trailer(name));}catch{return undefined;}};
    const researchStrategy=normalizeResearchStrategy(trailer('Strategy'));
    const receipt=json('ResearchStage');
    const disposition=['supported','refuted','exhausted','inconclusive','runtime_failed'].includes(receipt?.disposition)?receipt.disposition:undefined;
    commits.push({sha:id,shortSha:id.slice(0,8),parents:parents.split(' ').filter(Boolean),authorName,authoredAt,
      refs:refs.split(', ').filter(Boolean),subject,bodyPreview,researchStrategy,
      checkpoint:trailer('Checkpoint')==='true'?{
        stage:trailer('Stage'),researchStrategy,routeNodeId:trailer('RouteNode'),
        verification:[...bodyPreview.matchAll(/^DeepScientist-Verification: (.*)$/gm)].map(m=>m[1]),
        directionDecision:normalizeProjectGitDirectionDecision(json('Decision')),
        researchStage:receipt?{stageId:typeof receipt.stageId==='string'?receipt.stageId:undefined,disposition}:undefined,
      }:undefined});
  }
  return commits;
}
export function projectGitStore(db,directory,io) {
  const git=io?.git || localGit;
  const {realpath,mkdir,readFile,stat}=io || localFiles;
  const {resolve,relative,isAbsolute,join}=io?.path || localPath;
  db.exec('CREATE TABLE IF NOT EXISTS research_git_bindings(session TEXT PRIMARY KEY, path TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS research_git_worktrees(session TEXT NOT NULL,id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS research_git_policies(session TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS research_git_requests(session TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,id))');
  db.exec('CREATE TABLE IF NOT EXISTS research_git_auto(session TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(session,id,revision))');
  const locks=new Set(),digest=value=>createHash('sha256').update(value).digest('hex');
  const binding=session=>db.prepare('SELECT path,updatedAt FROM research_git_bindings WHERE session=?').get(session);
  const worktrees=session=>db.prepare('SELECT body FROM research_git_worktrees WHERE session=?').all(session).map(r=>JSON.parse(r.body));
  const policy=session=>{const row=db.prepare('SELECT body FROM research_git_policies WHERE session=?').get(session);return row?JSON.parse(row.body):{enabled:false};};
  async function working(path,signal){
    const head=(await git(path,['rev-parse','--verify','--quiet','HEAD'],signal,true)).trim();
    const raw=await git(path,['status','--porcelain=v1','-z','--untracked-files=all'],signal),parts=raw.split('\0'),changes=[];
    for(let i=0;i<parts.length;i++){if(!parts[i])continue;const code=parts[i].slice(0,2),name=parts[i].slice(3);changes.push({path:name,code});if(code.includes('R')||code.includes('C'))i++;}
    const content=[];
    for(const c of changes){let fingerprint='deleted';try{const p=resolve(path,c.path),size=(await stat(p)).size;if(size>16*1024*1024)fail('LIMIT','单个变更文件超过 16 MiB，请用原生 Git 管理。');fingerprint=digest(await readFile(p));}catch(e){if(e.code!=='ENOENT')throw e;}content.push([c.path,c.code,fingerprint]);}
    const diff=head?await git(path,['diff','--binary','--no-ext-diff','--no-textconv',head,'--'],signal):'';
    return {path,head,changes,token:digest(JSON.stringify({head,raw,diff,content})),branch:(await git(path,['branch','--show-current'],signal)).trim()};
  }
  function selectedPaths(root,files){return [...new Set(files)].map(name=>{const p=relative(root,resolve(root,name));if(!p||isAbsolute(name)||p==='..'||p.startsWith('..\\')||p.startsWith('../')||p.split(/[\\/]/).includes('.git'))fail('INVALID','只选择仓库内的具体文件。');return p.replaceAll('\\','/');});}
  async function history(path,signal) {
    const head=(await git(path,['rev-parse','--verify','--quiet','HEAD'],signal,true)).trim();
    if(!head)return [];
    return parseGitHistory(await git(path,['log','--all',head,'--topo-order','-201','-z','--format=%H%x00%P%x00%an%x00%aI%x00%D%x00%s%x00%b'],signal));
  }
  const store={async execute(op,args,actor,signal,session) {
    if(!session)fail('INVALID','请从科研对话进入，再关联项目仓库。');
    const a=z.object(gitContracts[op].shape).strict().parse(args);
    if(op==='project_git_bind') {
      if(actor!=='human')fail('FORBIDDEN','项目仓库需要用户在工作台中确认关联。');
      if(!isAbsolute(a.path))fail('INVALID','请输入本机项目仓库的完整路径。');
      const path=await realpath(a.path).catch(()=>fail('NOT_FOUND','找不到这个项目目录。'));
      const root=await realpath((await git(path,['rev-parse','--show-toplevel'],signal)).trim());
      if(root.toLowerCase()!==path.toLowerCase())fail('INVALID','请填写 Git 仓库根目录：'+root);
      await history(root,signal);
      db.prepare('INSERT INTO research_git_bindings VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET path=excluded.path,updatedAt=excluded.updatedAt').run(session,root,new Date().toISOString());
    }
    const bound=binding(session);
    if(!bound)return {bound:false,commits:[]};
    // The association remains valid only while this directory is the same repository root.
    const root=await realpath((await git(bound.path,['rev-parse','--show-toplevel'],signal)).trim());
    if(root!==bound.path)fail('CONFLICT','项目目录已变化，请重新确认关联。');
    const managed=worktrees(session).filter(w=>w.repository===root),permissions=policy(session);
    const targetTree=a.worktreeId?managed.find(w=>w.id===a.worktreeId):null;
    if(a.worktreeId&&!targetTree)fail('NOT_FOUND','本对话未创建这个分支工作区。');
    const path=targetTree?.path || root;
    if(op==='project_git_working')return {...await working(path,signal),worktrees:managed,policy:permissions};
    if(op==='project_git_policy'){
      if(actor!=='human')fail('FORBIDDEN','自动检查点由用户开启。');
      if(!targetTree)fail('INVALID','自动检查点只支持当前对话创建的独立工作目录。');
      const next={...a,files:selectedPaths(path,a.files),repository:root,updatedAt:new Date().toISOString()};
      db.prepare('INSERT INTO research_git_policies VALUES(?,?) ON CONFLICT(session) DO UPDATE SET body=excluded.body').run(session,JSON.stringify(next));return next;
    }
    if(['project_git_checkpoint','project_git_branch','project_git_merge','project_git_revert'].includes(op)){
      const signature=digest(JSON.stringify({op,args,actor})),old=db.prepare('SELECT body FROM research_git_requests WHERE session=? AND id=?').get(session,a.requestId);
      if(old){const saved=JSON.parse(old.body);if(saved.signature!==signature)fail('CONFLICT','重试标识对应其他 Git 操作。');return saved.result;}
      if(actor!=='human'&&(op!=='project_git_checkpoint'||!permissions.enabled||permissions.repository!==root||permissions.worktreeId!==a.worktreeId||!selectedPaths(path,a.files).every(file=>permissions.files.includes(file))))fail('FORBIDDEN','该 Git 操作需要用户确认或明确配置的自动检查点策略。');
      if(locks.has(root))fail('BUSY','这个仓库正在进行另一项工作台 Git 操作。');locks.add(root);
      try{
        const destination=op==='project_git_merge'?root:path,current=await working(destination,signal);
        if(current.token!==a.expectedToken)fail('CONFLICT','仓库或文件已变化，请刷新并重新检查所选内容。');
        if(!current.head||!current.branch)fail('INVALID','写操作需要已有提交且位于命名分支。');
        let result;
        if(op==='project_git_branch'){
          const id=randomUUID(),branch='research/'+digest(session).slice(0,10)+'/'+a.name;
          const parent=io ? await io.worktreeDirectory(session,signal) : resolve(directory,'git-worktrees');await mkdir(parent,{recursive:true});const treePath=join(parent,id);
          await git(root,['worktree','add','-b',branch,treePath,current.head],signal);
          result={id,path:treePath,branch,baseSha:current.head,repository:root,createdAt:new Date().toISOString()};
          db.prepare('INSERT INTO research_git_worktrees VALUES(?,?,?)').run(session,id,JSON.stringify(result));
        }else if(op==='project_git_checkpoint'){
          const files=selectedPaths(path,a.files);
          if(current.changes.some(c=>c.code[0]!==' '&&c.code[0]!=='?'))fail('CONFLICT','暂存区已有改动，请先处理，避免混入其他人的工作。');
          if(!files.every(p=>current.changes.some(c=>c.path===p)))fail('INVALID','所选文件必须属于当前变更列表。');
          if(current.changes.some(c=>files.includes(c.path)&&/[RCU]/.test(c.code)))fail('CONFLICT','重命名或冲突文件请先用原生 Git 处理。');
          await git(path,['--literal-pathspecs','add','--',...files],signal);
          const message='['+a.stage+'] '+a.message+'\n\nDeepScientist-Checkpoint: true\nDeepScientist-Stage: '+a.stage.replace(/[\r\n]/g,' ')+(a.routeNodeId?'\nDeepScientist-RouteNode: '+a.routeNodeId.replace(/[\r\n]/g,' '):'');
          await git(path,['-c','user.name=DeepScientist Local','-c','user.email=research@localhost','--literal-pathspecs','commit','--only','-m',message,'--',...files],signal);
          result={sha:(await git(path,['rev-parse','HEAD'],signal)).trim(),files,path};
        }else{
          if(current.changes.length)fail('CONFLICT','请先保存或提交当前工作目录中的改动。');
          if(op==='project_git_merge'){
            const source=await working(targetTree.path,signal);if(source.head!==a.sourceSha||source.changes.length)fail('CONFLICT','分支内容已变化或有未提交修改，请先检查分支。');
            await git(root,['-c','user.name=DeepScientist Local','-c','user.email=research@localhost','merge','--no-ff','-m','[decision] Merge '+targetTree.branch,targetTree.branch],signal);
          }else await git(root,['-c','user.name=DeepScientist Local','-c','user.email=research@localhost','revert','--no-edit',...(a.mainline?['-m',String(a.mainline)]:[]),a.sha],signal);
          result={sha:(await git(root,['rev-parse','HEAD'],signal)).trim(),path:root};
        }
        db.prepare('INSERT INTO research_git_requests VALUES(?,?,?)').run(session,a.requestId,JSON.stringify({signature,result}));return result;
      }finally{locks.delete(root);}
    }
    if(op==='project_git_commit') {
      const reachable=await git(root,['for-each-ref','--contains='+a.sha,'--format=%(refname)'],signal);
      if(!reachable.trim() && (await git(root,['merge-base',a.sha,'HEAD'],signal,true)).trim()!==a.sha)fail('NOT_FOUND','该提交不在当前仓库的分支、标签或 HEAD 历史中。');
      const message=await git(root,['show','-s','--format=%B',a.sha,'--'],signal);
      const patch=await git(root,['show','--format=','--stat','--patch','--no-ext-diff','--no-textconv','--no-color',a.sha,'--'],signal);
      return {sha:a.sha,message,patch};
    }
    const commits=await history(root,signal);
    const branch=(await git(root,['branch','--show-current'],signal)).trim();
    const dirty=Boolean((await git(root,['status','--porcelain','--untracked-files=normal'],signal)).trim());
    return {bound:true,path:root,branch,dirty,commits:commits.slice(0,200),truncated:commits.length>200,scope:'repository',updatedAt:bound.updatedAt};
  },async autoCheckpoint(item,previous,signal,session){
    const cached=db.prepare('SELECT body FROM research_git_auto WHERE session=? AND id=? AND revision=?').get(session,item.id,item.revision);if(cached)return JSON.parse(cached.body);
    const p=policy(session);if(!p.enabled)return null;
    const finished=item.data.route.nodes.filter(n=>['completed','verified'].includes(n.lifecycle)&&!['completed','verified'].includes(previous?.data.route.nodes.find(x=>x.id===n.id)?.lifecycle));if(!finished.length)return null;
    let result;
    try{const state=await store.execute('project_git_working',{worktreeId:p.worktreeId},'agent',signal,session);
      result=state.changes.some(c=>p.files.includes(c.path))?await store.execute('project_git_checkpoint',{worktreeId:p.worktreeId,expectedToken:state.token,requestId:'route:'+item.id+':'+item.revision,files:p.files.filter(p=>state.changes.some(c=>c.path===p)),message:finished.map(n=>n.title).join(' / ').slice(0,500),stage:'analysis',routeNodeId:finished.at(-1).id},'agent',signal,session):{status:'no-changes'};
    }catch(e){result={status:'not-created',reason:e.message};}
    db.prepare('INSERT OR IGNORE INTO research_git_auto VALUES(?,?,?,?)').run(session,item.id,item.revision,JSON.stringify(result));return result;
  }};return store;
}
