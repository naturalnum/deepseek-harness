/** Immutable package resources are selected by the bundled provider, never by browser paths. */
import {readFileSync,readdirSync,lstatSync,realpathSync} from 'node:fs';
import {dirname,join,relative,isAbsolute,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const packageRoot=realpathSync(join(dirname(fileURLToPath(import.meta.url)),'../..'));
const approved=[join(packageRoot,'upstream/v2-main/resources/skills'),join(packageRoot,'plugins/deepscientist/skills')];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new Error(message);};
function approvedPath(path,type){
  if(typeof path!=='string'||!approved.some(root=>path.startsWith(root+'/')))fail('科研资源不属于当前批准的插件源码。');
  const info=lstatSync(path);if(info.isSymbolicLink()||(type==='directory'?!info.isDirectory():!info.isFile()))fail('科研资源必须是无符号链接的批准源码。');
  if(realpathSync(path)!==path)fail('科研源码路径包含符号链接。');
  return path;
}
/** Opaque previews never claim that a Host source directory is readable by the account runtime. */
export function previewResearchSkill(skill){
  const {path:_path,resourceBase:_resources,...rest}=skill;
  return {...rest,locator:'bundled:'+hash(skill.provider+':'+skill.name),resourceBase:{kind:'opaque',description:'Bundled resources prepare only inside the current native research skill invocation.'}};
}
/** Materialize a complete immutable source selection while retaining all existing user edits. */
export async function materializeResearchSkill(skill,options,runtime,config,assertToolCurrent,projectPath){
  const exec=runtime.execution();
  if(!exec)return previewResearchSkill(skill);
  assertToolCurrent(exec);
  if(options?.scope!==exec.agent)fail('科研资源需要当前真实原生工具的 Agent。');
  const source=approvedPath(skill.resourceBase?.path,'directory'),instruction=approvedPath(skill.path,'file');
  const files=[];let total=0;
  function collect(directory,prefix=''){
    for(const item of readdirSync(directory,{withFileTypes:true})){
      const name=prefix+item.name,path=join(directory,item.name),info=lstatSync(path);
      if(item.isSymbolicLink()||info.isSymbolicLink())fail('科研资源树不允许符号链接。');
      if(item.isDirectory()){collect(path,name+'/');continue;}
      if(!item.isFile()||isAbsolute(name)||name.includes('\\')||name.split('/').some(x=>!x||x==='.'||x==='..')||Buffer.byteLength(name)>config.maxSkillPathBytes)fail('科研资源成员路径不可用。');
      const data=readFileSync(name==='SKILL.md'?instruction:path);
      total+=data.length;if(data.length>config.maxSkillFileBytes||total>config.maxSkillBytes||files.length>=config.maxSkillFiles)fail('科研资源超过批准的文件数或字节容量。');
      files.push({path:name,dataBase64:data.toString('base64'),sha256:hash(data)});
    }
  }
  collect(source);
  if(!files.some(x=>x.path==='SKILL.md')){const data=readFileSync(instruction);total+=data.length;files.push({path:'SKILL.md',dataBase64:data.toString('base64'),sha256:hash(data)});}
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const manifest=files.map(({path,sha256})=>({path,sha256})),sourceSha256=hash(JSON.stringify(manifest));
  const cwd=await exec.agent.ctx.get('workingDirectory').ensure(exec.agent,exec.signal),workspace=projectPath(exec);
  const within=relative(workspace,cwd);if(within==='..'||within.startsWith('../')||isAbsolute(within))fail('科研资源工作目录不属于当前项目。');
  const destination=posix.join(within,'research-resources',sourceSha256),result=[];
  let batch=[];
  const submit=async()=>{if(!batch.length)return;assertToolCurrent(exec);const observed=await runtime.resources({workspace,destination,maxFileBytes:config.maxSkillFileBytes,files:batch});
    if(!Array.isArray(observed?.files)||observed.files.length!==batch.length)fail('科研资源复制结果不完整。');
    for(let index=0;index<batch.length;index++){const row=observed.files[index];if(row.path!==batch[index].path||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>config.maxSkillFileBytes||!/^[a-f0-9]{64}$/.test(row.sha256)||typeof row.modified!=='boolean')fail('科研资源复制回执无效。');result.push(row);}batch=[];};
  for(const file of files){const candidate={workspace,destination,maxFileBytes:config.maxSkillFileBytes,files:[...batch,file]};if(Buffer.byteLength(JSON.stringify(candidate))>config.maxPayloadBytes){await submit();if(Buffer.byteLength(JSON.stringify({...candidate,files:[file]}))>config.maxPayloadBytes)fail('单个科研资源超过原生传输容量。');}batch.push(file);}
  await submit();assertToolCurrent(exec);
  const resourceBase=posix.join(workspace,destination)+'/',copySha256=hash(JSON.stringify(result));
  return {...skill,locator:previewResearchSkill(skill).locator,path:resourceBase+'SKILL.md',resourceBase:{kind:'directory',path:resourceBase},
    content:skill.content+'\n\nCloud resources: complete working copy manifest SHA-256 '+copySha256+'; approved source manifest SHA-256 '+sourceSha256+'. Existing user edits are retained.',
    cloudResources:{sourceSha256,copySha256,files:result}};
}
