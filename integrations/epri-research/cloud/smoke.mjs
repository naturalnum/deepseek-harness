// Local Linux executor acceptance. This is not an OpenSandbox/authentication deployment test.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openCloudStore} from '../dist/server/cloud-store.mjs';

const image=process.argv[2];
if(!image||!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Pass the immutable local Docker image ID.');
const exec=promisify(execFile),home=mkdtempSync(join(tmpdir(),'epri-linux-')),workspace=join(home,'workspace');
mkdirSync(workspace);
const lifetime=new AbortController();
async function command(argv,input='',signal=lifetime.signal,timeout=120000) {
  const name='epri-check-'+randomUUID();
  const args=['run','--rm','--pull','never','--name',name,'--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--pids-limit','128','--memory','512m','--cpus','1','--user','1000:1000',
    '--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--mount','type=bind,source='+workspace+',target=/workspace',
    '-w','/workspace','-i','--entrypoint',argv[0],image,...argv.slice(1)];
  try {
    const result=exec('docker',args,{windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,signal,timeout});
    result.child.stdin.end(input);
    const output=await result;
    return {exitCode:0,stdout:output.stdout,stderr:output.stderr};
  } finally {
    // Observe container removal even when cancellation only terminates the Docker client.
    await exec('docker',['rm','-f',name],{windowsHide:true,timeout:10000}).catch(error=>{
      if(!String(error.stderr).includes('No such container'))throw error;
    });
  }
}
const python='/opt/epri-python/bin/python3';
const py=(source,value)=>command([python,'-I','-X','utf8','-c',source],JSON.stringify(value));
const store=openCloudStore({directory:join(home,'data'),lifetime:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();},python,
  authorizeSession:async id=>{
    assert.equal(id,'linux');
    return {check(){lifetime.signal.throwIfAborted();},workspaceRoot:'/workspace',run:command,
      readBytes:async path=>Buffer.from((await py('import pathlib,base64,json,sys; print(base64.b64encode(pathlib.Path(json.load(sys.stdin)).read_bytes()).decode())',path)).stdout.trim(),'base64'),
      stat:async path=>({size:Number((await py('import pathlib,json,sys; print(pathlib.Path(json.load(sys.stdin)).stat().st_size)',path)).stdout)})};
  }});
const call=(op,args={},actor='human')=>store.execute(op,args,actor,'linux');
async function run(action,params={}) {
  const started=await call('engine_run',{packageId:'calibration',version:'1',action,params,requestId:randomUUID()});
  const deadline=Date.now()+120000;
  while(Date.now()<deadline) {
    const state=await call('engine_run_get',{id:started.id});
    if(state.status!=='running'){assert.equal(state.status,'succeeded',JSON.stringify(state));return state.result;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Linux execution did not settle.');
}
function pdf() {
  const stream='BT /F1 36 Tf 45 110 Td (RESEARCH CLOUD 12345) Tj ET';
  const bodies=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let result='%PDF-1.4\n',offsets=[0];
  bodies.forEach((body,index)=>{offsets.push(Buffer.byteLength(result));result+=(index+1)+' 0 obj\n'+body+'\nendobj\n';});
  const xref=Buffer.byteLength(result);
  result+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(result+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
}
try {
  assert.equal((await call('engine_status')).ready,true);
  assert.equal((await call('document_status')).available,true);
  const directory=new URL('../examples/power-methods/calibration/',import.meta.url),files={};
  for(const name of readdirSync(directory))files[name]=readFileSync(new URL(name,directory),'utf8');
  const pkg=await call('engine_package_put',{id:'calibration',version:'1',title:'Linux smoke',kind:'protocol',files,requestId:randomUUID()});
  await assert.rejects(call('engine_run',{packageId:'calibration',version:'1',action:'parse_protocol',params:{},requestId:randomUUID()}),/批准/);
  await call('engine_package_review',{id:pkg.id,version:pkg.version,sha256:pkg.sha256,approved:true,reason:'Synthetic fixture source reviewed'});
  const parsed=await run('parse_protocol');assert.equal(parsed.success,true);
  const calculated=await run('recalculate',{values:{max_residual:0.1},tables:{points:[
    {point:'1',reference:1,measured:3},{point:'2',reference:2,measured:5},{point:'3',reference:3,measured:7}]}});
  assert.match(JSON.stringify(calculated),/"slope":2/);
  const input=pdf();
  const file=await call('attachment_put',{name:'text.pdf',contentBase64:input.toString('base64'),requestId:randomUUID()});
  const extracted=await call('document_extract',{reference:file.reference,language:'eng'});
  assert.match(JSON.stringify(extracted),/RESEARCH CLOUD 12345/);
  const png=await py('import base64,json,pathlib,sys,tempfile,subprocess\nwith tempfile.TemporaryDirectory() as d:\n p=pathlib.Path(d)/"source.pdf"; p.write_bytes(base64.b64decode(json.load(sys.stdin))); target=str(pathlib.Path(d)/"scan")\n subprocess.run(["pdftoppm","-r","160","-singlefile","-png",str(p),target],check=True,stdout=subprocess.DEVNULL)\n print(base64.b64encode(pathlib.Path(target+".png").read_bytes()).decode())',input.toString('base64'));
  const scan=await call('attachment_put',{name:'scan.png',contentBase64:png.stdout.trim(),requestId:randomUUID()});
  assert.match(JSON.stringify(await call('document_extract',{reference:scan.reference,language:'eng'})),/RESEARCH CLOUD 12345/);
  await py('import pathlib,subprocess\np=pathlib.Path("/workspace/repo");p.mkdir()\nfor args in [["init"],["config","user.name","Research test"],["config","user.email","research@example.invalid"]]: subprocess.run(["git","-C",str(p),*args],check=True,stdout=subprocess.DEVNULL)\n(p/"data.txt").write_text("synthetic data")\nfor args in [["add","data.txt"],["commit","-m","Synthetic input"]]: subprocess.run(["git","-C",str(p),*args],check=True,stdout=subprocess.DEVNULL)',null);
  await call('project_git_bind',{path:'/workspace/repo'});
  assert.match(JSON.stringify(await call('project_git_state')),/Synthetic input/);
  await assert.rejects(call('project_git_bind',{path:'/etc'}),{code:'NOT_FOUND'});
  console.log(JSON.stringify({passed:['approved Airalogy protocol parsing','Airalogy linear calibration slope=2','PDF text extraction','scanned-image OCR','Session Git history','outside-project denial'],image},null,2));
} finally {await store.close();rmSync(home,{recursive:true,force:true});}
